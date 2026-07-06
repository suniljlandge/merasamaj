# tn_service.py
import requests
from bs4 import BeautifulSoup
import random
import string
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

DOMAINS = ["example.com", "gmail.com", "yahoo.com", "hotmail.com"]
HEADERS = {
    "Accept-Language": "en-GB,en;q=0.9",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _rand4():
    return ''.join(random.choices(string.ascii_lowercase, k=4))

def _rand_mobile():
    start = random.randint(70, 99)
    rest  = random.randint(100000000, 999999999)
    return f"{start}{rest}"

def _rand_email():
    user = ''.join(random.choices(string.ascii_letters + string.digits, k=10))
    return f"{user}@{random.choice(DOMAINS)}"

def _extract_hash(html):
    soup = BeautifulSoup(html, "html.parser")
    tag  = soup.find("input", {"id": "hash"})
    return tag["value"] if tag else None

def get_hash_value(html_content):
    soup       = BeautifulSoup(html_content, 'html.parser')
    hash_input = soup.find('input', {'id': 'hash'})
    return hash_input['value'] if hash_input else None


# ---------------------------------------------------------------------------
# Pipeline: obtain a (pid, token) pair
# ---------------------------------------------------------------------------

def _get_form_fields(mobileno, random_email, random4letter):
    """GET the DBATU payment page and scrape all form fields."""
    rand_txn = 'FSTKN' + ''.join(random.choices(string.digits, k=18))
    url = (
        f"https://dbatu.unisuite.in/PaymentGatway/PaymentGateway/MakePayment"
        f"?merchantTxnID={rand_txn}"
        f"&orderAmount=354"
        f"&MobielNo={mobileno}"
        f"&EmailID={random_email}"
        f"&firstName={random4letter}%20Rao"
        f"&Description=Payment%20Towards%20Application%20Form%20Fees%20For%20Regular"
        f"%20Statutory%20Positions%20%3A%20Reserved%20Catagory%20%20%5B{random4letter}%20Rao%5D"
        f"&requestNumber=FSTKN0004066153134"
        f"&isNeftChallanFromPG=False"
        f"&payExpiry=01%2F01%2F0001%2000%3A00%3A00"
        f"&IsPayExpiry=False"
        f"&PGiD=4"
    )
    response = requests.get(url, headers=HEADERS, timeout=15)
    soup = BeautifulSoup(response.text, 'html.parser')
    return {
        tag['name']: tag.get('value', '')
        for tag in soup.find_all('input', {'name': True})
    }

# Keep old name for backwards compat
def _get_hash(mobileno, random_email, random4letter):
    return _get_form_fields(mobileno, random_email, random4letter)


def _get_pid(form_fields: dict):
    """POST form fields to PayU and return the payment ID from the redirect."""
    response = requests.post(
        "https://secure.payu.in:443/_payment",
        headers=HEADERS,
        data=form_fields,
        allow_redirects=False,
    )
    location = response.headers.get('Location')
    return location.split('/')[-1] if location else None


def _get_token(pid):
    """Exchange pid for an access token via the PayU checkoutx API."""
    r = requests.get(
        f"https://api.payu.in/checkoutx?paymentId={pid}",
        headers=HEADERS,
        timeout=15,
    )
    return r.json().get("transaction", {}).get("accessToken")


def get_pipeline_token():
    """
    Run the 3-step pipeline once and return (pid, token).
    Raises RuntimeError with a reason string on failure.
    """
    mobileno     = str(_rand_mobile())
    random_email = _rand_email()
    random4      = _rand4()

    form_fields = _get_form_fields(mobileno, random_email, random4)
    if not form_fields.get('hash'):
        raise RuntimeError("hash_not_found")

    pid = _get_pid(form_fields)
    if not pid:
        raise RuntimeError("payment_id_failed")

    token = _get_token(pid)
    if not token:
        raise RuntimeError("token_failed")

    return pid, token


# ---------------------------------------------------------------------------
# Token expiry detection
# ---------------------------------------------------------------------------

# Markers that indicate the token is stale / invalid.
# Checked against the lowercased response body.
# Deliberately specific to avoid false-positives on valid responses.
_EXPIRY_MARKERS = (
    "invalid_token",
    "token expired",
    "token_expired",
    "session expired",
    "invalid access_token",
    "invalid accesstoken",
    "expired access",
)

def _is_token_expired(response_text: str, status_code: int) -> bool:
    """Return True if the VPA response indicates a stale/invalid token."""
    if status_code in (401, 403):
        return True
    # payerAccountName absent is not enough on its own — only treat as expired
    # when the body explicitly signals it.
    lower = response_text.lower()
    return any(marker in lower for marker in _EXPIRY_MARKERS)


# ---------------------------------------------------------------------------
# VPA resolution (single call)
# ---------------------------------------------------------------------------

def _resolve_vpa_raw(mobile: str, pid: str, token: str):
    """
    One VPA lookup.  Returns (name | None, error | None, token_expired: bool).
    """
    try:
        r = requests.get(
            f"https://api.payu.in/utilities/vpas/{mobile}/validate"
            f"?paymentId={pid}&mapperFlow=1&access_token={token}",
            headers=HEADERS,
            timeout=15,
        )
        if _is_token_expired(r.text, r.status_code):
            return None, "token_expired", True

        data = r.json()
        name = data.get("payerAccountName") or None
        return name, None, False
    except Exception as e:
        return None, str(e), False


def _resolve_vpa(mobile: str, pid: str, token: str):
    """Convenience wrapper — drops the token_expired flag."""
    name, err, _ = _resolve_vpa_raw(mobile, pid, token)
    return name, err


# ---------------------------------------------------------------------------
# Thread-safe token holder (shared within one resolve_batch call)
# ---------------------------------------------------------------------------

class _TokenHolder:
    """
    Holds a (pid, token) pair and lets any thread refresh it exactly once
    when expiry is detected.

    Uses an Event so threads that detect expiry *after* the refresh has
    started wait for it to complete before retrying, rather than immediately
    retrying with the still-stale token.
    """

    def __init__(self, pid: str, token: str):
        self._pid        = pid
        self._token      = token
        self._lock       = threading.Lock()
        self._refreshing = False
        self._done_event = threading.Event()
        self._done_event.set()   # starts "done" (no refresh in progress)
        self._refresh_ok = False

    @property
    def pid(self):   return self._pid
    @property
    def token(self): return self._token

    def refresh(self):
        """
        Ensure the token is refreshed exactly once.
        - First caller: performs the refresh, signals completion.
        - Later callers: block until the first refresh finishes, then return.
        Returns True if a valid fresh token is now available.
        """
        with self._lock:
            if self._refreshing:
                # Another thread is already refreshing — wait for it
                lock_held = False
            else:
                self._refreshing = True
                self._done_event.clear()
                lock_held = True

        if not lock_held:
            # Wait for the in-progress refresh to complete
            self._done_event.wait(timeout=30)
            return self._refresh_ok

        # We are the designated refresher
        try:
            new_pid, new_token = get_pipeline_token()
            self._pid   = new_pid
            self._token = new_token
            self._refresh_ok = True
        except Exception:
            self._refresh_ok = False
        finally:
            self._done_event.set()

        return self._refresh_ok


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def resolve_true_name(mobile: str):
    """
    Single lookup: full pipeline + one VPA call.
    Returns: (verified_name | None, error | None)
    """
    try:
        pid, token = get_pipeline_token()
        name, err, _ = _resolve_vpa_raw(mobile, pid, token)
        return name, err
    except Exception as e:
        return None, str(e)


def resolve_batch(mobiles: list, max_workers: int = 8):
    """
    Resolve a list of mobile numbers as fast as possible.

    Algorithm:
      1. Acquire ONE (pid, token) via the pipeline  →  O(1) slow round-trip.
      2. Resolve all VPAs in parallel with ThreadPoolExecutor  →  fast.
      3. If any worker detects token expiry during the run, one thread
         refreshes the token (others wait on the same holder); the expired
         numbers are retried automatically with the new token.
      4. If the initial pipeline fails, fall back to per-number full pipelines
         running in parallel.

    Returns:
      [{"mobile": "...", "name": str | None, "error": str | None}, ...]
      Order matches the input list.
    """
    if not mobiles:
        return []

    # --- Attempt 1: shared token ---
    try:
        pid, token = get_pipeline_token()
        holder = _TokenHolder(pid, token)
        results = _run_parallel(mobiles, holder, max_workers)
        return results
    except Exception:
        pass  # pipeline acquisition failed — fall back

    # --- Fallback: each mobile gets its own full pipeline (parallel) ---
    out = [None] * len(mobiles)

    def _full(idx, mobile):
        name, err = resolve_true_name(mobile)
        return idx, {"mobile": mobile, "name": name, "error": err}

    with ThreadPoolExecutor(max_workers=min(max_workers, len(mobiles))) as pool:
        futures = {pool.submit(_full, i, m): i for i, m in enumerate(mobiles)}
        for f in as_completed(futures):
            idx, item = f.result()
            out[idx] = item

    return out


def _run_parallel(mobiles: list, holder: _TokenHolder, max_workers: int):
    """
    Inner parallel loop.  Uses holder.pid/token, retries once per number
    if token expiry is detected.
    """
    results = [None] * len(mobiles)

    def _worker(idx, mobile):
        name, err, expired = _resolve_vpa_raw(mobile, holder.pid, holder.token)

        if expired:
            # Ask the holder to refresh (only one thread will actually do it)
            refreshed = holder.refresh()
            if refreshed:
                # Retry with fresh token
                name, err, _ = _resolve_vpa_raw(mobile, holder.pid, holder.token)
            else:
                err = "token_refresh_failed"

        return idx, {"mobile": mobile, "name": name, "error": err}

    with ThreadPoolExecutor(max_workers=min(max_workers, len(mobiles))) as pool:
        futures = {pool.submit(_worker, i, m): i for i, m in enumerate(mobiles)}
        for f in as_completed(futures):
            idx, item = f.result()
            results[idx] = item

    return results
