/**
 * True Name (TN) Lookup Service
 *
 * Resolves verified UPI account names for Indian mobile numbers
 * using the PayU VPA validation API.
 *
 * Pipeline:
 * 1. GET DBATU payment page → scrape form fields (including hash)
 * 2. POST to PayU → get payment ID from redirect
 * 3. GET PayU checkoutx API → get access token
 * 4. GET PayU VPA validate → get payerAccountName
 */

const cheerio = require("cheerio");

const HEADERS = {
  "Accept-Language": "en-GB,en;q=0.9",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
};

const DOMAINS = ["example.com", "gmail.com", "yahoo.com", "hotmail.com"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rand4() {
  const chars = "abcdefghijklmnopqrstuvwxyz";
  let s = "";
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function randMobile() {
  const start = 70 + Math.floor(Math.random() * 30);
  const rest = Math.floor(100000000 + Math.random() * 900000000);
  return `${start}${rest}`;
}

function randEmail() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let user = "";
  for (let i = 0; i < 10; i++) user += chars[Math.floor(Math.random() * chars.length)];
  return `${user}@${DOMAINS[Math.floor(Math.random() * DOMAINS.length)]}`;
}

function randTxn() {
  let digits = "";
  for (let i = 0; i < 18; i++) digits += Math.floor(Math.random() * 10);
  return `FSTKN${digits}`;
}

// ---------------------------------------------------------------------------
// Pipeline Steps
// ---------------------------------------------------------------------------

async function getFormFields(mobileno, email, name4) {
  const txn = randTxn();
  const url =
    `https://dbatu.unisuite.in/PaymentGatway/PaymentGateway/MakePayment` +
    `?merchantTxnID=${txn}` +
    `&orderAmount=354` +
    `&MobielNo=${mobileno}` +
    `&EmailID=${encodeURIComponent(email)}` +
    `&firstName=${name4}%20Rao` +
    `&Description=Payment%20Towards%20Application%20Form%20Fees%20For%20Regular` +
    `%20Statutory%20Positions%20%3A%20Reserved%20Catagory%20%20%5B${name4}%20Rao%5D` +
    `&requestNumber=FSTKN0004066153134` +
    `&isNeftChallanFromPG=False` +
    `&payExpiry=01%2F01%2F0001%2000%3A00%3A00` +
    `&IsPayExpiry=False` +
    `&PGiD=4`;

  const resp = await fetch(url, { headers: HEADERS, redirect: "follow" });
  const html = await resp.text();
  const $ = cheerio.load(html);
  const fields = {};
  $("input[name]").each((_, el) => {
    fields[$(el).attr("name")] = $(el).val() || "";
  });
  return fields;
}

async function getPaymentId(formFields) {
  const body = new URLSearchParams(formFields).toString();
  const resp = await fetch("https://secure.payu.in/_payment", {
    method: "POST",
    headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
    body,
    redirect: "manual",
  });
  const location = resp.headers.get("location");
  if (!location) return null;
  return location.split("/").pop();
}

async function getToken(pid) {
  const resp = await fetch(`https://api.payu.in/checkoutx?paymentId=${pid}`, {
    headers: HEADERS,
  });
  const data = await resp.json();
  return data?.transaction?.accessToken || null;
}

async function getPipelineToken() {
  const mobileno = randMobile();
  const email = randEmail();
  const name4 = rand4();

  const formFields = await getFormFields(mobileno, email, name4);
  if (!formFields.hash) throw new Error("hash_not_found");

  const pid = await getPaymentId(formFields);
  if (!pid) throw new Error("payment_id_failed");

  const token = await getToken(pid);
  if (!token) throw new Error("token_failed");

  return { pid, token };
}

// ---------------------------------------------------------------------------
// VPA Resolution
// ---------------------------------------------------------------------------

const EXPIRY_MARKERS = [
  "invalid_token", "token expired", "token_expired",
  "session expired", "invalid access_token", "invalid accesstoken",
  "expired access",
];

function isTokenExpired(text, status) {
  if (status === 401 || status === 403) return true;
  const lower = text.toLowerCase();
  return EXPIRY_MARKERS.some((m) => lower.includes(m));
}

async function resolveVpa(mobile, pid, token) {
  try {
    const resp = await fetch(
      `https://api.payu.in/utilities/vpas/${mobile}/validate?paymentId=${pid}&mapperFlow=1&access_token=${token}`,
      { headers: HEADERS }
    );
    const text = await resp.text();
    if (isTokenExpired(text, resp.status)) {
      return { name: null, error: "token_expired", expired: true };
    }
    const data = JSON.parse(text);
    const name = data.payerAccountName || null;
    return { name, error: name ? null : "not_found", expired: false };
  } catch (err) {
    return { name: null, error: err.message, expired: false };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a single mobile number.
 * @returns {{ name: string|null, error: string|null }}
 */
async function resolveTrueName(mobile) {
  try {
    const { pid, token } = await getPipelineToken();
    const result = await resolveVpa(mobile, pid, token);
    return { name: result.name, error: result.error };
  } catch (err) {
    return { name: null, error: err.message };
  }
}

/**
 * Resolve a batch of mobile numbers efficiently.
 * Uses one pipeline token and resolves all in parallel.
 * Retries with a fresh token if expiry is detected.
 *
 * @param {string[]} mobiles
 * @param {number} concurrency - max parallel VPA calls (default 20)
 * @returns {Array<{mobile: string, name: string|null, error: string|null}>}
 */
async function resolveBatch(mobiles, concurrency = 20) {
  if (!mobiles.length) return [];

  let pid, token;
  try {
    ({ pid, token } = await getPipelineToken());
  } catch (err) {
    // Pipeline failed — return all as errors
    return mobiles.map((m) => ({ mobile: m, name: null, error: err.message }));
  }

  const results = new Array(mobiles.length);
  const needRetry = [];

  // Fire ALL VPA calls in parallel (limited by concurrency)
  const queue = [...mobiles.map((m, i) => ({ mobile: m, idx: i }))];
  const workers = [];

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      const res = await resolveVpa(item.mobile, pid, token);
      if (res.expired) {
        needRetry.push(item.idx);
        results[item.idx] = { mobile: item.mobile, name: null, error: "token_expired" };
      } else {
        results[item.idx] = { mobile: item.mobile, name: res.name, error: res.error };
      }
    }
  }

  // Spawn concurrent workers
  for (let i = 0; i < Math.min(concurrency, mobiles.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  // Retry expired ones with a fresh token
  if (needRetry.length > 0) {
    try {
      ({ pid, token } = await getPipelineToken());
      const retryQueue = [...needRetry.map((idx) => ({ mobile: mobiles[idx], idx }))];
      const retryWorkers = [];

      async function retryWorker() {
        while (retryQueue.length > 0) {
          const item = retryQueue.shift();
          if (!item) break;
          const res = await resolveVpa(item.mobile, pid, token);
          results[item.idx] = { mobile: item.mobile, name: res.name, error: res.error };
        }
      }

      for (let i = 0; i < Math.min(concurrency, needRetry.length); i++) {
        retryWorkers.push(retryWorker());
      }
      await Promise.all(retryWorkers);
    } catch (err) {
      for (const idx of needRetry) {
        results[idx] = { mobile: mobiles[idx], name: null, error: "token_refresh_failed" };
      }
    }
  }

  return results;
}

module.exports = { resolveTrueName, resolveBatch, getPipelineToken };
