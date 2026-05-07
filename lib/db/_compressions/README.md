# Agent Prompt Compressions

Archive of system-prompt compressions applied to `agent_memory_entries` rows on
2026-05-06 / 2026-05-07. Each `<agent>.json` file is a snapshot of the
`{agent, kind, section_name, new_content}` payloads passed to
`apply_compression.mjs`.

## Why this exists

The agent SOULs / USERs / SKILLs / MEMORY rows live in the database
(`agent_memory_entries`), not in source files. To preserve a record of what
was changed (and to make rollbacks reproducible), every compression run
writes its inputs here.

## How to apply / roll back

- Apply: `node lib/db/apply_compression.mjs <agent>.json "<reason-tag>"`.
  This INSERTs the prior content into `agent_memory_entries_archive` then
  UPDATEs `agent_memory_entries` in a single transaction.
- Roll back: `node lib/db/rollback_compression.mjs "<reason-tag>"`.
  Restores every row archived under that reason tag to its prior content.
- Compare before applying: `node lib/db/compare_compressed.mjs <agent>.json`.

## Reason tags used so far

- `compress-orchestrator-2026-05-06`
- `compress-ideas-2026-05-07`
- `compress-ingest-2026-05-07`
- `compress-brief-2026-05-07`
- `compress-email-2026-05-07`
- `compress-coach-2026-05-07`
- `compress-contacts-2026-05-07`
- `compress-tasks-2026-05-07`
- `compress-journal-2026-05-07`
- `compress-checkin-2026-05-07`
- `compress-schedule-2026-05-07`
- `compress-calls-2026-05-07`
- `compress-shared-2026-05-07`
- `fix-auto-title-prose-2026-05-07` (regression fix found in test phase)

## Total impact

~74,134 → ~56,821 tokens of system prompt loaded per call (across all agents).
~17,313 tokens / 23% reduction. Live in DB; no rebuild or restart required.

## Scope vs maintenance helpers

- `dump_agent.mjs` — pulls all rows for an agent to `/tmp/prompts/<agent>/`.
- `scope_prompts.mjs` — prints live-loaded char/token totals per agent.
- `verify_compression.mjs <agent>` — shows current row sizes + archive count.
- `setup_archive.mjs` — creates `agent_memory_entries_archive` (idempotent).
