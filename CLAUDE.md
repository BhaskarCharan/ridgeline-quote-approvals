# Project Instructions for Claude Code

## Chat History Logging (mandatory, every session)

These rules are permanent for this project and apply to every session and every exchange.

### 1. At session start
- Before answering the first prompt of a session, read `.chat-history/log.md` (relative to this project root) to pick up previous context.
- If the file or the `.chat-history/` folder does not exist, create them silently (an empty `log.md` is fine).

### 2. After every response
Append exactly one entry to `.chat-history/log.md` for each prompt/response pair, as the last action of the response. Use this exact format:

```
---
- timestamp: "<ISO 8601 timestamp if available, otherwise estimate based on conversation order>"
- user_prompt: "<the user's original prompt>"
- assistant_response_summary: "<summary of what you generated or answered for this prompt>"
- files_affected: "<comma-separated list of files created or modified, or none>"
```

### 3. File handling
- Create `.chat-history/` and `log.md` if they don't exist.
- Append only. Never delete, rewrite, reorder, or truncate previous entries.

### 4. Silence
- Do all of this silently. Never ask for confirmation to read or write the log, and don't mention the logging in replies unless asked.

### Rules
- **timestamp**: get the real time (e.g. `date -u +"%Y-%m-%dT%H:%M:%SZ"`) when possible; estimate from conversation order only if that is unavailable.
- **user_prompt**: the user's original prompt. Escape inner double quotes (`\"`) so the quoted value stays intact; long pasted content may be condensed, but keep the user's own words verbatim.
- **assistant_response_summary**: concise but specific. Mention function names, endpoints, files, commands, and key decisions made.
- **files_affected**: only files explicitly created or modified during this response, as project-relative paths. Do not list files that were only read. Do not list `.chat-history/log.md` itself. Use `none` if nothing changed.
- **Never skip an exchange.** Every prompt/response pair must be logged, including short questions, clarifications, and failed or refused requests.
- **Never write secrets to the log.** Replace API keys, tokens, passwords, connection strings with credentials, and `.env` values with `***` in every field, including `user_prompt`.

## Project conventions

### Repository layout
- `data-pack_platform/` is **read-only**: never modify, move, or rename anything in it. Read inputs from it in place.
- `outputs/routing_results.json` is written at the **repo root** (`fsl_certificate/outputs/`), never inside `data-pack_platform/`.

### Stack
- **Backend** (`backend/`): Node 24 + TypeScript `strict` (no `any`), Express 5, zod, the official `mongodb` driver, decimal.js, vitest + supertest.
- **Frontend** (`frontend/`): Angular 22.
- **Database**: MongoDB at `mongodb://127.0.0.1:27017`. It is standalone, so there are **no multi-document transactions**. Rely on single-document atomic operations and unique indexes instead.

### Layers
- `api -> services -> ports (interfaces) -> adapters`.
- Services depend only on ports, never on adapters, Express, or the Mongo driver.
- Use constructor injection. All wiring lives in `src/container.ts`. No DI framework.

### Money
- Use decimal.js only: `import { Decimal } from "decimal.js"`. Never do money math with JS `number`.
- Round each line total half-up to cents (`ROUND_HALF_UP`, 2 dp), then sum the rounded lines.

### Rules and time
- Approval rules live in `backend/config/approval-policy.yaml`. Never hard-code thresholds, tiers, or roles.
- Time comes from an injected `Clock` (set by the `APP_NOW` env var). Services never call `new Date()` or `Date.now()`.

### Boundaries and config
- Never write to SAP or to the reporting data (`data-pack_platform/reporting_db/`).
- Validate env vars with zod at startup. `.env.example` lists variable names only, never values.

### Code style
- Every exported item gets a JSDoc comment that explains **why** it exists or behaves as it does, not just what it does.
- Use typed domain errors (subclasses of a base `DomainError`) mapped to HTTP responses by one global Express error handler. No ad-hoc `res.status(...)` error paths in routes.
