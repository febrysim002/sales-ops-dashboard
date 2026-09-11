// Server-side proxy for the dashboard's Google Sheet data.
//
// Fetches all 5 sheets in one batched call using a Google service account
// (so the spreadsheet no longer needs "Anyone with the link can view"
// sharing) and returns them as plain 2D arrays of strings, in exactly the
// shape the dashboard's normalize* functions already expect from the old
// CSV-export path — so nothing on the client had to change except where
// the data comes from.
//
// Requires two environment variables, set in the Netlify site's dashboard
// (Site settings -> Environment variables), never committed to the repo:
//   GOOGLE_SERVICE_ACCOUNT_EMAIL  the service account's "client_email"
//   GOOGLE_SERVICE_ACCOUNT_KEY    the service account's "private_key"
//                                 (paste it as-is, including the
//                                 -----BEGIN/END PRIVATE KEY----- lines)
// Optional:
//   SHEETS_SPREADSHEET_ID         overrides the spreadsheet ID below

const crypto = require('crypto');

const SPREADSHEET_ID = process.env.SHEETS_SPREADSHEET_ID || '1m-2znh_9e_UHtuwTheWPpytuEZcKY88OaGngVAlBoFw';

const SHEET_NAMES = {
  soValue: 'Monthly SO Value (2025 vs 2026)',
  ontime: 'Ontime Delivery',
  arAging: 'AR Open Aging',
  pipeline: 'Actual Sales vs Forecast Pipeline',
  newProduct: 'New Products Introduced per Month'
};

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function fetchAccessToken(clientEmail, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };
  const unsigned = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(claims));

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer
    .sign(privateKey)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const jwt = unsigned + '.' + signature;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error('Token exchange failed (' + res.status + '): ' + text);
  }
  const json = await res.json();
  return json.access_token;
}

// Reused across warm invocations of the same function instance so we're
// not exchanging a fresh token on every single request.
let cachedToken = null;

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30000) {
    return cachedToken.token;
  }
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!clientEmail || !rawKey) {
    throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_SERVICE_ACCOUNT_KEY environment variable');
  }
  // Some UIs collapse real newlines to literal "\n" when saving env vars.
  const privateKey = rawKey.replace(/\\n/g, '\n');
  const token = await fetchAccessToken(clientEmail, privateKey);
  cachedToken = { token, expiresAt: Date.now() + 3500 * 1000 };
  return token;
}

// The Sheets API drops trailing empty cells per row instead of padding
// every row to the sheet's full width the way the old CSV export did —
// pad them back out so column-index lookups on the client stay safe.
function padRows(values) {
  if (!values || !values.length) return [];
  const maxCols = Math.max(...values.map(r => r.length));
  return values.map(r => {
    const row = r.slice();
    while (row.length < maxCols) row.push('');
    return row;
  });
}

exports.handler = async function () {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  };
  try {
    const token = await getAccessToken();
    const sheetKeys = Object.keys(SHEET_NAMES);
    const params = new URLSearchParams();
    sheetKeys.forEach(k => params.append('ranges', "'" + SHEET_NAMES[k] + "'"));

    const url =
      'https://sheets.googleapis.com/v4/spreadsheets/' +
      SPREADSHEET_ID +
      '/values:batchGet?' +
      params.toString();

    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) {
      const text = await res.text();
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: 'Sheets API error ' + res.status, detail: text })
      };
    }
    const json = await res.json();
    const valueRanges = json.valueRanges || [];
    const out = {};
    sheetKeys.forEach((key, i) => {
      out[key] = padRows((valueRanges[i] || {}).values || []);
    });

    return { statusCode: 200, headers, body: JSON.stringify(out) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
