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
2. **Link accounts**: pick the Actual account for each Up account you want synced.
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
