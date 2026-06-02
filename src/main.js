require('dotenv').config();

const {
  loadZapierConfig,
  fetchAllConnections,
  getWorksheetNameForConfig,
  toSnapshotRows,
  ZapierConfigError,
  ZapierAuthError,
  ZapierApiError,
} = require('./zapier-client');

const {
  validateEnvironment,
  appendSnapshotRows,
  GoogleConfigError,
  GoogleSheetsError,
} = require('./google-sheets');

function getSnapshotDate(timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date());
}

function formatDuration(ms) {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

function logConfigurationHint(err) {
  console.error(`\n[error] ${err.message}`);

  if (err.hint) {
    console.error(`[hint]  ${err.hint}`);
  }

  if (err instanceof GoogleSheetsError && err.clientEmail) {
    console.error(`[hint]  Service account email: ${err.clientEmail}`);
  }

  if (err instanceof ZapierConfigError) {
    console.error(
      '[hint]  Expected file: config/zapier-config.json (see config/zapier-config.example.json)'
    );
  }

  if (err instanceof ZapierAuthError) {
    console.error(
      '[hint]  Steps: 1) Log in to https://zapier.com  2) Open DevTools → Network  3) Find authentication.authentications request  4) Copy Cookie header into config/zapier-config.json'
    );
  }

  if (err instanceof GoogleConfigError) {
    console.error('[hint]  Copy .env.example to .env and fill in Google variables.');
  }

  if (err.code === 'ENOENT') {
    console.error('[hint]  A required file is missing. Check paths in .env and config/.');
  }
}

async function main() {
  const startTime = Date.now();
  console.log('=== Zapier Connection Usage Snapshot ===\n');

  try {
    validateEnvironment();
    const config = loadZapierConfig();

    const timeZone = process.env.SNAPSHOT_TIMEZONE || 'Asia/Kolkata';
    const snapshotDate = getSnapshotDate(timeZone);
    const worksheetName = getWorksheetNameForConfig(config);
    console.log(`[info]  Snapshot date (${timeZone}): ${snapshotDate}`);
    console.log(`[info]  Worksheet: ${worksheetName}`);

    const connections = await fetchAllConnections(config);
    const rows = toSnapshotRows(connections, snapshotDate);

    await appendSnapshotRows(rows, { worksheetName });

    const totalLiveZapCount = rows.reduce((sum, row) => sum + row.zap_count, 0);
    const duration = Date.now() - startTime;

    console.log('\n=== Summary ===');
    console.log(`Connections processed: ${rows.length}`);
    console.log(`Total live zap count: ${totalLiveZapCount}`);
    console.log(`Execution duration:  ${formatDuration(duration)}`);
    console.log('\nDone.');
  } catch (err) {
    logConfigurationHint(err);

    if (err instanceof ZapierApiError && err.status) {
      console.error(`[debug] HTTP status: ${err.status}`);
    }

    process.exit(1);
  }
}

main();
