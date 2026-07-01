"""
TN Lookup diagnostic test script
Run: python test_tn_lookup.py [mobile1] [mobile2] ...

If no mobile numbers are given, runs a pipeline health check only (no real number needed).
"""

import importlib.util
import sys
import time

# ---------------------------------------------------------------------------
# Load tn_service directly so we don't trigger the full Flask app import
# ---------------------------------------------------------------------------
spec = importlib.util.spec_from_file_location("tn_service", "samaj/tn_service.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

# ANSI colours
GREEN  = "\033[92m"
RED    = "\033[91m"
YELLOW = "\033[93m"
CYAN   = "\033[96m"
RESET  = "\033[0m"
BOLD   = "\033[1m"

def ok(msg):   print(f"  {GREEN}✓ PASS{RESET}  {msg}")
def fail(msg): print(f"  {RED}✗ FAIL{RESET}  {msg}")
def info(msg): print(f"  {CYAN}ℹ{RESET}  {msg}")
def warn(msg): print(f"  {YELLOW}⚠ WARN{RESET}  {msg}")
def header(msg): print(f"\n{BOLD}{msg}{RESET}")


# ---------------------------------------------------------------------------
# Step-by-step pipeline test
# ---------------------------------------------------------------------------

def test_pipeline():
    header("=" * 55)
    header("  TN Lookup — Pipeline Health Check")
    header("=" * 55)

    mobile   = str(m._rand_mobile())
    email    = m._rand_email()
    name4    = m._rand4()
    info(f"Random mobile={mobile}  email={email}  name4={name4}")

    # --- Step 1: Hash ---
    header("Step 1 · Fetch hash from DBATU payment gateway")
    t0 = time.time()
    try:
        hash_val, act_email, act_fname, act_phone = m._get_hash(mobile, email, name4)
        elapsed = time.time() - t0
        if hash_val:
            ok(f"Hash obtained ({len(hash_val)} chars) in {elapsed:.1f}s")
            info(f"Resolved  email={act_email}  firstname={act_fname}  phone={act_phone}")
        else:
            fail(f"Hash is None — payment page returned no <input name='hash'>")
            print(f"\n{RED}Cannot proceed without a hash. Aborting.{RESET}")
            return False
    except Exception as e:
        fail(f"Exception during hash fetch: {e}")
        return False

    # --- Step 2: Payment ID ---
    header("Step 2 · Get PayU payment ID")
    t0 = time.time()
    try:
        pid = m._get_pid(act_phone, act_email, hash_val, act_fname)
        elapsed = time.time() - t0
        if pid:
            ok(f"PID={pid}  ({elapsed:.1f}s)")
        else:
            fail("No PID returned — PayU did not redirect. Hash mismatch likely.")
            return False
    except Exception as e:
        fail(f"Exception during PID fetch: {e}")
        return False

    # --- Step 3: Access token ---
    header("Step 3 · Get PayU access token")
    t0 = time.time()
    try:
        token = m._get_token(pid)
        elapsed = time.time() - t0
        if token:
            ok(f"Token obtained ({elapsed:.1f}s): {token[:40]}...")
        else:
            fail("Token is None — checkoutx API returned no accessToken")
            return False
    except Exception as e:
        fail(f"Exception during token fetch: {e}")
        return False

    print(f"\n{GREEN}{BOLD}✓ All pipeline steps healthy.{RESET}")
    return True


# ---------------------------------------------------------------------------
# Lookup one or more mobile numbers
# ---------------------------------------------------------------------------

def lookup_numbers(mobiles):
    header("=" * 55)
    header(f"  TN Lookup — Resolving {len(mobiles)} number(s)")
    header("=" * 55)

    results = []
    for mobile in mobiles:
        mobile = mobile.strip()
        if mobile.startswith("91") and len(mobile) == 12:
            mobile = mobile[2:]  # strip +91 country code
        if not __import__("re").fullmatch(r"[6-9]\d{9}", mobile):
            warn(f"{mobile:12s}  — skipped (not a valid 10-digit Indian mobile)")
            results.append((mobile, None, "invalid_format"))
            continue

        print(f"\n  Looking up {BOLD}{mobile}{RESET} ...", end=" ", flush=True)
        t0 = time.time()
        name, err = m.resolve_true_name(mobile)
        elapsed = time.time() - t0

        if name and name != "NA":
            print(f"{GREEN}✓{RESET}")
            ok(f"{mobile:12s}  →  {BOLD}{name}{RESET}  ({elapsed:.1f}s)")
        elif name == "NA":
            print(f"{YELLOW}—{RESET}")
            warn(f"{mobile:12s}  →  No UPI name registered  ({elapsed:.1f}s)")
        else:
            print(f"{RED}✗{RESET}")
            fail(f"{mobile:12s}  →  {err}  ({elapsed:.1f}s)")

        results.append((mobile, name, err))
        time.sleep(0.5)  # be polite between calls

    # Summary
    header("-" * 55)
    resolved = [r for r in results if r[1] and r[1] != "NA"]
    no_name  = [r for r in results if r[1] == "NA"]
    errors   = [r for r in results if not r[1] and r[2] != "invalid_format"]
    invalid  = [r for r in results if r[2] == "invalid_format"]

    print(f"\n  {GREEN}Resolved : {len(resolved)}{RESET}")
    if no_name: print(f"  {YELLOW}No UPI   : {len(no_name)}{RESET}")
    if errors:  print(f"  {RED}Errors   : {len(errors)}{RESET}")
    if invalid: print(f"  {YELLOW}Skipped  : {len(invalid)}{RESET}")
    print(f"  Total    : {len(results)}")

    return results


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    mobiles = sys.argv[1:]

    pipeline_ok = test_pipeline()

    if mobiles and pipeline_ok:
        lookup_numbers(mobiles)
    elif mobiles and not pipeline_ok:
        print(f"\n{RED}Pipeline check failed — skipping number lookups.{RESET}")
    else:
        print(f"\n{CYAN}Tip:{RESET} Pass mobile numbers as arguments to test real lookups:")
        print(f"     python test_tn_lookup.py 9876543210 9123456789\n")
