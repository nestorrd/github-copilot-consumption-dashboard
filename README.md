# Copilot Session Cost Dashboard

A local dashboard for tracking token usage, GitHub AI Credits and estimated USD cost for
Copilot sessions **started from this application**.

**1 AI Credit = $0.01 USD**, so a session budget of 100 AI Credits represents $1.00.

## Requirements

- Node.js `^20.19.0` or `>=22.12.0`, with npm.
- Your own GitHub account with Copilot access, authenticated through Copilot or `gh auth login`.
  Alternatively, configure `COPILOT_GITHUB_TOKEN` in your local environment file.

The SDK includes the Copilot runtime; no separate CLI installation is required to run the dashboard.
Available models depend on your account and organization policies.

## Install and run

Run these commands from the project directory:

```powershell
npm ci --registry=https://registry.npmjs.org/
npm start
```

Open **http://127.0.0.1:3000**.

Defaults work without configuration. To customize them, copy [.env.example](.env.example) to `.env`,
edit the values, and restart the application:

```powershell
Copy-Item .env.example .env
```

On macOS or Linux, use `cp .env.example .env` instead.

If your organization restricts public npm access, use its approved registry and certificate setup.
Do not disable TLS verification.

## Using the dashboard

1. Select a model and click **Start session**.
2. Send a prompt. The **Current session** panel updates as usage is reported.
3. Click **End & save session** to save the session and its captured calls locally.
4. Filter history by date, model or session ID. Click a session to see its details and individual calls.

The dashboard includes:

- **Live telemetry:** the current session's model, elapsed time, tokens, AI Credits, estimated cost
  and context-window usage.
- **Summary cards:** totals for completed sessions matching the history filters. The active session
  is shown separately, not included in these cards.
- **Persisted history:** completed sessions that remain available after restarting the application.

Use **End & save session** before closing. `Ctrl+C` also attempts to save an active session during
shutdown; a crash or forced termination can lose its unsaved data.

### Session budget

The default budget is **100 AI Credits ($1.00)** per session:

- **Green:** below 80% of the budget.
- **Amber:** at or above 80%, up to the budget.
- **Red:** the budget has been exceeded.

The budget is a visual warning, **not a spending cap**. It does not stop prompts or prevent charges.

## Configuration

All settings are optional and read from `.env` when the application starts.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Local dashboard port |
| `SESSION_CREDIT_BUDGET` | `100` | Per-session AI Credit budget |
| `SESSION_CREDIT_WARN_RATIO` | `0.8` | Fraction of the budget that triggers amber |
| `DATA_FILE` | `./data/sessions.json` | Local history file |
| `COPILOT_GITHUB_TOKEN` | unset | Override the logged-in GitHub account's authentication |
| `DEFAULT_MODEL` | unset | Default model ID; must be available to your account |
| `COPILOT_APPROVE_ALL_TOOLS` | `false` | Set to `true` to auto-approve agent tool requests |
| `NANO_AIU_PER_AI_CREDIT` | `1000000000` | Conversion convention described below |

**Tool permissions:** requests are rejected by default. Enabling auto-approval can allow the agent
to run commands and modify files on your machine. Enable it only if you understand and accept that access.

## Understanding usage and cost

- **Scope:** only sessions started by this app are tracked. It does not import arbitrary historical
  Copilot CLI or IDE sessions.
- **Live versus saved:** live values can change as telemetry arrives. Completed-session metrics and
  captured call details are stored in the local JSON history file.
- **Missing data:** metrics the SDK does not report appear as **Not available**, not as zero or
  values inferred from model pricing. Partial credit readings are labelled **reported subtotal**.
  Telemetry failures appear as warnings.
- **Cached tokens:** the main total shows cache-read tokens. Per-call details also show cache-write
  tokens. Input and output counts are displayed as reported by the SDK.
- **Context usage:** current context-window occupancy is separate from accumulated billable tokens.
- **Estimated USD:** reported nano-AIU amounts are divided by `1e9`, following the
  [official SDK example](https://github.com/github/copilot-sdk/blob/v1.0.22/docs/features/usage-and-billing.md#accumulated-ai-credit-and-token-totals),
  then multiplied by $0.01. The SDK guide treats the nano-AIU conversion as a convention to verify
  against current billing, not a guaranteed exchange rate. The conversion is configurable.
  [GitHub billing documentation](https://docs.github.com/en/copilot/concepts/billing-and-usage/individuals/billing)
  confirms the AI Credit-to-USD rate. Estimates represent usage value, **not an invoice**; included
  allowances and discounts may affect actual charges.
- **Experimental APIs:** accumulated usage metrics and some billing fields are experimental.
  Availability can depend on the SDK, runtime and account.

## Privacy

The web server listens only on `127.0.0.1`. However, **local hosting does not mean offline inference**:
prompts are sent to Copilot and its model providers.

The dashboard history contains session identifiers, timestamps, models and usage metrics, but not
prompt or response text. The Copilot runtime separately maintains its own local conversation history.

Keep `.env`, credentials and session history private. The project's ignore rules exclude `.env`
variants and all contents of `data/` except its empty placeholder. If you change `DATA_FILE`, use a
location inside `data/` or outside the checkout; other locations are not automatically protected.
Git ignore rules do not sanitize ZIP archives or files you explicitly share.

## Development

The backend uses Node.js, TypeScript and `@github/copilot-sdk@1.0.22`; the frontend is HTML, CSS and
vanilla JavaScript. There is no database.

```powershell
npm run build
npm run typecheck
npm test
```

SDK integration lives in [src/tracker.ts](src/tracker.ts); JSON persistence is in
[src/store.ts](src/store.ts), and the UI is in [public/](public/).

The integration captures ephemeral `assistant.usage` events for per-call details and
`session.usage_info` for context occupancy. It reads accumulated totals through the **experimental**
`session.rpc.usage.getMetrics()` API, with shutdown metrics or captured events as fallbacks.
`client.listModels()` wraps `models.list` for the model picker; `billing.tokenPrices` is experimental.
Legacy premium-request multipliers are not used as AI Credits.

See the [version-matched SDK guide](https://github.com/github/copilot-sdk/blob/v1.0.22/docs/features/usage-and-billing.md)
for the API reference. Recheck experimental fields when upgrading the pinned SDK.
