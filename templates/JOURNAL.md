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

**memory_update_index** (update MEMORY.md) — save if:
- User stated a long-term fact (preference, relationship, rule, resource)
- An existing fact in MEMORY.md became stale or wrong
- Procedure: read_file MEMORY.md → merge new facts → memory_update_index with full content
  (This tool OVERWRITES — you MUST include everything to keep.)

Skip: greetings, trivial exchanges, things already recorded today. Do not mention this hook in your reply.

## Session Summarize

Save a brief summary to memory (memory_save). Max 5 bullet points, each under 30 words. Cover:
- What the user did or decided
- Ongoing tasks or unresolved issues
- Key topics discussed

Apply the same atomic fact constraint: no pronouns, absolute dates, self-contained sentences.

Do NOT produce any text output, only save memory. Do NOT repeat information already saved earlier in the session.

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

5. Read workspace/MEMORY.md for current content.
6. Merge:
   - New atomic fact → add to matching section
   - Already present → skip
   - [SUPERSEDED] → update or remove (e.g. completed tasks, past events, changed settings)
   - New pattern with 2+ evidence → add to preferences/rules section
7. Call memory_update_index with the full merged version.
   (This tool OVERWRITES — content MUST include everything to keep.)
