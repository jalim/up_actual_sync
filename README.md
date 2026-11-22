# Up Bank → Actual Budget Sync

A small service that imports transactions from [Up Bank](https://up.com.au) into a self-hosted [Actual Budget](https://actualbudget.org) server.

- Scheduled sync (hourly by default)
- Web UI to configure credentials, link Up accounts to Actual accounts, and trigger a sync manually
- Upload P&N OFX statements, create or select Actual accounts, and link matching transfers (including Up ↔ P&N)
- Re-running is safe: transactions are de-duplicated by Up transaction ID, and held transactions are updated once they settle
- Transfers between your Up accounts (including 2Up) and round-ups become proper Actual transfers

## Requirements

- An Actual server compatible with `@actual-app/api` **26.11** (keep the server reasonably current)
- An Up [personal access token](https://api.up.com.au/getting_started)
- Node.js 22+ (or Docker)

## Quick start (Docker)

```sh
docker run -d --name up-actual-sync \
  -p 3000:3000 \
  -e webUI=true \
  -e cronEnabled=true \
  -e configFile=/home/node/app/config/config.json \
  -e webUIUsername=admin -e webUIPassword=change-me \
  -v ./config:/home/node/app/config \
  ghcr.io/jalim/up_actual_sync:latest
```

Then open `http://localhost:3000`:

1. **Connection settings**: enter your Up token, Actual server URL, an Actual API key or server password (see [Actual authentication](#actual-authentication)), budget sync ID (Actual → Settings → Advanced → Sync ID), and the end-to-end encryption password if your budget is encrypted. Saving verifies both connections.
2. **Accounts**: either let the tool create Actual accounts for your Up accounts (see [Starting a new budget](#starting-a-new-budget)), or pick an existing Actual account for each Up account.
3. **Sync now**, or wait for the schedule.

The container runs as uid 1000 (`node`), so the mounted config directory must be writable by that user (`sudo chown 1000:1000 ./config`).

The budget is cached in `/home/node/app/budgets` (about 15 MB for a typical budget), so each sync only pulls recent changes. Add `-v ./budgets:/home/node/app/budgets` (also writable by uid 1000) to keep the cache across container restarts. Without it, the first sync after a restart downloads the whole budget again. In Kubernetes an `emptyDir` is fine.

## Web UI

The interface has four screens, and follows your system's light or dark setting:

- **Overview**: until the first sync, a getting-started checklist (connect, link accounts, sync). After that, the last sync's outcome, when it ran and whether it was manual or scheduled, the next automatic sync, linked-account count, and per-account results. **Sync now** updates the page in place.
- **Accounts**: **Add Up accounts** creates new Actual accounts (with history and an opening balance) or links existing ones, in one step. An Actual account with the same name as an Up account is preselected. **Linked accounts** changes or removes links with a single **Save**; changed rows are highlighted. Stale links to deleted Up accounts and the transfer repair tool are here too.
- **Statement imports**: upload P&N OFX/QFX exports, review accounts and balances, then confirm the import.
- **Connection settings**: configure and verify Up and Actual credentials. Saved secrets are hidden; leave a secret field blank to keep its saved value.

The last sync result is saved to `last-sync.json` next to the config file (account names and counts only), so the overview survives restarts. Automatic-sync settings come from the [configuration](#configuration); the overview displays them without changing them.

Styles and icons are served by the app, with no external stylesheet or font dependency.

## P&N OFX imports

Open **Statement imports** in the web UI, select your P&N exports, then choose **Preview files**. You can upload several accounts and overlapping exports together. Nothing changes in Actual until you choose **Import**.

Statements you've imported before are recognised automatically. The preview shows how many transactions are new and how many are already in Actual, and the import adds only the new ones. For routine top-ups, just upload the latest export and import.

- For a statement that isn't linked yet, the preview preselects the matching Actual account when it can. It looks for the full account number in an account's name or notes (spaces and dashes are fine, e.g. `1234 5678`), then for the last four digits in an account's name. Only a unique match is preselected, never an account already linked elsewhere, and you can change it before importing.
- To add P&N transactions to an Actual account that already has history entered some other way, select that account and set **Import transactions from**. It defaults to the day after the account's newest transaction. Earlier statement rows are left out, and the date is saved with the link so later overlapping exports don't re-add them.
- If a linked Actual account is closed or deleted, the preview asks you to choose another account or create a new one.

- Review each account name, choose a new or existing Actual account, and check its budget status. Home loans are suggested as off-budget even when P&N labels them `SAVINGS`.
- For an existing Actual account, the preview shows what its balance will be on the statement date after the import, and whether that matches the statement. You don't enter a balance. The sign is worked out from Actual (P&N can report a loan balance as positive) and saved with the link. The closing balance field only appears if neither sign matches.
- For a new account, check the signed closing balance: money owed should be negative. The opening balance is calculated from the closing balance less the exported transactions, and dated before the statement period.
- Choose the linked Up account for transfers. Clear, unique matches use opposite amounts within three days and a description identifying Up or P&N. P&N internal transfers use their shared bank reference. Matches are revisited after subsequent uploads and Up syncs, so the two sides can arrive separately.
- If an Up transaction has already created a P&N transfer half, the importer attaches the OFX identity to that existing half. It does not create another transaction. If the transfer is created after the OFX import, its generated half is merged into the imported entry. Several possible matches are left for review; ambiguous existing transfer halves defer that OFX entry instead of adding a duplicate.
- Transfers crossing the on-budget/off-budget boundary need a category on the on-budget side. You can select a category in the preview or categorise them later in Actual. Transfers within the budget need no category.

P&N's OFX `FITID` values change between exports. This importer ignores them and derives IDs from the account, date, signed amount and bank reference (or description where there is no reference). Repeated identical entries retain their multiplicity. Changed descriptions on transactions without references may need manual review. Zero-dollar loan notices are skipped; interest and other financial transactions are retained.

The result shows additions, duplicate entries, existing transfer matches, balance checks and transfers needing review. When bank descriptions do not identify Up/P&N, or a match is ambiguous, use Actual's **All accounts → select the two transactions → Make transfer**. Avoid creating a second counterpart when both entries already exist.

Account links and opening-balance metadata are saved in the config file, scoped to the Actual server and budget. Keep that config volume when upgrading. Uploaded files are not saved to disk; previews are held in memory for up to 30 minutes and discarded after a successful import. Server restarts discard previews. Imports checkpoint completed work; after an error, re-upload the same files to continue. Deleting an imported entry in Actual and uploading it again will restore it.

For the first import, include the oldest history you want to keep. Earlier exports can subsequently extend an account created by this tool by adjusting its opening balance. Use this upload flow consistently for P&N; files previously imported directly in Actual have different IDs and can duplicate transactions.

## Configuration

Settings come from (highest priority first) command-line args, environment variables, then the JSON config file.

| Key | Default | Description |
|---|---|---|
| `configFile` | `./config.json` | Path to the JSON config file (env var only) |
| `webUI` | `false` | Serve the web UI |
| `port` | `3000` | Web UI port |
| `webUIUsername` / `webUIPassword` | – | Enable HTTP basic auth on the web UI (**recommended**: the UI can change your credentials) |
| `cronEnabled` | `false` | Run the scheduled sync |
| `cronSchedule` | `0 * * * *` | Cron expression for the schedule |
| `syncDays` | `5` | How many days back to fetch from Up on each run |

Booleans accept `true`/`false`, `1`/`0`, `yes`/`no`.

Credentials and account links are written to the config file by the web UI. You can also write the file yourself:

```json
{
  "UP": { "token": "up:yeah:..." },
  "actual": {
    "serverUrl": "https://actual.example.com",
    "apiKey": "...",
    "budgetId": "sync-id",
    "budgetEncryption": ""
  },
  "linkedAccounts": {
    "<up-account-id>": "<actual-account-id>"
  }
}
```

Nested keys can be set from the environment with `__`, e.g. `UP__token=...` or `actual__serverUrl=...`.

The config file holds secrets. Keep it out of version control and readable only by the service.

## Actual authentication

Use **one** of:

- **API key (recommended; required if your server uses OpenID/OIDC).** In Actual, open the budget, go to **Settings → General → Security → API keys**, choose **Add key**, and copy the key. It's shown only once. Keys are scoped to that budget and can be revoked from the same screen. Set it as `actual.apiKey` (or `actual__apiKey`).
- **Server password**, for servers using password login. Set it as `actual.serverPassword`.

If both are set, the API key is used. The budget's end-to-end encryption password (`actual.budgetEncryption`) is separate and still needed if the budget is encrypted.

## Starting a new budget

The tool can't create the budget file itself: API keys belong to one budget, so the budget has to exist first.

1. In Actual, create a new empty budget, then create an API key for it (see above).
2. Enter the key and the budget's sync ID on **Settings**.
3. On **Link accounts**, under *Create Actual accounts from Up*, tick the Up accounts you want, choose an **Import history from** date (defaults to the 1st of this month), and select **Create and link**.

When you open a new account in Up later, pick **➕ Create new Actual account** (or **➕ Create new off-budget account**) next to it on **Link accounts** and press **Save**. History starts from the 1st of this month, or from the day the Up account was opened if that's later. A brand-new account therefore starts at $0 with all its transactions.

For each selected account the tool:

- creates an Actual account with the same name (2Up accounts get a "(2Up)" suffix, and duplicate names get a number), on- or off-budget as you choose. Tick **Off budget** for money that isn't yours to budget, such as a child's pocket-money saver. Home loans are ticked by default. Actual can't switch an account between on- and off-budget later.
- imports every Up transaction from the start date
- adds a *Starting Balance* on the start date, set so that the Actual balance equals the current Up balance
- checks the resulting Actual balance against Up and shows a warning if they differ

The start date is saved per account (`importFrom` in the config file), so the regular sync never imports anything earlier and double-counts the opening balance. Linking that Up account to a different Actual account later removes its start date.

If an imported transaction has the same amount as the opening balance within 7 days of the start date, the opening balance is dated 8 days before the start date. Otherwise Actual's duplicate detection would merge the two.

## Transfers and round-ups

Up records a transfer in both accounts, and each side names the other. When both accounts are linked, the tool pairs the two sides (same amount, opposite direction, within a minute of each other) and creates **one** Actual transfer. Each half keeps its Up transaction ID, so re-running never duplicates it.

Round-ups need special handling. Up records the round-up only as an extra amount on the purchase in your spending account, plus a separate *Round Up* credit in the saver. The tool adds the missing spending-side *Round Up* transaction so Actual's balance matches Up. If the round-up saver is linked, that transaction becomes a transfer to it.

- Transfers to accounts that aren't linked (or aren't yours, e.g. PayID) are imported as ordinary transactions.
- Each sync holds back for up to 10 minutes a transfer whose other half hasn't appeared in Up yet, so the two can be paired.
- Pairs where one side was already imported as an ordinary transaction (e.g. by an older version) stay as ordinary transactions, so nothing is double-counted.
- When an account is created with history, transfers to accounts that were linked earlier are imported as ordinary transactions for that history.

To convert pairs that were imported as two ordinary transactions (by an older version, or before both accounts were linked), use **Link existing transfers…** on the **Link accounts** page. It shows how many pairs it found and can link, and changes nothing until you confirm. Each pair keeps its Up transaction IDs, so later syncs don't re-import anything.

**Deleting a saver in Up:** Up moves any leftover balance into another account as an ordinary deposit, and the tool imports it. Unlink the deleted account on **Link accounts** (it's listed under *No longer in Up*). Before closing it in Actual, change that deposit's payee to a transfer from the old account so its balance becomes $0. If you let Actual's close dialog transfer the balance instead, the money is counted twice.

**Upgrading an existing budget:** older versions didn't import round-ups, so a spending account with round-ups enabled is short in Actual by every round-up made before this version. Correct it with a one-off balance adjustment in Actual (reconcile the account to the Up balance), or recreate the account using the tool.

## Categories

Off by default. Configure in the config file:

```json
"categories": {
  "fromUp": true,
  "transfers": {
    "<off-budget Actual account id>": "Contributions",
    "<kid's saver Actual account id>": "Pocket Money"
  }
}
```

- **`fromUp`** mirrors Up's categories. Up's parent categories become Actual category groups (Home, Personal, Good Life, Transport). Each category is created the first time it's used, and new on-budget transactions are categorised to match Up. Off-budget transactions are never categorised. A category you've already set in Actual is never overwritten.
- **`transfers`** (keyed by Actual account ID: open the account in Actual and copy the ID from the address bar, `…/accounts/<id>`) sets the category for the on-budget half of a transfer to or from the given off-budget account, e.g. money from your personal account into the family budget, or pocket money paid out to a child's saver. The categories are looked up by name and must already exist in Actual. Actual's rules don't run on transfers created through the API, so this setting is needed instead.

## Upgrading from 0.2.x

- **A recent Actual server is required.** This release uses `@actual-app/api` 26.11, which needs a correspondingly current Actual server.
- **Node 22+** is required (the Docker image now uses Node 24).
- **The container runs as a non-root user.** Make sure your mounted config file or directory is writable by uid 1000.
- **Budget encryption:** 0.2.x stored `"budgetEncryption": "true"` from a checkbox instead of the password, so encrypted budgets never worked. That value is now ignored. Enter the real encryption password on the setup page.
- **`cronEnabled=false` and `webUI=false` now mean false.** In 0.2.x, any non-empty value turned these on.
- **Round-ups are now imported.** A spending account with round-ups enabled is short in Actual by every round-up made before upgrading (see [Transfers and round-ups](#transfers-and-round-ups)).
- **Existing transfer pairs stay as two ordinary transactions** until you use **Link existing transfers…** on the **Link accounts** page.
- The interactive CLI setup (`up_actual.js`) has been removed. Use the web UI or write the config file.

See [CHANGELOG.md](CHANGELOG.md) for everything that changed.

## Development

```sh
npm install
npm test        # node:test suite
npm run lint
webUI=true npm start
```

Code layout:

- `index.js`: entrypoint (config, cron, web UI)
- `src/config.js`: configuration loading and parsing
- `src/upBank.js`: Up API client (paginated)
- `src/actual.js`: opens/closes the Actual budget (serialized; the API is a singleton)
- `src/sync.js`: scheduled/manual sync from Up
- `src/mapping.js`: Up transaction → Actual transaction mapping
- `src/importer.js`: transfer and round-up pairing, imports, and linking existing transfer pairs
- `src/categories.js`: Up category mirroring and transfer categories
- `src/initialise.js`: creating Actual accounts from Up with opening balances
- `src/repair.js`: the "Link existing transfers" action
- `src/server.js`: Express routes and shared navigation/page-title data
- `views/`: Pug templates; `layout.pug` provides the navigation, shared shell, and SVG icon mixin
- `public/styles.css`: shared theme, components, responsive layouts, and reduced-motion support
- `public/client.js`: manual-sync interaction, per-account activity rendering, and local date formatting
- `public/ofx.js`: statement preview and import interactions
- `src/ofx.js`: OFX parsing and stable P&N transaction identities
- `src/ofxImport.js`: statement imports, opening balances and transfer matching

The UI uses the existing Express/Pug stack and plain CSS/JavaScript; no frontend build step is required. When changing templates or styles, check desktop and narrow layouts, keyboard focus, empty/error states, and sync/import feedback.

Tests run against a real in-process Actual engine (`test/helpers/localBudget.js`), not mocks, wherever Actual's behaviour matters.
