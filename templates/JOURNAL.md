## Memory Hook

Check this turn for anything worth saving. If any of the following occurred, you MUST save — do not skip:

**memory_save** (append to daily memory) — save if:
- User mentioned a new preference, rule, person, or schedule
- User corrected your behavior or gave feedback
- A notable event, decision, or conversation happened
- Someone shared useful info (links, tips, techniques)

Atomic fact constraint: every fact you save must be **self-contained**.
- Replace all pronouns (he/she/they/it) with the specific entity name.
- Convert relative dates (today, tomorrow, next week) to absolute dates (YYYY-MM-DD).
- Include enough context that the fact is meaningful in isolation.
  Bad: "He went to the doctor." → Good: "John visited Dr. Smith on 2026-04-21."

**memory_add / memory_replace / memory_remove** (update MEMORY.md) — use if:
- User stated a long-term fact (preference, relationship, rule, resource) → `memory_add`
- An existing fact in MEMORY.md became stale or wrong → `memory_replace`
- A fact is no longer relevant → `memory_remove`
- MEMORY.md has a character limit. If full, consolidate entries with `memory_replace` or `memory_remove` before adding.

Skip: greetings, trivial exchanges, things already recorded today. Do not mention this hook in your reply.

## Session Summarize

This session is about to be archived. Save any important context before it's gone.

Use the appropriate tools:
- `memory_save` — notable events, decisions, conversations worth recalling
- `memory_add` — new long-term facts (preferences, rules, relationships)
- `memory_replace` — update stale facts in MEMORY.md
- `memory_remove` — clean up outdated entries

Atomic fact constraint: no pronouns, absolute dates, self-contained sentences.

Do NOT read files. Do NOT produce text output. Do NOT repeat information already saved earlier in the session. Skip if nothing new worth saving.

## Daily Journal

Write the daily journal for {{DATE}}.

### Step 1 — Rewrite diary

1. Read workspace/memory/{{DATE}}.md with read_file.
2. Rewrite the ENTIRE file as a clean personal diary:
   - Organize by **Category/Milestone** (e.g., development, community, personal reflections)
   - Use **Status Check** friendly format: bullet points, clear headings
   - Focus on what the user did, talked about, cared about, how they felt
   - Include interesting conversations and community events
   - Remove: raw timestamps like `[HH:MM:SS]`, duplicate summaries, operational logs, repeated recaps
   - The final file must have NO leftover `[HH:MM:SS]` entries or session summary blocks appended at the bottom
3. Overwrite workspace/memory/{{DATE}}.md with write_file.

### Step 2 — Semantic enhancement & MEMORY.md update

4. Scan the past 3 days of daily memory (read_file each). Extract and classify:

   **Atomic facts** — every fact must be self-contained:
   - Replace all pronouns with specific entity names.
   - Convert relative dates to YYYY-MM-DD (based on the diary date).
   - Include full context: "set up the database" → "Set up PostgreSQL via Supabase for the Honcho project".
   - Categories: preferences, rules, relationships, schedule, setup/resources.

   **Reasoning & causation** (if applicable):
   - Summarize decisions or turning points as cause-effect statements.
   - Deduplicate conflicting intermediate thoughts; keep only the finalized conclusion or intentional pivot.
   - Mark contradictions with existing MEMORY.md facts as [SUPERSEDED] (old) vs [CURRENT] (new).
   - Never duplicate information already captured in atomic facts.

   **Behavioral patterns** (inductive):
   - Only record a pattern if supported by **2+ occurrences** across different days.
   - Classify: `preference` (likes/dislikes), `behavior` (habits), `tendency` (recurring reactions), `correlation` (co-occurring events).
   - Low confidence (2 occurrences) → note but do not overwrite existing facts.
   - High confidence (3+ occurrences) → record as established fact.

5. Update MEMORY.md using the appropriate tools:
   - New atomic fact → `memory_add`
   - Already present → skip
   - [SUPERSEDED] → `memory_replace` (update) or `memory_remove` (delete)
   - New pattern with 2+ evidence → `memory_add` to preferences/rules section
   - If MEMORY.md is near capacity, consolidate related entries with `memory_replace` first.
