# Changelog

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
