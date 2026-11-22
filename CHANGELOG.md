# Changelog

## Unreleased

### Changed

- **Rebuilt the web UI** with an Actual-inspired violet theme, persistent navigation, and responsive layouts across the dashboard, settings, account linking, statement imports, transfer repair, and result pages.
- **Overview dashboard** shows linked account count, the last sync outcome, the configured automatic-sync schedule, and per-account sync activity. Manual sync updates results in place with loading and error feedback. Activity is retained only for the current server session.
- **Connection settings** groups Up and Actual credentials into separate sections. Statement imports have a dedicated upload area while keeping the existing preview and confirmation flow.
- Styles and SVG icons are served locally, replacing the Bootstrap CDN stylesheet. The UI remains server-rendered with Express/Pug and needs no frontend build step.

## 1.2.1

### Changed

- **OFX statements are matched to existing Actual accounts.** A statement that isn't linked yet preselects the Actual account whose name or notes contain its account number. Failing that, it uses the last four digits in an account name. Only unique matches are preselected, and you can change them.
- **No balance to type for existing accounts.** The preview shows the account's balance in Actual on the statement date after the import, and whether it matches the statement. The sign (P&N reports loans as positive) is worked out automatically, and the closing balance field only appears when it can't be. Linked accounts take their closing balance from the statement.

## 1.2.0

### Changed

- **OFX uploads are built for adding new transactions.** The preview marks each statement row as new, already in Actual, or before the import start, and imports only the new ones. Statements that are already linked get a compact card: the target account, the closing balance to check, and collapsed transfer settings.
- **Importing into an Actual account that already has history.** Selecting an existing account shows an **Import transactions from** date, defaulting to the day after that account's newest transaction. The date is saved with the link, so later overlapping exports don't re-add older rows.

### Fixed

- A statement linked to a deleted or closed Actual account can be linked to another account. Previously every later import failed with "Selected Actual account is missing or closed".

## 1.1.0

### Changed

- **The budget is cached on disk between sessions.** Syncs and page loads open the local copy and pull only the changes since last time, instead of downloading the whole budget every time. Against a typical budget, opening went from several seconds to well under one. The cache (about 15 MB) lives in `budgets/`; mount it as a volume to keep it across container restarts.
- If the cached copy can't be brought up to date (for example the budget was reset on the server), a fresh copy is downloaded automatically. Network, authentication and encryption-key errors are reported as before and don't trigger a re-download.
- Replaces 1.0.1's per-session folders. Old folders are cleaned up automatically once they're 10 minutes old. Folders are still never deleted while Actual may be writing to them.

## 1.0.1

### Fixed

- **Crash after every budget operation.** Syncing or opening the Link accounts page deleted the local budget folder straight after `api.shutdown()`. `@actual-app/api` still writes `metadata.json` in the background after shutdown, and that write failed with ENOENT as an unhandled rejection, which exited the process. Containers crash-looped. Each budget session now uses its own folder, which is only cleaned up once it's stale (10 minutes).
- Unhandled background errors are now logged instead of terminating the web server.

## 1.0.0

A rewrite of the 0.2.x tool. See [Upgrading from 0.2.x](README.md#upgrading-from-02x) before deploying.

### Breaking changes

- Requires Node 22+ and a recent Actual server (`@actual-app/api` 26.11). The Docker image uses Node 24.
- The container runs as uid 1000 instead of root; the mounted config must be writable by that user.
- `cronEnabled=false` / `webUI=false` are now false (previously any non-empty value enabled them).
- The legacy `"budgetEncryption": "true"` checkbox value is ignored; set the real encryption password.
- The interactive CLI (`up_actual.js`) is removed.

### New

- **Actual API keys** (`actual.apiKey`), for servers using OpenID/OIDC.
- **Create Actual accounts from Up**: in bulk or one at a time from the link page. Accounts get history from a chosen date and an opening balance that matches Up. Each account can be on- or off-budget.
- **Transfers and round-ups** between linked Up accounts (including 2Up) are imported as Actual transfers. Round-ups are now imported at all; previously spending balances drifted by every round-up.
- **Link existing transfers…**: converts transfer pairs previously imported as two ordinary transactions. It previews before changing anything.
- **Categories** (optional): mirror Up's categories onto new on-budget transactions, and categorise transfers crossing the budget boundary (e.g. Contributions, Pocket Money).
- **P&N OFX import**: upload P&N statements, create or map accounts with opening balances, and link P&N ↔ P&N and P&N ↔ Up transfers.
- Optional HTTP basic auth for the web UI (`webUIUsername` / `webUIPassword`).
- Sync results and errors are shown in the web UI; `/healthz` endpoint.

### Fixed

- Encrypted budgets never worked (a checkbox value was sent as the password).
- Up results beyond the first 100 transactions were dropped (no pagination).
- A deleted Up account (e.g. a closed saver) failed every sync; it's now reported against that account only.
- The cron schedule and the Sync button could run concurrently.
- Errors in sync or setup could hang requests or crash the process.
- The setup page echoed saved secrets back into the HTML.

### Internal

- Express 5, node-cron 4, nconf 0.13. axios, body-parser, fs-extra and inquirer were replaced with built-ins or removed. `npm audit`: 0 vulnerabilities (was 19).
- Lint and test CI on Node 22 and 24, with a test suite that runs against a real Actual engine.
- Multi-arch image (amd64 and arm64).
