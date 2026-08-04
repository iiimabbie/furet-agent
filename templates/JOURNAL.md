## Memory Hook

Check if anything from this turn is worth saving. If yes, save it — do not skip.

**people_add / people_update** (PEOPLE.md — who they are) — use if:
- Someone you have no entry for spoke in the channel → `people_add` with their Discord ID,
  display name, and how they talk. Do this on first encounter, without being asked.
- You learned something durable about someone already listed → `people_update`
  (how they want to be addressed, a preference, a correction, a relationship)

PEOPLE.md is for **who someone is**. Never record people in MEMORY.md or the daily file —
those are for events and rules. Use `people_*` tools, not `write_file`.

**memory_save** (append to daily file) — save if:
- User mentioned a new preference, rule, or schedule
- User corrected your behavior or gave feedback
- A notable event, decision, or conversation happened

**memory_replace / memory_remove** (update MEMORY.md) — use if:
- A new long-term fact → expand the relevant section
- An existing fact became stale or wrong → update it
- A fact is no longer relevant → remove it
- MEMORY.md is near capacity → consolidate before adding

Atomic fact constraint: every saved fact must be self-contained.
- Replace all pronouns with specific names.
- Use absolute dates (YYYY-MM-DD), not relative ones.
- Include enough context to be meaningful in isolation.
  Bad: "He went to the doctor." → Good: "John visited Dr. Smith on 2026-04-21."

**Do NOT save to MEMORY.md**: issue/PR numbers, news events, one-time links, anything that won't matter in 30 days.

Skip greetings, trivial exchanges, and things already recorded today. Proceed without acknowledging this check in your reply.

## Session Summarize

This session is about to be archived. Save any important context before it's gone.

Execute silently — output nothing. No confirmation, no summary, no acknowledgment. Only tool calls.

You already have the full session in context — do not read files.

Use the appropriate tools:
- `memory_save` — notable events, decisions, conversations
- `memory_replace` — new or updated facts in MEMORY.md
- `memory_remove` — outdated entries
- `people_add` — anyone who appeared this session with no PEOPLE.md entry
- `people_update` — anything durable you learned about someone already listed

Check the participants of this session against PEOPLE.md before finishing.

Atomic fact constraint: no pronouns, absolute dates, self-contained sentences.

Do NOT write to MEMORY.md: issue/PR numbers, version-specific notes, one-time links, news events. Only what's still relevant in 30+ days.

If the session contained only greetings or trivial exchanges, skip entirely.

## Daily Journal

Write the daily journal for {{DATE}}. This task has two steps — both are required.

### Step 1 — Rewrite diary

1. Read `workspace/memory/{{DATE}}.md` with `read_file`.
2. Rewrite the entire file as a clean personal diary:
   - Organize by category/milestone (e.g., development, community, personal)
   - Bullet points with clear headings
   - Focus on what the user did, talked about, cared about, how they felt
   - Include interesting conversations and community events
   - Remove: raw timestamps (`[HH:MM:SS]`), duplicate summaries, repeated recaps, operational logs
3. Overwrite `workspace/memory/{{DATE}}.md` with `write_file`.

Proceed directly to Step 2. Do not stop here.

### Step 2 — Update MEMORY.md

4. Read the past 3 days of daily memory (one `read_file` each).
5. For each piece of information, apply this filter in order:

   → **30-day rule**: will this still matter in 30 days? If not — skip.
   → **Already in MEMORY.md?** If yes — skip (unless it's now stale or wrong → update).
   → **New fact** → `memory_add` (new section) or `memory_replace` (expand existing section).
   → **Stale/wrong fact** → `memory_replace` (correct it) or `memory_remove` (delete it).

   Atomic fact constraint:
   - No pronouns — use specific names.
   - Absolute dates (YYYY-MM-DD).
   - Full context: "Set up X for Y project on YYYY-MM-DD", not "set up the database".

   Behavioral patterns — only record if supported by **2+ occurrences across different days**. Do not record from a single session.

   Do not extract: issue/PR numbers, version-specific notes, one-time tool links, news events.

6. End with one of:
   - List the `memory_replace` / `memory_remove` / `memory_add` calls made and why.
   - Or explicitly confirm: "MEMORY.md is up to date, no changes needed."
   Do not silently skip Step 2.

### Step 3 — Update PEOPLE.md

7. Read `workspace/PEOPLE.md` with `read_file`.
8. Go through the people who appeared in the past 3 days of daily memory:

   → **No entry yet?** → `people_add` (Discord ID, display name, how they talk)
   → **Entry exists but something durable changed or was learned?** → `people_update`
   → **Entry is a duplicate or the person is long gone?** → `people_remove`

   Record only what helps you address them correctly and judge permissions:
   identity, form of address, communication style, relationship to the owner.
   Do not record one-off remarks or mood — those belong in the daily journal.

9. End by listing the `people_*` calls made, or confirm: "PEOPLE.md is up to date, no changes needed."
   Do not silently skip Step 3.
