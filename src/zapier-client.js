const fs = require('fs');
const path = require('path');
const axios = require('axios');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'zapier-config.json');
const PLACEHOLDER_COOKIE_MARKERS = [
  'PASTE_FROM_CHROME_DEVTOOLS',
  'paste-browser-cookie-here',
];

const DEFAULT_ZAP_SEARCH_PATH =
  'https://zapier.com/api/asset-management-bff/trpc/zap.searchZaps';

const DEFAULT_QUERY_INPUT = {
  includeZapCount: true,
  limit: 100,
  offset: 0,
  ordering: '-updated_at',
  owner: '',
  search: '',
  selectedApi: '',
  status: 'all',
};

const DEFAULT_ZAP_SEARCH_INPUT = {
  limit: 1,
  offset: 0,
  order: '-updated_at',
  status: 'on',
};

const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_SEARCH_CONCURRENCY = 5;

class ZapierConfigError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'ZapierConfigError';
    this.hint = hint;
  }
}

class ZapierAuthError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'ZapierAuthError';
    this.hint = hint;
  }
}

class ZapierApiError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'ZapierApiError';
    this.hint = hint;
  }
}

function loadZapierConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new ZapierConfigError(
      `Zapier config not found at ${CONFIG_PATH}`,
      'Copy config/zapier-config.example.json to config/zapier-config.json and paste your browser Cookie from Chrome DevTools.'
    );
  }

  let config;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    config = JSON.parse(raw);
  } catch (err) {
    throw new ZapierConfigError(
      `Failed to parse ${CONFIG_PATH}: ${err.message}`,
      'Ensure config/zapier-config.json is valid JSON.'
    );
  }

  if (!config.endpoint || typeof config.endpoint !== 'string') {
    throw new ZapierConfigError(
      'Missing or invalid "endpoint" in config/zapier-config.json',
      'Set "endpoint" to the Zapier authentications URL (base URL or full DevTools URL).'
    );
  }

  if (!config.headers || typeof config.headers !== 'object') {
    throw new ZapierConfigError(
      'Missing or invalid "headers" in config/zapier-config.json',
      'Include at least a "Cookie" header copied from Chrome DevTools.'
    );
  }

  const cookie = config.headers.Cookie || config.headers.cookie || '';
  if (
    !cookie ||
    PLACEHOLDER_COOKIE_MARKERS.some((marker) =>
      String(cookie).includes(marker)
    )
  ) {
    throw new ZapierConfigError(
      'Zapier Cookie is missing or still a placeholder',
      'Open zapier.com → DevTools → Network → copy the Cookie header from the authentications request into config/zapier-config.json.'
    );
  }

  return config;
}

function getSearchZapsPath(config) {
  return config.searchZapsEndpoint || DEFAULT_ZAP_SEARCH_PATH;
}

function resolveBaseInput(config) {
  let endpointUrl;
  try {
    endpointUrl = new URL(config.endpoint);
  } catch {
    throw new ZapierConfigError(
      `Invalid endpoint URL: ${config.endpoint}`,
      'Use a valid https://zapier.com/api/... URL.'
    );
  }

  const basePath = `${endpointUrl.origin}${endpointUrl.pathname}`;
  let baseInput = { ...DEFAULT_QUERY_INPUT };

  const inputParam = endpointUrl.searchParams.get('input');
  if (inputParam) {
    try {
      baseInput = { ...baseInput, ...JSON.parse(decodeURIComponent(inputParam)) };
    } catch {
      throw new ZapierConfigError(
        'Could not parse "input" query parameter from endpoint URL',
        'Use endpoint + queryInput in config, or paste a valid DevTools URL.'
      );
    }
  } else if (config.queryInput && typeof config.queryInput === 'object') {
    baseInput = { ...baseInput, ...config.queryInput };
  }

  return { basePath, baseInput };
}

function buildRequestUrl(basePath, queryInput) {
  const input = encodeURIComponent(JSON.stringify(queryInput));
  return `${basePath}?input=${input}`;
}

function isHtmlResponse(data) {
  if (typeof data !== 'string') {
    return false;
  }
  const trimmed = data.trim().toLowerCase();
  return trimmed.startsWith('<!doctype') || trimmed.startsWith('<html');
}

function extractTrpcError(data) {
  if (!data || typeof data !== 'object') {
    return null;
  }
  if (Array.isArray(data) && data[0]?.error) {
    return data[0].error;
  }
  if (data.error) {
    return data.error;
  }
  return null;
}

function extractConnections(data) {
  if (!data) {
    return null;
  }

  const candidates = [];

  if (Array.isArray(data)) {
    candidates.push(data);
    if (data[0]?.result?.data) {
      candidates.push(data[0].result.data);
    }
  }

  if (data.result?.data?.json) {
    candidates.push(data.result.data.json);
  }
  if (data.result?.data) {
    const inner = data.result.data;
    if (Array.isArray(inner)) {
      candidates.push(inner);
    } else if (Array.isArray(inner.items)) {
      candidates.push(inner.items);
    } else if (Array.isArray(inner.results)) {
      candidates.push(inner.results);
    } else if (Array.isArray(inner.authentications)) {
      candidates.push(inner.authentications);
    }
  }

  if (Array.isArray(data.data)) {
    candidates.push(data.data);
  }
  if (Array.isArray(data.items)) {
    candidates.push(data.items);
  }
  if (Array.isArray(data.authentications)) {
    candidates.push(data.authentications);
  }

  for (const list of candidates) {
    if (!Array.isArray(list)) {
      continue;
    }
    if (list.length === 0) {
      return list;
    }
    const first = list[0];
    if (
      first &&
      (first.id !== undefined ||
        first.zapCount !== undefined ||
        first.zap_count !== undefined)
    ) {
      return list;
    }
  }

  return null;
}

function extractLiveZapCount(data) {
  if (!data || typeof data !== 'object') {
    throw new ZapierApiError(
      'Could not read live zap count from Zapier searchZaps response',
      'The API response shape may have changed. Verify zap.searchZaps returns result.data.count.'
    );
  }

  const count = data.result?.data?.count;
  if (count === undefined || count === null) {
    throw new ZapierApiError(
      'Could not find result.data.count in zap.searchZaps response',
      'The API response shape may have changed. Verify the searchZaps endpoint in DevTools.'
    );
  }

  return Number(count);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(err) {
  if (!err.response) {
    return true;
  }
  const status = err.response.status;
  return status === 429 || status >= 500;
}

async function trpcRequestWithRetry(url, headers) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.get(url, {
        headers,
        timeout: REQUEST_TIMEOUT_MS,
        validateStatus: () => true,
      });

      if (response.status === 401 || response.status === 403) {
        throw new ZapierAuthError(
          `Zapier API returned HTTP ${response.status} (authentication failed)`,
          'Your session cookie has expired. Log in to zapier.com, copy a fresh Cookie from DevTools, and update config/zapier-config.json.'
        );
      }

      if (response.status >= 400) {
        const retryable = response.status === 429 || response.status >= 500;
        const err = new ZapierApiError(
          `Zapier API returned HTTP ${response.status}`,
          retryable
            ? 'Temporary server error; the job will retry automatically.'
            : 'Check the endpoint URL and request headers in config/zapier-config.json.'
        );
        err.status = response.status;
        err.retryable = retryable;
        throw err;
      }

      const contentType = String(response.headers['content-type'] || '');
      if (
        isHtmlResponse(response.data) ||
        contentType.includes('text/html')
      ) {
        throw new ZapierAuthError(
          'Zapier API returned an HTML page instead of JSON',
          'Your session cookie has likely expired. Copy a fresh Cookie from Chrome DevTools into config/zapier-config.json.'
        );
      }

      const trpcError = extractTrpcError(response.data);
      if (trpcError) {
        const message =
          trpcError.message ||
          trpcError.json?.message ||
          JSON.stringify(trpcError).slice(0, 200);
        throw new ZapierAuthError(
          `Zapier API error: ${message}`,
          'Re-authenticate at zapier.com and refresh the Cookie in config/zapier-config.json.'
        );
      }

      return response.data;
    } catch (err) {
      lastError = err;

      if (
        err instanceof ZapierAuthError ||
        (err instanceof ZapierApiError && !err.retryable)
      ) {
        throw err;
      }

      const retryable =
        err instanceof ZapierApiError
          ? err.retryable
          : isRetryableError(err);

      if (!retryable || attempt === MAX_RETRIES) {
        if (err instanceof ZapierApiError || err instanceof ZapierAuthError) {
          throw err;
        }
        throw new ZapierApiError(
          `Zapier API request failed: ${err.message}`,
          'Check your network connection and config/zapier-config.json.'
        );
      }

      const delayMs = 1000 * 2 ** (attempt - 1);
      console.warn(
        `[zapier] Request failed (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delayMs}ms...`
      );
      await sleep(delayMs);
    }
  }

  throw lastError;
}

async function fetchConnectionsPage(url, headers) {
  const data = await trpcRequestWithRetry(url, headers);
  const connections = extractConnections(data);
  if (connections === null) {
    throw new ZapierApiError(
      'Could not find connection list in Zapier API response',
      'The API response shape may have changed. Verify the endpoint URL matches the DevTools request.'
    );
  }
  return connections;
}

async function fetchLiveZapCount(connectionId, config) {
  const searchPath = getSearchZapsPath(config);
  const queryInput = {
    ...DEFAULT_ZAP_SEARCH_INPUT,
    connections: String(connectionId),
  };
  const url = buildRequestUrl(searchPath, queryInput);
  const data = await trpcRequestWithRetry(url, config.headers);
  return extractLiveZapCount(data);
}

function getSearchConcurrency() {
  const raw = process.env.ZAPIER_SEARCH_CONCURRENCY;
  if (!raw) {
    return DEFAULT_SEARCH_CONCURRENCY;
  }
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    return DEFAULT_SEARCH_CONCURRENCY;
  }
  return parsed;
}

async function enrichConnectionsWithLiveCounts(connections, config) {
  const total = connections.length;
  if (total === 0) {
    return connections;
  }

  const concurrency = getSearchConcurrency();
  console.log(
    `[zapier] Fetching live (on) zap counts for ${total} connection(s) (concurrency: ${concurrency})...`
  );

  const searchStart = Date.now();
  let completed = 0;

  async function processConnection(record) {
    const liveZapCount = await fetchLiveZapCount(record.id, config);
    record.liveZapCount = liveZapCount;
    completed += 1;
    const name = record.title ?? record.id;
    console.log(
      `[zapier] Live zap counts: ${completed}/${total} — ${name} (${record.id}): ${liveZapCount}`
    );
  }

  if (concurrency <= 1) {
    for (const record of connections) {
      await processConnection(record);
    }
  } else {
    let index = 0;
    async function worker() {
      while (index < connections.length) {
        const currentIndex = index;
        index += 1;
        await processConnection(connections[currentIndex]);
      }
    }
    const workers = Array.from(
      { length: Math.min(concurrency, connections.length) },
      () => worker()
    );
    await Promise.all(workers);
  }

  const searchDuration = ((Date.now() - searchStart) / 1000).toFixed(2);
  console.log(`[zapier] Live zap count phase completed in ${searchDuration}s`);

  return connections;
}

function getSelectedApiFilter(baseInput) {
  const api = baseInput?.selectedApi ?? baseInput?.selected_api ?? '';
  const trimmed = String(api).trim();
  if (!trimmed) {
    throw new ZapierConfigError(
      'Missing "selectedApi" in Zapier query input',
      'Set queryInput.selectedApi in config/zapier-config.json to the app API id from Zapier DevTools (e.g. MySQLCLIAPI).'
    );
  }
  return trimmed;
}

const WORKSHEET_SUFFIX = 'connection_usage_history';

function extractApiPrefix(selectedApi) {
  let name = String(selectedApi).trim().split('@')[0];
  if (!name) {
    return 'connection';
  }

  if (/API$/i.test(name)) {
    name = name.slice(0, -3);
  }
  if (/CLI$/i.test(name)) {
    name = name.slice(0, -3);
  }
  name = name.replace(/V\d+$/i, '');

  const slug = name
    .replace(/([a-z])([A-Z])(?=[a-z]|$)/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .toLowerCase()
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');

  return slug || 'connection';
}

function buildWorksheetName(selectedApi) {
  const prefix = extractApiPrefix(selectedApi);
  return `${prefix}_${WORKSHEET_SUFFIX}`;
}

function getWorksheetNameForConfig(config) {
  const { baseInput } = resolveBaseInput(config);
  const selectedApi = getSelectedApiFilter(baseInput);
  return buildWorksheetName(selectedApi);
}

function matchesSelectedApi(record, apiFilter) {
  const api = record.selectedApi || record.selected_api || '';
  return String(api).includes(apiFilter);
}

async function fetchAllConnections(config) {
  const { basePath, baseInput } = resolveBaseInput(config);
  const apiFilter = getSelectedApiFilter(baseInput);
  const limit = baseInput.limit || 100;
  const allConnections = [];
  let offset = 0;

  console.log(`[zapier] Fetching connections for ${apiFilter}...`);

  while (true) {
    const queryInput = { ...baseInput, offset, limit };
    const url = buildRequestUrl(basePath, queryInput);

    const page = await fetchConnectionsPage(url, config.headers);
    const filteredPage = page.filter((record) =>
      matchesSelectedApi(record, apiFilter)
    );
    allConnections.push(...filteredPage);

    console.log(
      `[zapier] Fetched offset ${offset}: ${filteredPage.length} ${apiFilter} connection(s) (page size ${page.length})`
    );

    if (page.length < limit) {
      break;
    }
    offset += limit;
  }

  console.log(
    `[zapier] Total ${apiFilter} connections: ${allConnections.length}`
  );

  await enrichConnectionsWithLiveCounts(allConnections, config);

  return allConnections;
}

function toSnapshotRows(connections, snapshotDate) {
  return connections.map((record) => ({
    snapshot_date: snapshotDate,
    connection_id: record.id,
    connection_name: record.title ?? '',
    api_version: record.selectedApi ?? record.selected_api ?? '',
    zap_count: Number(
      record.liveZapCount ??
        record.live_zap_count ??
        record.zapCount ??
        record.zap_count ??
        0
    ),
    is_stale: Boolean(record.isStale ?? record.is_stale),
    last_changed:
      record.lastchanged ?? record.lastChanged ?? record.last_changed ?? '',
    shared_with_all: Boolean(
      record.sharedWithAll ?? record.shared_with_all ?? false
    ),
    account_id: record.accountId ?? record.account_id ?? '',
  }));
}

module.exports = {
  loadZapierConfig,
  resolveBaseInput,
  fetchAllConnections,
  fetchLiveZapCount,
  toSnapshotRows,
  extractApiPrefix,
  buildWorksheetName,
  getWorksheetNameForConfig,
  WORKSHEET_SUFFIX,
  ZapierConfigError,
  ZapierAuthError,
  ZapierApiError,
};
