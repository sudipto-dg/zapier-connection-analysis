# Zapier Connection Usage Tracker

Tracks the number of active Zaps using each Zapier app connection over time. Daily snapshots are written to Google Sheets so you can build pivot tables and trend charts (for example, declining usage during a migration).

## How it works

1. Loads Zapier session credentials from `config/zapier-config.json` (browser Cookie — never committed).
2. Calls Zapier’s internal authentications API for connections matching `queryInput.selectedApi` (with pagination).
3. For each connection, calls `zap.searchZaps` with `status: "on"` and records the **live** zap count (`result.data.count`).
4. Writes one row per connection per snapshot date to a worksheet named `{app}_connection_usage_history` (e.g. `mysql_connection_usage_history` for `MySQLCLIAPI`; created automatically if missing). New connections are appended; same-day re-runs update existing rows for that `(snapshot_date, connection_id)` instead of duplicating.
5. Rows from earlier calendar days are never overwritten. Only the current snapshot date is upserted.

> **Note:** `zap_count` reflects **live (on) Zaps only**, not the total from the connections list (which includes deactivated Zaps). Rows captured before this change may show the older total-count semantics — treat them accordingly in pivot tables and charts.

## Requirements

- Node.js 24.16.0
- A Zapier account with access to the asset management API (browser session)
- A Google Cloud service account with access to your target spreadsheet

## Project structure

```text
├── src/
│   ├── main.js              # Entry point
│   ├── zapier-client.js     # Zapier API + transforms
│   └── google-sheets.js     # Google Sheets upsert/append
├── config/
│   ├── zapier-config.example.json
│   └── zapier-config.json   # You create this (gitignored)
├── credentials/
│   └── google-service-account.json   # You add this (gitignored)
├── .env.example
├── package.json
└── .github/workflows/daily-snapshot.yml
```

## Quick start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure Google Sheets

#### Create a service account

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Create or select a project.
3. Enable **Google Sheets API** (APIs & Services → Library → Google Sheets API → Enable).
4. Go to **IAM & Admin → Service Accounts → Create service account**.
5. Create a key: **Keys → Add key → JSON** and download the file.
6. Save the key as `credentials/google-service-account.json`.

#### Share the spreadsheet

1. Create or open the Google Sheet you want to use.
2. Copy the spreadsheet ID from the URL:
   `https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit`
3. Share the sheet with the service account email (from the JSON `client_email` field) as **Editor**.

#### Configure environment variables

```bash
cp .env.example .env
```

Edit `.env`:

```env
GOOGLE_SHEET_ID=your_spreadsheet_id_here
GOOGLE_SERVICE_ACCOUNT_KEY_PATH=credentials/google-service-account.json
```

Optional:

```env
GOOGLE_SHEET_WORKSHEET=mysql_connection_usage_history
SNAPSHOT_TIMEZONE=Asia/Kolkata
```

`GOOGLE_SHEET_WORKSHEET` overrides the auto-derived tab name. By default, the tab is built from `queryInput.selectedApi` (e.g. `MySQLCLIAPI` → `mysql_connection_usage_history`, `SlackAPI` → `slack_connection_usage_history`).

### 3. Configure Zapier authentication

Zapier credentials are **not** stored in source code or `.env`. They live in `config/zapier-config.json` so you can refresh the browser Cookie without code changes.

```bash
cp config/zapier-config.example.json config/zapier-config.json
```

#### Copy Cookie from Chrome DevTools

1. Log in to [https://zapier.com](https://zapier.com).
2. Open **DevTools** (F12) → **Network**.
3. Navigate to your Zapier connections / asset management UI so the app loads authentications.
4. Find a request to `authentication.authentications` (or similar BFF URL).
5. Copy the full **Cookie** request header value.
6. Paste it into `config/zapier-config.json` under `headers.Cookie`.

#### Endpoint options

**Recommended** — base URL + `queryInput` (supports automatic pagination):

```json
{
  "endpoint": "https://zapier.com/api/asset-management-bff/trpc/authentication.authentications",
  "headers": { "Cookie": "...", "Accept": "*/*", "User-Agent": "Mozilla/5.0" },
  "queryInput": {
    "includeZapCount": true,
    "limit": 100,
    "offset": 0,
    "ordering": "-updated_at",
    "owner": "",
    "search": "",
    "selectedApi": "MySQLCLIAPI",
    "status": "all"
  }
}
```

Set `selectedApi` to the app API id from Zapier DevTools when you filter connections in the asset UI (e.g. `MySQLCLIAPI`, `SlackAPI`). The script sends this to Zapier and also filters each page client-side (records use versioned ids like `MySQLCLIAPI@2.0.7`).

**Alternative** — paste the full URL from DevTools (including the `input=` query parameter). The script parses `input` and updates `offset` for each page.

Optional `searchZapsEndpoint` (defaults to `zap.searchZaps` BFF URL) overrides where live zap counts are fetched if Zapier changes the path.

Set `ZAPIER_SEARCH_CONCURRENCY` in `.env` to control parallel `zap.searchZaps` requests (default: `5`).

### 4. Run a snapshot

```bash
npm run collect
```

Example output:

```text
=== Zapier Connection Usage Snapshot ===

[info]  Snapshot date (Asia/Kolkata): 2026-06-02
[info]  Worksheet: mysql_connection_usage_history
[zapier] Fetching connections for MySQLCLIAPI...
[zapier] Total MySQLCLIAPI connections: 12
[zapier] Fetching live (on) zap counts for 12 connection(s) (concurrency: 5)...
[zapier] Live zap counts: 12/12 — Aurora Read Replica (62900274): 55
[zapier] Live zap count phase completed in 2.41s
[sheets] Updated 0 row(s), appended 12 row(s) to "mysql_connection_usage_history".

=== Summary ===
Connections processed: 12
Rows updated:          0
Rows appended:         12
Total live zap count: 245
Execution duration:  5.83s
```

## Google Sheet columns

| Column | Description |
|--------|-------------|
| `snapshot_date` | Date of the run (YYYY-MM-DD) |
| `connection_id` | Zapier connection ID |
| `connection_name` | Connection title |
| `api_version` | e.g. `MySQLCLIAPI@2.0.7` |
| `zap_count` | Live (on) Zaps using this connection (`zap.searchZaps`, `status: on`) |
| `is_stale` | Stale flag from Zapier |
| `last_changed` | Last change timestamp |
| `shared_with_all` | Shared-with-team flag |
| `account_id` | Owning account ID |

### Same-day re-runs (idempotent)

Each worksheet keeps at most one logical row per `(snapshot_date, connection_id)`. If you run the collector twice on the same day (locally or via GitHub Actions), the second run **updates** today’s rows with fresh counts instead of appending duplicates. Older dates are left unchanged.

Rows duplicated **before** this behavior was added are not removed automatically; re-running on those dates will update every matching duplicate row to the same values. You can delete extra historical duplicates manually if needed.

## Reporting in Google Sheets

All examples use the **`mysql_connection_usage_history`** tab (when `selectedApi` is `MySQLCLIAPI`).

### Pivot table

1. Select your data range (including headers).
2. **Insert → Pivot table** (new sheet or existing).
3. Configure:
   - **Rows:** `connection_name`
   - **Columns:** `snapshot_date`
   - **Values:** `zap_count` → Summarize by **SUM**

This shows how each connection’s Zap usage changes across snapshot dates.

### Trend chart (line chart)

1. Build a pivot table as above (or use a query that aggregates by date and connection).
2. **Insert → Chart**.
3. Chart type: **Line chart**.
4. **X-axis:** `snapshot_date`
5. **Series:** one series per `connection_name`, values = `zap_count`

Tip: If you have many connections, filter the pivot to top N by latest `zap_count`, or chart only connections you are migrating.

### Conditional formatting

Apply these on the data range (adjust column letters if needed; below assumes column E = `zap_count`, F = `is_stale`).

#### 1. Zero usage (`zap_count = 0`)

1. Select the `zap_count` column.
2. **Format → Conditional formatting**.
3. Format rules: **Custom formula is** `=E2=0` (adjust row/column).
4. Choose a highlight color (e.g. green for “safe to decommission”).

#### 2. Stale but still in use

Custom formula:

```text
=AND(F2=TRUE, E2>0)
```

Highlight amber/red — stale connections that still have active Zaps.

#### 3. Decreased since previous snapshot

Add a helper column (e.g. column J `zap_delta`) on row 2:

```text
=E2 - IFERROR(VLOOKUP(B2&MAXIFS($A$2:$A$1000,$A$2:$A$1000,"<"&A2), {B2:B1000&E2:E1000, E2:E1000}, 2, FALSE), E2)
```

A simpler approach for manual review:

1. Use the pivot table with `snapshot_date` as columns.
2. Compare the latest two date columns per connection.
3. Conditional format pivot cells where the latest value is less than the previous date column.

For formula-based highlighting on raw data, compare each row to the prior snapshot for the same `connection_id`:

```text
=E2 < MAXIFS($E$2:$E$1000, $B$2:$B$1000, B2, $A$2:$A$1000, "<"&A2)
```

(Extend `$1000` to cover your row count.)

## GitHub Actions (daily 6:00 AM IST)

The workflow [`.github/workflows/daily-snapshot.yml`](.github/workflows/daily-snapshot.yml) runs at **00:30 UTC** (06:00 IST) and can be triggered manually via **workflow_dispatch**.

### Required repository secrets

| Secret | Description |
|--------|-------------|
| `ZAPIER_CONFIG_JSON` | Full JSON contents of `config/zapier-config.json` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Full JSON contents of the service account key file |
| `GOOGLE_SHEET_ID` | Target spreadsheet ID |

### Setting secrets

1. Repo → **Settings → Secrets and variables → Actions → New repository secret**.
2. For `ZAPIER_CONFIG_JSON`, paste the entire `zapier-config.json` file (minified is fine).
3. For `GOOGLE_SERVICE_ACCOUNT_JSON`, paste the entire downloaded key JSON.
4. For `GOOGLE_SHEET_ID`, paste only the spreadsheet ID string.

### Refreshing Zapier Cookie in CI

Session cookies expire. When the workflow fails with authentication hints:

1. Copy a fresh Cookie from DevTools locally.
2. Update `config/zapier-config.json`.
3. Update the `ZAPIER_CONFIG_JSON` secret with the new file contents.

### Manual test run

**Actions → Daily Connection Snapshot → Run workflow**

## Troubleshooting

Runtime errors include **`[hint]`** lines to fix configuration proactively.

| Symptom | Fix |
|---------|-----|
| `Zapier config not found` | `cp config/zapier-config.example.json config/zapier-config.json` |
| `Cookie is missing or still a placeholder` | Paste a real Cookie from DevTools |
| `HTTP 401/403` or HTML response | Cookie expired — copy a new Cookie |
| `Could not find result.data.count` | Verify `searchZapsEndpoint` or refresh Cookie from a `zap.searchZaps` DevTools request |
| `GOOGLE_SHEET_ID is not set` | Create `.env` from `.env.example` |
| Key file not found | Place SA JSON at `credentials/google-service-account.json` |
| Permission denied on Sheets | Share spreadsheet with `client_email` from the key file |
| GitHub secret not set | Add `ZAPIER_CONFIG_JSON`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_SHEET_ID` |

## Security notes

- Never commit `config/zapier-config.json`, `.env`, or `credentials/*.json`.
- Rotate the Zapier Cookie when it expires; treat it like a password.
- Restrict service account key access; use GitHub encrypted secrets in CI.

## License

MIT
