# dbquery-agent

Internal web tool: users ask a database a question in plain English, a model
writes the SQL, and queries can be saved and shared. It starts as a prototype
for work, built so it could become a product for others.

## Stack

- Vue SPA built with Vite (`web/`)
- Hono API on Bun (`server/`), which also serves the built SPA
- Test database: SQL-Dex Pokémon SQLite, a local copy at `data/pokedex.sqlite`
  (gitignored; 170 tables)
- Production target: Microsoft SQL Server, added as an adapter

## Rules

- The model only proposes SQL. Code decides what schema it sees, checks the
  query, and runs it with limits. Never rely on a prompt for safety.
- Target databases are read-only: read-only connection or login first, with SQL
  checks and row limits as extra layers.
- App data (users, saved queries, sharing) lives in the app database, never in
  a target database.
- Secrets and per-deployment settings go in `.env`. Non-secret connection
  definitions go in `connections.json`, naming the env var that holds any
  password. Never prefix a secret with `VITE_`.
- Dialect-specific code stays inside adapters.
- The API can run SQL and has no login yet, so the server refuses to start on a
  non-loopback `HOST`. Remove that check only once login exists (step 6).
- Users see the generated SQL before it runs. Generating only compiles it. A one-row
  trial run to catch empty results was tried and removed: no measurable gain (88/96
  with it, 90/96 without). A worked SQL example in the notes also scored worse (83/96).
  Differences this small are mostly noise, so don't tune against single runs.

## Plan

1. [x] Scaffold: config, adapter interface, read-only SQLite adapter, API, Vue shell.
2. [x] Profiler (no AI): tables, keys, row counts, column stats and sampled values,
   stored locally in an FTS5 index, re-run at startup when the schema hash changes.
3. [x] Table finder: search the index, follow foreign keys to find join paths, and
   send the model only those tables. Notes in `notes/<connection>.md` are sent to
   the model, and tables they name in backticks are pulled in when a note line
   shares a word with the question. Notes are file-only until there's a UI.
4. [x] Model adapter: one OpenAI-compatible client configured by base URL, tested on
   OpenRouter (`provider.zdr: true`). Requesty and a DGX Spark are untested.
5. [x] Core flow: question, generated SQL, SQL checks, retry on errors, then run on
   request, with a row cap and a timeout enforced by killing a child process.
6. [ ] App database and login: local accounts behind a replaceable auth layer, so
   SSO can be added later.
7. [ ] Side panel: saved queries, history, sharing. CSV export. A UI for notes.
8. [ ] Test suite: partly done, with 21 questions in `evals/sqldex.json`, comparing
   returned results rather than SQL text. Grow to about 25, then compare models.
9. [ ] SQL Server adapter: test `mssql`/`tedious` on Bun first (fall back to running
   Hono on Node), integration tests in a Podman container. It needs its own
   timeout and cancellation, and its own `validate` (`sp_describe_first_result_set`).

## Model results

`bun run eval sqldex <model>`, 2026-11-05, through OpenRouter with zero retention:

| Model | Tuning | Holdout |
|---|---|---|
| `google/gemma-4-26b-a4b-it` (default) | 12/13 | 8/8 |
| `qwen/qwen3-coder-next` | 11/13 | 7/8 |
| `qwen/qwen3.6-35b-a3b` | 6/13 | 7/8 |

One run each, so these are rough. Most `qwen3.6-35b-a3b` failures were empty replies
rather than wrong SQL, cause not confirmed, so that isn't a fair score yet.
The holdout questions weren't used for tuning, but share an author with the notes.

Later comparison on the full 32 questions, three runs each, final notes and code:
`google/gemma-4-26b-a4b-it` 89/96 (evolution level questions 3/9) and
`openai/gpt-oss-120b` 89/96 (evolution level questions 9/9). GPT-OSS's failures include
refusals when the finder didn't send `pokemon_stats`. `z-ai/glm-5.3-flash` scored 90/96
(evolution level questions 8/9), with 2 of its 6 failures being empty replies.
`openai/gpt-6-luna` rejects `temperature`, so run it with `MODEL_TEMPERATURE=none`. It
scored 89/96 (evolution level questions 9/9): 5 of its 7 failures were refusals when the
finder didn't send the stat tables, and 2 returned the correct Pokémon as a lowercase slug.
The finder is now the main limit on accuracy, not the model.

Questions in `evals/sqldex.json` marked `plain` are worded the way people type, without
"English" or "default forms". Keep adding these: leaving those words out exposed bugs
that the first questions hid. The model's output varies between runs even at temperature 0,
so run the suite several times before trusting a change.

`requiredFilters` in `connections.json` makes code enforce a filter. A query that uses a
table with that column but doesn't filter on it goes back to the model once. If the model
repeats it, it goes through with a warning, because the question may want every value.

## SQL Server profiling constraints

- Use system statistics for row counts and `TABLESAMPLE` for values. Run one query
  at a time with timeouts, preferably against a replica.
- Only sample values from explicitly allowed columns. Sampled values are sent to
  the model provider, and zero retention doesn't change that.

## Known gaps

- The finder's table selection uses name heuristics (`_names` suffix, shared first
  word) that suit this schema and are unproven on others.
- `validate` compiles SQL on the server's main thread, which is fast but synchronous.
- Keep TypeScript on 5.x: `vue-tsc` crashes on TypeScript 7.

## Commands

- `bun run dev:server` and `bun run dev:web`: run the API and Vite in development
- `bun run build` then `bun run start`: serve the built app
- `bun run profile <connection> [--force]`: rebuild a profile by hand
- `bun run eval <connection> [model]`: score a model, using real paid model calls
- `bun test` and `bun run typecheck`: run before calling work done
