import type { SearchSourceType } from "../search-index.js";

/**
 * Single source of truth for search visibility/filter policy, shared by the SQL
 * (pushed-down WHERE clause) and JS (in-memory predicate) paths.
 *
 * The hybrid search runs two filters over the same candidate rows:
 *  - SQL: FTS and sqlite-vec queries push visibility, source and exclusion conditions
 *    into the WHERE clause so the database only ranks eligible rows.
 *  - JS: adjacent-context expansion and any post-fetch checks re-apply the same policy
 *    in memory so an excluded document/session/source cannot leak back in via context.
 *
 * Historically these two lived as parallel hand-written predicates (searchSqlFilters and
 * passesSearchFilters). Any drift between them is a security bug: a row the SQL layer
 * would exclude could reappear through the JS context path, or vice versa. This module
 * derives BOTH from one declarative FilterPlan so they cannot diverge silently.
 */

export interface FilterPlanVisibility {
  isOwner: boolean;
  userId?: string;
  channelId?: string;
}

export interface FilterPlanInput {
  visibility: FilterPlanVisibility;
  sourceTypes?: SearchSourceType[];
  excludeSourceTypes?: SearchSourceType[];
  excludeSourceIds?: string[];
  excludeSessionIds?: string[];
  excludeDocumentIds?: string[];
  excludeRecentDays?: number;
  /** Session-profile restriction: only these source types are eligible. */
  profileSessionTypes?: ReadonlySet<SearchSourceType>;
  restrictToProfileSession?: boolean;
}

export interface FilterPlan {
  /** Visibility scopes a non-owner may see; undefined means owner (all scopes). */
  allowedScopes?: string[];
  /** Allowed source types after profile + explicit narrowing; undefined means all. */
  allowedSourceTypes?: SearchSourceType[];
  excludeSourceTypes: Set<SearchSourceType>;
  excludeSourceIds: Set<string>;
  excludeSessionIds: Set<string>;
  excludeDocumentIds: Set<string>;
  /** Diary-file cutoff (YYYY-MM-DD); daily files on/after this date are excluded. */
  recentDateCutoff?: string;
}

function dateFileCutoff(excludeRecentDays?: number): string | undefined {
  if (!excludeRecentDays || excludeRecentDays <= 0) return undefined;
  const date = new Date();
  date.setDate(date.getDate() - excludeRecentDays);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Compile a declarative plan once; both SQL and JS layers consume it. */
export function buildFilterPlan(input: FilterPlanInput): FilterPlan {
  let allowedScopes: string[] | undefined;
  if (!input.visibility.isOwner) {
    allowedScopes = ["public"];
    if (input.visibility.channelId) allowedScopes.push(`channel:${input.visibility.channelId}`);
    if (input.visibility.userId) allowedScopes.push(`user:${input.visibility.userId}`);
  }

  let allowedSourceTypes = input.sourceTypes ? [...input.sourceTypes] : undefined;
  if (input.restrictToProfileSession && input.profileSessionTypes) {
    const base = allowedSourceTypes ?? [...input.profileSessionTypes];
    allowedSourceTypes = base.filter(sourceType => input.profileSessionTypes!.has(sourceType));
  }

  return {
    allowedScopes,
    allowedSourceTypes,
    excludeSourceTypes: new Set(input.excludeSourceTypes ?? []),
    excludeSourceIds: new Set(input.excludeSourceIds ?? []),
    excludeSessionIds: new Set(input.excludeSessionIds ?? []),
    excludeDocumentIds: new Set(input.excludeDocumentIds ?? []),
    recentDateCutoff: dateFileCutoff(input.excludeRecentDays),
  };
}

/** A row as seen by the JS predicate. Field names mirror the search_documents columns. */
export interface FilterableRow {
  id: string;
  source_type: SearchSourceType;
  source_id: string;
  session_id: string | null;
  visibility_scope: string;
}

const DAILY_FILE = /^\d{4}-\d{2}-\d{2}\.md$/;

/** JS predicate derived from the plan — must mirror the SQL clause exactly. */
export function rowPassesPlan(row: FilterableRow, plan: FilterPlan): boolean {
  if (plan.allowedScopes && !plan.allowedScopes.includes(row.visibility_scope)) return false;
  if (plan.allowedSourceTypes && !plan.allowedSourceTypes.includes(row.source_type)) return false;
  if (plan.excludeSourceTypes.has(row.source_type)) return false;
  if (plan.excludeSourceIds.has(row.source_id)) return false;
  if (row.session_id && plan.excludeSessionIds.has(row.session_id)) return false;
  if (plan.excludeDocumentIds.has(row.id)) return false;
  if (plan.recentDateCutoff && DAILY_FILE.test(row.source_id) && row.source_id.slice(0, 10) >= plan.recentDateCutoff) {
    return false;
  }
  return true;
}

/** SQL WHERE fragment (leading " AND ...") + bound params derived from the same plan. */
export function planToSqlFilters(plan: FilterPlan, alias = "d"): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const column = (name: string) => `${alias}.${name}`;
  const placeholders = (values: unknown[]) => values.map(() => "?").join(", ");

  if (plan.allowedScopes) {
    clauses.push(`${column("visibility_scope")} IN (${placeholders(plan.allowedScopes)})`);
    params.push(...plan.allowedScopes);
  }
  if (plan.allowedSourceTypes) {
    if (plan.allowedSourceTypes.length === 0) clauses.push("0 = 1");
    else {
      clauses.push(`${column("source_type")} IN (${placeholders(plan.allowedSourceTypes)})`);
      params.push(...plan.allowedSourceTypes);
    }
  }
  if (plan.excludeSourceTypes.size > 0) {
    const values = [...plan.excludeSourceTypes];
    clauses.push(`${column("source_type")} NOT IN (${placeholders(values)})`);
    params.push(...values);
  }
  if (plan.excludeSourceIds.size > 0) {
    const values = [...plan.excludeSourceIds];
    clauses.push(`${column("source_id")} NOT IN (${placeholders(values)})`);
    params.push(...values);
  }
  if (plan.excludeSessionIds.size > 0) {
    const values = [...plan.excludeSessionIds];
    clauses.push(`(${column("session_id")} IS NULL OR ${column("session_id")} NOT IN (${placeholders(values)}))`);
    params.push(...values);
  }
  if (plan.excludeDocumentIds.size > 0) {
    const values = [...plan.excludeDocumentIds];
    clauses.push(`${column("id")} NOT IN (${placeholders(values)})`);
    params.push(...values);
  }
  if (plan.recentDateCutoff) {
    clauses.push(`NOT (${column("source_id")} GLOB '????-??-??.md' AND substr(${column("source_id")}, 1, 10) >= ?)`);
    params.push(plan.recentDateCutoff);
  }
  return { sql: clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : "", params };
}
