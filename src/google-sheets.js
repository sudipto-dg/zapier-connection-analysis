const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const DEFAULT_WORKSHEET_NAME = 'connection_usage_history';

function resolveWorksheetName(explicitName) {
  const fromEnv = process.env.GOOGLE_SHEET_WORKSHEET?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const fromCaller = explicitName?.trim();
  if (fromCaller) {
    return fromCaller;
  }
  return DEFAULT_WORKSHEET_NAME;
}

const HEADERS = [
  'snapshot_date',
  'connection_id',
  'connection_name',
  'api_version',
  'zap_count',
  'is_stale',
  'last_changed',
  'shared_with_all',
  'account_id',
];

class GoogleConfigError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'GoogleConfigError';
    this.hint = hint;
  }
}

class GoogleSheetsError extends Error {
  constructor(message, hint, clientEmail) {
    super(message);
    this.name = 'GoogleSheetsError';
    this.hint = hint;
    this.clientEmail = clientEmail;
  }
}

function resolveKeyPath(keyPath) {
  if (path.isAbsolute(keyPath)) {
    return keyPath;
  }
  return path.join(__dirname, '..', keyPath);
}

function validateEnvironment() {
  const sheetId = process.env.GOOGLE_SHEET_ID?.trim();
  if (!sheetId) {
    throw new GoogleConfigError(
      'GOOGLE_SHEET_ID is not set',
      'Add GOOGLE_SHEET_ID to your .env file (copy from .env.example). The value is the spreadsheet ID in the Google Sheets URL.'
    );
  }

  const keyPathEnv = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH?.trim();
  if (!keyPathEnv) {
    throw new GoogleConfigError(
      'GOOGLE_SERVICE_ACCOUNT_KEY_PATH is not set',
      'Add GOOGLE_SERVICE_ACCOUNT_KEY_PATH to your .env file pointing to your service account JSON key.'
    );
  }

  const keyPath = resolveKeyPath(keyPathEnv);
  if (!fs.existsSync(keyPath)) {
    throw new GoogleConfigError(
      `Google service account key file not found: ${keyPath}`,
      'Download the service account JSON from Google Cloud Console and save it to credentials/google-service-account.json'
    );
  }

  return { sheetId, keyPath };
}

function readClientEmail(keyPath) {
  try {
    const key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    return key.client_email || null;
  } catch {
    return null;
  }
}

async function getSheetsClient(keyPath) {
  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const authClient = await auth.getClient();
  return google.sheets({ version: 'v4', auth: authClient });
}

function findSheetByTitle(spreadsheet, title) {
  return spreadsheet.sheets?.find(
    (s) => s.properties?.title === title
  );
}

async function ensureWorksheet(sheets, sheetId, worksheetName) {
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: sheetId,
  });

  let sheet = findSheetByTitle(spreadsheet.data, worksheetName);

  if (!sheet) {
    console.log(`[sheets] Creating worksheet "${worksheetName}"...`);
    const response = await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: { title: worksheetName },
            },
          },
        ],
      },
    });

    const newSheetId =
      response.data.replies?.[0]?.addSheet?.properties?.sheetId;
    sheet = { properties: { sheetId: newSheetId, title: worksheetName } };
  }

  return sheet.properties.sheetId;
}

async function ensureHeaders(sheets, sheetId, worksheetSheetId, worksheetName) {
  const range = `'${worksheetName}'!A1:I1`;
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range,
  });

  const currentHeaders = existing.data.values?.[0] || [];
  const headersMatch =
    currentHeaders.length === HEADERS.length &&
    HEADERS.every((h, i) => currentHeaders[i] === h);

  if (!headersMatch) {
    console.log('[sheets] Writing header row...');
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [HEADERS],
      },
    });
  }

  return worksheetSheetId;
}

function rowToValues(row) {
  return [
    row.snapshot_date,
    row.connection_id,
    row.connection_name,
    row.api_version,
    row.zap_count,
    row.is_stale,
    row.last_changed,
    row.shared_with_all,
    row.account_id,
  ];
}

async function appendSnapshotRows(rows, options = {}) {
  const { sheetId, keyPath } = validateEnvironment();
  const clientEmail = readClientEmail(keyPath);

  if (rows.length === 0) {
    console.warn('[sheets] No rows to append.');
    return { appended: 0 };
  }

  let sheets;
  try {
    sheets = await getSheetsClient(keyPath);
  } catch (err) {
    throw new GoogleConfigError(
      `Failed to initialize Google Sheets client: ${err.message}`,
      'Verify credentials/google-service-account.json is valid JSON from Google Cloud.'
    );
  }

  try {
    const worksheetName = resolveWorksheetName(options.worksheetName);
    const worksheetSheetId = await ensureWorksheet(
      sheets,
      sheetId,
      worksheetName
    );
    await ensureHeaders(sheets, sheetId, worksheetSheetId, worksheetName);

    const values = rows.map(rowToValues);
    const range = `'${worksheetName}'!A:I`;

    const response = await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values },
    });

    const updated = response.data.updates?.updatedRows ?? rows.length;
    console.log(
      `[sheets] Appended ${updated} row(s) to "${worksheetName}".`
    );
    return { appended: updated };
  } catch (err) {
    const message = err.message || String(err);
    const isPermission =
      message.includes('permission') ||
      message.includes('PERMISSION_DENIED') ||
      message.includes('403');

    if (isPermission && clientEmail) {
      throw new GoogleSheetsError(
        `Google Sheets permission denied: ${message}`,
        `Share the spreadsheet with the service account email as Editor: ${clientEmail}`,
        clientEmail
      );
    }

    throw new GoogleSheetsError(
      `Failed to write to Google Sheets: ${message}`,
      'Verify GOOGLE_SHEET_ID is correct and the service account has access to the spreadsheet.',
      clientEmail
    );
  }
}

module.exports = {
  validateEnvironment,
  appendSnapshotRows,
  resolveWorksheetName,
  DEFAULT_WORKSHEET_NAME,
  HEADERS,
  GoogleConfigError,
  GoogleSheetsError,
};
