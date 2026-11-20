# Up Bank → Actual Budget Sync

A small service that imports transactions from [Up Bank](https://up.com.au) into a self-hosted [Actual Budget](https://actualbudget.org) server.

- Scheduled sync (hourly by default)
- Web UI to configure credentials, link Up accounts to Actual accounts, and trigger a sync manually
- Re-running is safe: transactions are de-duplicated by Up transaction ID, and held transactions are updated once they settle

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

1. **Setup**: enter your Up token, Actual server URL, an Actual API key or server password (see [Actual authentication](#actual-authentication)), budget sync ID (Actual → Settings → Advanced → Sync ID), and the end-to-end encryption password if your budget is encrypted. Saving verifies both connections.
2. **Link accounts**: either let the tool create Actual accounts for your Up accounts (see [Starting a new budget](#starting-a-new-budget)), or pick an existing Actual account for each Up account.
3. **Sync now**, or wait for the schedule.

The container runs as uid 1000 (`node`), so the mounted config directory must be writable by that user (`sudo chown 1000:1000 ./config`).

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
2. Enter the key and the budget's sync ID on **Setup**.
3. On **Link accounts**, under *Create Actual accounts from Up*, tick the Up accounts you want, choose an **Import history from** date (defaults to the 1st of this month), and select **Create and link**.

For each selected account the tool:

- creates an Actual account with the same name (2Up accounts get a "(2Up)" suffix, and duplicate names get a number); home loans are created off-budget
- imports every Up transaction from the start date
- adds a *Starting Balance* on the start date, set so that the Actual balance equals the current Up balance
- checks the resulting Actual balance against Up and shows a warning if they differ

The start date is saved per account (`importFrom` in the config file), so the regular sync never imports anything earlier and double-counts the opening balance. Linking that Up account to a different Actual account later removes its start date.

If an imported transaction has the same amount as the opening balance within 7 days of the start date, the opening balance is dated 8 days before the start date. Otherwise Actual's duplicate detection would merge the two.

Transfers between your own Up accounts (e.g. moving money to a Saver) are imported as ordinary transactions in each account, not as Actual transfers.

## Upgrading from 1.x

- **Node 22+** is required (the Docker image now uses Node 24).
- **The container runs as a non-root user.** Make sure your mounted config file or directory is writable by uid 1000.
- **Budget encryption:** 1.x stored `"budgetEncryption": "true"` from a checkbox instead of the password, so encrypted budgets never worked. That value is now ignored. Enter the real encryption password on the setup page.
- **`cronEnabled=false` and `webUI=false` now mean false.** In 1.x, any non-empty value turned these on.
- The interactive CLI setup (`up_actual.js`) has been removed. Use the web UI or write the config file.

## Development

```sh
npm install
npm test        # node:test suite
npm run lint
webUI=true npm start
```

Code layout:

- `index.js`: entrypoint (config, cron, web UI)
- `src/upBank.js`: Up API client (paginated)
- `src/actual.js`: opens/closes the Actual budget (serialized; the API is a singleton)
- `src/sync.js`: maps Up transactions and imports them
- `src/server.js`: Express routes
