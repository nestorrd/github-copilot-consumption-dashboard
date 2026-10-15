# Copilot Session Cost Dashboard

A local, **read-only** dashboard for tracking token usage, GitHub AI Credits and estimated USD
cost for Copilot sessions from VS Code, CLI and other clients that write compatible local
Copilot session event logs.

The dashboard cannot create sessions, send prompts or end sessions. Monitoring reads existing
telemetry and does not make billable model calls.

## Requirements

- Node.js `^20.19.0` or `>=22.12.0`, with npm.
- Read access to local Copilot session event logs. On Windows the default location is
  `%USERPROFILE%\.copilot\session-state`.

Use Copilot normally in VS Code or CLI to produce the telemetry. The dashboard itself does not
require a GitHub sign-in or start a Copilot runtime. Sessions without compatible local logs,
including remote sessions that have not synchronized to this machine, cannot be discovered.

## Install and run

Run these commands from the project directory:

```powershell
npm ci --registry=https://registry.npmjs.org/
npm start
```

Open **http://127.0.0.1:3000**.

Defaults work when local logs are in the standard location. To customize them, copy
[.env.example](.env.example) to `.env`,
edit the values, and restart the application:

```powershell
Copy-Item .env.example .env
```

On macOS or Linux, use `cp .env.example .env` instead.

If your organization restricts public npm access, use its approved registry and certificate setup.
Do not disable TLS verification.

## Using the dashboard

1. Start the dashboard and continue using Copilot in VS Code or CLI.
2. Select **Day**. It defaults to today in the browser's local timezone.
3. Inspect the summary cards and individual sessions for that day. Optionally filter by model
   or session ID. Clearing these filters keeps the selected day.
4. Click **View usage** or a session row to open its tokens, AI Credits, estimated cost and
   available per-call usage. The selected detail refreshes as telemetry changes.

The date filter selects sessions by their **start date**, not by the date of each individual
call. A session spanning midnight appears on the day it started with its accumulated session
consumption. This is not a calendar-day billing breakdown.

Summary cards include active and completed sessions matching the selected day and filters.
The full historical daily table is not displayed. Session and call tables scroll horizontally
inside their panels on narrow screens.

### Live updates and session status

- The backend checks local session files every **1 second**. Only files with a changed size or
  modification time are reparsed; changed files are currently reread in full, not tailed by byte offset.
- Server-Sent Events (SSE) push updated state to the browser.
- The browser fetches current application state on load, SSE reconnect, focus and return to a
  visible tab, with a **15-second** periodic fallback. These are read-only state requests.
- Connection or source failures are shown as stale/incomplete-data warnings. A successful refresh
  does not mean telemetry missing from Copilot's own files has been recovered.
- **Active** means recent activity with no known shutdown and no open assistant turn.
  **Processing** means an assistant turn is open. **Completed** means a shutdown event was found
  or completion was inferred when parsing a log with no activity for more than 30 minutes.
- Status is inferred from logs, not from an authoritative process-liveness API. Unchanged files
  are not reparsed merely because time passes. A historical shutdown marker may also remain
  after a session is resumed, so status should not be treated as proof that its process has stopped.
- The detail's **Live / Saved** indicator reflects log-derived status. **Saved** means local
  telemetry is available, not that the dashboard has saved a new record.
- Duration is based on recorded event timestamps, not a continuously running wall-clock timer.

Updates become visible after Copilot writes usage events, usually when an API call completes;
this is not token-by-token billing telemetry. Filters and the selected session remain in place
during updates. Changing the day closes the previous detail.

### Colors and the 100-credit threshold

The default reference threshold is **100 AI Credits ($1.00 estimated)** per session.
**100 is an arbitrary application default** defined in [src/config.ts](src/config.ts). It is
not supplied by GitHub, read from your subscription, or derived from your remaining allowance.
The dashboard does not retrieve your account's actual quota or balance.

- **Green:** below 80 AI Credits.
- **Amber:** from 80 through 100 AI Credits.
- **Red:** above 100 AI Credits.

These defaults come from `SESSION_CREDIT_BUDGET=100` and `SESSION_CREDIT_WARN_RATIO=0.8`.
Changing them changes the color thresholds, not Copilot billing. Red is a visual comparison,
**not an error, a spending cap, or proof that your GitHub allowance has been exceeded**.

## Configuration

All settings are optional and read from `.env` when the application starts.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Local dashboard port |
| `SESSION_CREDIT_BUDGET` | `100` | Arbitrary per-session reference threshold for colors; not a GitHub quota |
| `SESSION_CREDIT_WARN_RATIO` | `0.8` | Fraction of that threshold that triggers amber |
| `COPILOT_SESSION_STATE_DIR` | User home directory + `.copilot/session-state` | Read-only source of local Copilot session logs |
| `DATA_FILE` | `./data/sessions.json` | Previously saved dashboard records, retained for compatibility |
| `NANO_AIU_PER_AI_CREDIT` | `1000000000` | Conversion convention described below |

For example, to monitor a non-default location on Windows:

```dotenv
COPILOT_SESSION_STATE_DIR=C:\Users\you\.copilot\session-state
```

`COPILOT_GITHUB_TOKEN`, `DEFAULT_MODEL` and `COPILOT_APPROVE_ALL_TOOLS` remain in the
legacy SDK configuration and example environment file, but are **not used by the read-only
dashboard server**. They do not enable session creation, model calls or tool execution.

## Data sources and persistence

The primary source is `<COPILOT_SESSION_STATE_DIR>\<session-id>\events.jsonl`.
The monitor discovers session directories and extracts lifecycle and usage metadata:

- `session.start`, model changes, assistant turn boundaries and `session.shutdown`;
- `session.usage_record` for individual calls;
- `session.usage_checkpoint` for accumulated accounting, with subsequent receipts added using
  accounting watermarks to avoid counting checkpointed usage again.

Rows are reconciled by session ID. Local event-log records take precedence over matching legacy
JSON records, so they do not appear twice.

The dashboard keeps its monitoring cache in memory and does not write new external-session
history. Restarting reconstructs the view from Copilot's logs. Existing records in `DATA_FILE`
are still loaded, including saved call details. No **End & save session** action is needed.
Deleting or rotating Copilot's logs can remove sessions from the view unless a legacy record exists.

## Understanding usage and cost

- **Scope:** locally discoverable sessions with compatible event logs, not an account-wide
  GitHub billing feed. Other machines, accounts and unsynchronized remote sessions are not covered.
- **Missing data:** metrics Copilot does not report appear as **Not available**, not as zero or
  values inferred from model pricing. Partial credit readings are labelled **reported subtotal**.
  Telemetry failures appear as warnings.
- **Cached tokens:** the main total shows cache-read tokens. Per-call details also show cache-write
  tokens. Input and output counts are displayed as reported in the telemetry.
- **Estimated USD:** reported nano-AIU amounts are divided by `1e9`, following the
  [official SDK example](https://github.com/github/copilot-sdk/blob/v1.0.22/docs/features/usage-and-billing.md#accumulated-ai-credit-and-token-totals),
  then multiplied by $0.01. The SDK guide treats the nano-AIU conversion as a convention to verify
  against current billing, not a guaranteed exchange rate. The conversion is configurable.
  [GitHub billing documentation](https://docs.github.com/en/copilot/concepts/billing-and-usage/individuals/billing)
  confirms the AI Credit-to-USD rate. Estimates represent usage value, **not an invoice**; included
  allowances and discounts may affect actual charges.
- **Compatibility:** local event schemas and some billing fields can change between Copilot
  versions. Older logs may contain aggregate checkpoints but no per-call records. Session totals
  can therefore be available even when the call table is empty.

## Privacy

The web server listens only on `127.0.0.1`. Monitoring does not send prompts, resume sessions,
authenticate to GitHub or execute tools. Using Copilot separately still involves its normal
network requests and billing.

Source event logs can contain conversation text and tool data. The monitor reads those files
to extract metadata and usage but does not display or return conversation text through the
dashboard. The retained monitoring records contain session identifiers, timestamps, models
and usage metrics.

Keep `.env`, credentials and session history private. The project's ignore rules exclude `.env`
variants and all contents of `data/` except its empty placeholder. If you change `DATA_FILE`, use a
location inside `data/` or outside the checkout; other locations are not automatically protected.
Git ignore rules do not sanitize ZIP archives or files you explicitly share.

## Development

The backend uses Node.js and TypeScript; the frontend is HTML, CSS and vanilla JavaScript.
The monitor uses filesystem reads, not a database or a running SDK connection.

```powershell
npm run build
npm run typecheck
npm test
```

- [src/external-monitor.ts](src/external-monitor.ts): local discovery, event parsing and monitoring cache.
- [src/state.ts](src/state.ts): session-ID reconciliation.
- [src/server.ts](src/server.ts): read-only HTTP endpoints and SSE delivery.
- [src/store.ts](src/store.ts): legacy JSON history compatibility.
- [public/](public/): selected-day UI, filters and individual-session details.
- [tests/](tests/): usage accounting, persistence and UI regression tests.

[src/tracker.ts](src/tracker.ts) and `@github/copilot-sdk@1.0.22` remain as legacy integration
code and dependencies. The server no longer instantiates that tracker or exposes the session
start, prompt, end or model-list routes. Legacy premium-request multipliers are not used as AI Credits.
