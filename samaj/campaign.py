"""Campaign Manager module.

Provides MongoDB collection accessors, status constants, and data model
helpers for the WhatsApp Ads Campaign feature.
"""

import hashlib
import hmac
import json
import os
import re
from datetime import datetime, timezone

from bson import ObjectId
from flask import current_app


# ---------------------------------------------------------------------------
# Campaign Status Constants
# ---------------------------------------------------------------------------

PENDING_PAYMENT = "pending_payment"
PAYMENT_VERIFIED = "payment_verified"
SENDING = "sending"
SENT = "sent"
FAILED = "failed"

# Valid status transitions as a dict mapping current -> set of allowed targets.
_VALID_TRANSITIONS = {
    PENDING_PAYMENT: {PAYMENT_VERIFIED},
    PAYMENT_VERIFIED: {SENDING},
    SENDING: {SENT, FAILED},
}


# ---------------------------------------------------------------------------
# MongoDB Collection Accessors
# ---------------------------------------------------------------------------

def _get_database():
    """Return the app's MongoDB database instance via the registrations collection."""
    collection = current_app.extensions.get("mongo_collection")
    if collection is None:
        # Trigger lazy initialization if needed
        from samaj.db import create_collections
        config = current_app.config
        client, col, _corr = create_collections(config)
        current_app.extensions["mongo_client"] = client
        current_app.extensions["mongo_collection"] = col
        collection = col
    return collection.database


def get_campaigns_collection():
    """Return the 'campaigns' MongoDB collection."""
    return _get_database()["campaigns"]


def get_campaign_payments_collection():
    """Return the 'campaign_payments' MongoDB collection."""
    return _get_database()["campaign_payments"]


def get_campaign_messages_collection():
    """Return the 'campaign_messages' MongoDB collection."""
    return _get_database()["campaign_messages"]


# ---------------------------------------------------------------------------
# State Machine Validation
# ---------------------------------------------------------------------------

def validate_campaign_status_transition(current, target):
    """Validate whether a campaign status transition is permitted.

    Args:
        current: The campaign's current status string.
        target: The desired target status string.

    Returns:
        dict with keys:
            "valid" (bool): True if the transition is allowed.
            "error" (str | None): Error message if the transition is rejected.
    """
    allowed = _VALID_TRANSITIONS.get(current)

    if allowed is None:
        return {
            "valid": False,
            "error": (
                f"Transition from '{current}' to '{target}' is not permitted. "
                f"No transitions are allowed from status '{current}'."
            ),
        }

    if target not in allowed:
        return {
            "valid": False,
            "error": (
                f"Transition from '{current}' to '{target}' is not permitted. "
                f"Allowed transitions from '{current}': "
                f"{', '.join(sorted(allowed))}."
            ),
        }

    return {"valid": True, "error": None}


# ---------------------------------------------------------------------------
# Phone Number Normalization
# ---------------------------------------------------------------------------


def normalize_wa_number(mobile):
    """
    Normalize an Indian mobile number to WhatsApp format (91XXXXXXXXXX).

    Strips all non-digit characters, removes known prefixes (+91, 91, 0091,
    leading 0), validates the resulting 10 digits start with 6-9, and
    prepends '91' to produce a 12-character output.

    Args:
        mobile: A string representing an Indian phone number.

    Returns:
        A 12-character string in format '91XXXXXXXXXX', or None if the
        input is invalid (empty, wrong length, invalid start digit).
    """
    if not mobile or not isinstance(mobile, str) or not mobile.strip():
        return None

    # Strip all non-digit characters
    digits = re.sub(r"\D", "", mobile)

    # Remove known prefixes
    if digits.startswith("0091"):
        digits = digits[4:]
    elif digits.startswith("91") and len(digits) > 10:
        digits = digits[2:]
    elif digits.startswith("0"):
        digits = digits[1:]

    # Validate: must be exactly 10 digits starting with 6-9
    if len(digits) != 10:
        return None
    if digits[0] not in "6789":
        return None

    return "91" + digits


# ---------------------------------------------------------------------------
# Template Variable Resolution
# ---------------------------------------------------------------------------


def resolve_body_vars(template_vars, recipient):
    """
    Replace placeholders in template variables with recipient data.

    Recognized placeholders:
        - {name}   -> recipient's name
        - {mobile} -> recipient's normalized mobile number (91XXXXXXXXXX)

    Entries that are not recognized placeholders are passed through unchanged
    as literal values in the corresponding output position.

    If a recognized placeholder references a recipient field that is empty or
    missing, an empty string is substituted.

    Args:
        template_vars: A list of strings, some of which may be placeholders.
        recipient: A dict with at least 'name' and 'mobileNumber' keys.

    Returns:
        A list of strings with the same length as template_vars.
    """
    result = []
    for entry in template_vars:
        if entry == "{name}":
            name = recipient.get("name") or ""
            result.append(name)
        elif entry == "{mobile}":
            mobile_raw = recipient.get("mobileNumber") or ""
            if mobile_raw:
                normalized = normalize_wa_number(mobile_raw)
                result.append(normalized if normalized else "")
            else:
                result.append("")
        else:
            # Not a recognized placeholder — pass through unchanged
            result.append(entry)
    return result


# ---------------------------------------------------------------------------
# WhatsApp Ad Templates
# ---------------------------------------------------------------------------

# Available WhatsApp ad templates offered to campaigners in Step 2 of the
# campaign wizard. Each entry exposes the template name, its language code, and
# a body text preview with placeholder indicators (e.g. {name}). These are
# pre-approved Meta WhatsApp templates; the list is maintained here as a
# module-level constant (Requirements 4.1, 4.2).
AD_TEMPLATES = [
    {
        "name": "samaj_event_invite",
        "language": "mr",
        "bodyText": "नमस्कार {name}, आपल्या समाजाच्या आगामी कार्यक्रमासाठी "
                    "आपणास सहर्ष निमंत्रण. अधिक माहितीसाठी संपर्क साधा.",
    },
    {
        "name": "samaj_promo_offer",
        "language": "en_US",
        "bodyText": "Hi {name}, a special offer from our samaj community is "
                    "now available. Reply to this message on {mobile} to know more.",
    },
]


def get_ad_templates():
    """
    Return the list of available WhatsApp ad templates for the campaign wizard.

    Each template is a dict with:
        - name:     the Meta WhatsApp template name
        - language: the template language code (e.g. "mr", "en_US")
        - bodyText: a body text preview including placeholder indicators

    Returns:
        A list of template dicts (copies, safe for the caller to mutate).
    """
    return [dict(template) for template in AD_TEMPLATES]


# ---------------------------------------------------------------------------
# Audience Builder
# ---------------------------------------------------------------------------


def _address_en(value):
    """Extract the English text from a bilingual {en, mr} field (or plain string)."""
    if isinstance(value, dict):
        return value.get("en") or ""
    return value or ""


def _hof_name(doc):
    """Build a display name from firstName/middleName/lastName English parts."""
    parts = []
    for key in ("firstName", "middleName", "lastName"):
        value = doc.get(key) or {}
        if isinstance(value, dict):
            part = value.get("en") or ""
        else:
            part = value or ""
        part = part.strip()
        if part:
            parts.append(part)
    return " ".join(parts)


def get_hof_by_area(filters, collection):
    """
    Query registrations and return HOF (Head of Family) records for selection.

    Supports cascading multi-select filters. District, taluka, and surname group
    filters are applied via a MongoDB query ($in). The area filter is applied as a
    post-query Python filter because area is computed from address text (via
    classify_area) and is not a stored field.

    Args:
        filters: dict with optional keys, each a list[str] or None:
            "districts": e.g. ["Washim", "Amravati"]
            "talukas": e.g. ["Washim", "Malegaon", "Achalpur"]
            "surnameGroups": e.g. ["patil", "jadhav"] (matched lowercased)
            "areas": e.g. ["Civil Lines", "Lakhala (other)"] (post-filter)
        collection: MongoDB registrations collection.

    Returns:
        List of dicts with keys: _id (str), name, mobileNumber, district,
        taluka, surnameGroup, area. Deduplicated by mobile number.
    """
    from samaj.data_tools import classify_area

    filters = filters or {}

    # ---- Build MongoDB query using $in for provided filters ----
    query = {}

    districts = filters.get("districts")
    if districts:
        query["district"] = {"$in": list(districts)}

    talukas = filters.get("talukas")
    if talukas:
        query["taluka"] = {"$in": list(talukas)}

    surname_groups = filters.get("surnameGroups")
    if surname_groups:
        # surnameGroup is stored lowercased
        query["surnameGroup"] = {"$in": [str(s).lower() for s in surname_groups]}

    areas = filters.get("areas")
    area_filter = set(areas) if areas else None

    # ---- Query and post-filter ----
    results = []
    seen_mobiles = set()

    for doc in collection.find(query):
        addr1 = _address_en(doc.get("address1"))
        addr2 = _address_en(doc.get("address2"))
        area = classify_area(addr1, addr2)

        # Post-filter by computed area when an area filter is active
        if area_filter is not None and area not in area_filter:
            continue

        mobile = doc.get("mobileNumber")

        # Deduplicate by mobile number (keep first occurrence)
        if mobile:
            if mobile in seen_mobiles:
                continue
            seen_mobiles.add(mobile)

        results.append({
            "_id": str(doc.get("_id", "")),
            "name": _hof_name(doc),
            "mobileNumber": mobile or "",
            "district": doc.get("district") or "",
            "taluka": doc.get("taluka") or "",
            "surnameGroup": doc.get("surnameGroup") or "",
            "area": area,
        })

    return results


def resolve_recipients_by_ids(registration_ids, collection):
    """Resolve selected registration ids into recipient dicts server-side.

    Full mobile numbers are looked up from the registrations collection here so
    the browser never needs to receive or send them back. The campaign wizard
    sends only the selected registration ids; this function turns them into the
    recipient records ({registrationId, name, mobileNumber}) that get stored on
    the campaign for delivery.

    Order of the input ids is preserved and recipients are deduplicated by
    mobile number (keeping the first occurrence), mirroring get_hof_by_area.

    Args:
        registration_ids: list of registration id strings (or ObjectId-likes).
        collection: MongoDB registrations collection.

    Returns:
        List of {registrationId (str), name (str), mobileNumber (str)} dicts.
    """
    registration_ids = registration_ids or []

    raw_ids = []
    object_ids = []
    for rid in registration_ids:
        rid_str = str(rid).strip()
        if not rid_str:
            continue
        raw_ids.append(rid_str)
        try:
            object_ids.append(ObjectId(rid_str))
        except Exception:
            pass

    if not raw_ids:
        return []

    # Registrations use ObjectId _id values; fall back to raw string ids for
    # any non-ObjectId ids (defensive — keeps the lookup working either way).
    query_ids = list(object_ids) + [r for r in raw_ids]
    docs_by_id = {}
    for doc in collection.find({"_id": {"$in": query_ids}}):
        docs_by_id[str(doc.get("_id"))] = doc

    recipients = []
    seen_mobiles = set()
    for rid in raw_ids:
        doc = docs_by_id.get(rid)
        if not doc:
            continue
        mobile = doc.get("mobileNumber") or ""
        if mobile:
            if mobile in seen_mobiles:
                continue
            seen_mobiles.add(mobile)
        recipients.append({
            "registrationId": rid,
            "name": _hof_name(doc),
            "mobileNumber": mobile,
        })

    return recipients


def get_areas_with_counts(filters, collection):
    """
    Compute available areas with family counts for the Area filter dropdown.

    Queries registrations matching the district/taluka filters (MongoDB $in),
    classifies each document's address via classify_area() on address1+address2
    English text, and counts distinct mobile numbers (families) per area.

    Args:
        filters: dict with optional keys, each a list[str] or None:
            "districts": e.g. ["Washim", "Amravati"]
            "talukas": e.g. ["Washim", "Malegaon", "Achalpur"]
        collection: MongoDB registrations collection.

    Returns:
        Sorted list (by area name) of dicts {"name": str, "familyCount": int},
        excluding any area with a family count of 0. familyCount is the number
        of distinct mobile numbers classified to that area.
    """
    from samaj.data_tools import classify_area

    filters = filters or {}

    # ---- Build MongoDB query using $in for provided filters ----
    query = {}

    districts = filters.get("districts")
    if districts:
        query["district"] = {"$in": list(districts)}

    talukas = filters.get("talukas")
    if talukas:
        query["taluka"] = {"$in": list(talukas)}

    # ---- Query and classify, counting distinct mobiles per area ----
    # For performance, fetch only the fields needed for classification and
    # family counting (address1, address2, mobileNumber).
    projection = {"address1": 1, "address2": 1, "mobileNumber": 1}
    area_mobiles = {}

    for doc in collection.find(query, projection):
        addr1 = _address_en(doc.get("address1"))
        addr2 = _address_en(doc.get("address2"))
        area = classify_area(addr1, addr2)

        mobile = doc.get("mobileNumber")
        # A "family" is a distinct mobile number. Documents without a mobile
        # number cannot be counted as a distinct family, so skip them.
        if not mobile:
            continue

        area_mobiles.setdefault(area, set()).add(mobile)

    # ---- Build sorted result, excluding areas with 0 families ----
    results = [
        {"name": area, "familyCount": len(mobiles)}
        for area, mobiles in area_mobiles.items()
        if len(mobiles) > 0
    ]
    results.sort(key=lambda item: item["name"])
    return results


def get_distinct_surname_groups(filters, collection):
    """
    Return distinct surnameGroup values for the surname filter dropdown.

    Queries registrations matching the optional district/taluka filters
    (MongoDB $in) and collects the distinct surnameGroup values. surnameGroup
    is stored lowercased; values are title-cased for display. Empty/missing
    values are excluded.

    Args:
        filters: dict with optional keys, each a list[str] or None:
            "districts": e.g. ["Washim", "Amravati"]
            "talukas": e.g. ["Washim", "Malegaon", "Achalpur"]
        collection: MongoDB registrations collection.

    Returns:
        Sorted list of unique, title-cased surname group strings.
    """
    filters = filters or {}

    # ---- Build MongoDB query using $in for provided filters ----
    query = {}

    districts = filters.get("districts")
    if districts:
        query["district"] = {"$in": list(districts)}

    talukas = filters.get("talukas")
    if talukas:
        query["taluka"] = {"$in": list(talukas)}

    # ---- Collect distinct, title-cased surname groups ----
    groups = set()
    for doc in collection.find(query):
        raw = doc.get("surnameGroup")
        if not raw or not str(raw).strip():
            continue
        groups.add(str(raw).strip().title())

    return sorted(groups)


# ---------------------------------------------------------------------------
# Payment Service — Razorpay Signature Verification
# ---------------------------------------------------------------------------


def _get_razorpay_key_secret():
    """Return the configured Razorpay key secret.

    Reads from the Flask app config first (RAZORPAY_KEY_SECRET) and falls back
    to the RAZORPAY_KEY_SECRET environment variable. Returns an empty string
    when no secret is configured.
    """
    secret = ""
    try:
        secret = current_app.config.get("RAZORPAY_KEY_SECRET", "") or ""
    except RuntimeError:
        # Outside of an application context — fall back to the environment.
        secret = ""
    if not secret:
        secret = os.getenv("RAZORPAY_KEY_SECRET", "") or ""
    return secret


def razorpay_is_configured():
    """Return True when both the Razorpay key id and secret are configured.

    Used to give a clear "payments not configured" error instead of letting an
    empty-credential request reach Razorpay and fail with "Authentication
    failed".
    """
    return bool(_get_razorpay_key_id()) and bool(_get_razorpay_key_secret())


def verify_razorpay_signature(order_id, payment_id, signature, key_secret=None):
    """
    Verify a Razorpay payment signature using HMAC-SHA256.

    Razorpay signs the payment by computing
    HMAC-SHA256("{order_id}|{payment_id}", key_secret) and returning the
    hexadecimal digest as ``razorpay_signature``. This recomputes that digest
    using the configured key secret and compares it against the provided
    signature in constant time.

    Args:
        order_id: The Razorpay order id (e.g. "order_XXXX").
        payment_id: The Razorpay payment id (e.g. "pay_XXXX").
        signature: The signature returned by Razorpay Checkout to verify.
        key_secret: Optional override for the Razorpay key secret. When omitted,
            the secret is read from app config / environment.

    Returns:
        True if the signature is valid, False otherwise.
    """
    if key_secret is None:
        key_secret = _get_razorpay_key_secret()

    if not order_id or not payment_id or not signature or not key_secret:
        return False

    message = f"{order_id}|{payment_id}"
    expected = hmac.new(
        key_secret.encode("utf-8"),
        message.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

    return hmac.compare_digest(expected, str(signature))


# ---------------------------------------------------------------------------
# Payment Service — Razorpay Order Creation & Campaign Creation
# ---------------------------------------------------------------------------


def _get_razorpay_key_id():
    """Return the configured Razorpay key id.

    Reads from the Flask app config first (RAZORPAY_KEY_ID) and falls back to
    the RAZORPAY_KEY_ID environment variable. Returns an empty string when no
    key id is configured.
    """
    key_id = ""
    try:
        key_id = current_app.config.get("RAZORPAY_KEY_ID", "") or ""
    except RuntimeError:
        # Outside of an application context — fall back to the environment.
        key_id = ""
    if not key_id:
        key_id = os.getenv("RAZORPAY_KEY_ID", "") or ""
    return key_id


def _get_razorpay_client():
    """Build and return a Razorpay API client authenticated with the configured
    key id / secret.

    The razorpay SDK is imported lazily so the rest of the campaign module can
    be used (and tested) without the dependency installed.
    """
    import razorpay

    key_id = _get_razorpay_key_id()
    key_secret = _get_razorpay_key_secret()
    return razorpay.Client(auth=(key_id, key_secret))


def create_razorpay_order(amount_paise, campaign_id):
    """Create a Razorpay order for a campaign payment.

    Args:
        amount_paise: Order amount in paise (recipientCount × 100).
        campaign_id: The campaign's ObjectId (or its string form), used to
            build the order receipt and notes for reconciliation.

    Returns:
        The raw Razorpay order dict, which includes at least an ``id`` key
        (e.g. "order_XXXX") and the ``amount``/``currency`` fields.

    Raises:
        Any exception raised by the Razorpay SDK (network/API failure) is
        allowed to propagate so the caller can avoid persisting any records.
    """
    client = _get_razorpay_client()
    return client.order.create({
        "amount": amount_paise,
        "currency": "INR",
        "receipt": f"campaign_{campaign_id}",
        "notes": {
            "campaign_id": str(campaign_id),
        },
    })


def create_campaign_with_payment(
    account_id,
    recipients,
    template_name,
    template_language=None,
    body_vars_template=None,
    audience_filters=None,
    name=None,
):
    """Create a campaign and its associated Razorpay payment order.

    Validates the recipient list, creates the Razorpay order first (so a
    network/API failure leaves no campaign or payment records behind), then
    persists the campaign document (status "pending_payment") and the linked
    campaign_payment record (status "created").

    Args:
        account_id: The campaigner's public_account id (string or ObjectId).
        recipients: List of recipient dicts ({registrationId, name,
            mobileNumber}). Must be non-empty.
        template_name: The selected WhatsApp template name.
        template_language: The selected template language code (defaults to
            "en_US" when not provided).
        body_vars_template: List of template body variables/placeholders.
        audience_filters: The filters used during recipient selection, stored
            for reference.
        name: Optional human-readable campaign name. Auto-generated when omitted.

    Returns:
        dict with keys: campaignId (str), razorpayOrderId (str), amount (int,
        paise), razorpayKey (str).

    Raises:
        ValueError: If the recipients list is empty (Requirement 9.4).
        Exception: Propagated from create_razorpay_order on API/network failure.
            No campaign or payment records are persisted in that case
            (Requirement 14.1).
    """
    recipients = recipients or []
    recipient_count = len(recipients)

    # Requirement 9.4: reject empty recipient lists before doing any work.
    if recipient_count == 0:
        raise ValueError("At least 1 recipient is required.")

    # Requirements 5.2, 9.1, 9.2: ₹1 (100 paise) per recipient.
    amount_paise = recipient_count * 100

    # Pre-generate the campaign id so it can be referenced in the Razorpay
    # order receipt, and used to link the payment record, without persisting
    # anything until the order is successfully created.
    campaign_id = ObjectId()

    # Create the Razorpay order FIRST. If this raises (network/API failure),
    # the exception propagates and no campaign/payment documents are written
    # (Requirement 14.1).
    razorpay_order = create_razorpay_order(amount_paise, campaign_id)
    razorpay_order_id = razorpay_order["id"]

    now = datetime.now(timezone.utc)

    # Persist the account id as an ObjectId for consistency with the campaign
    # listing endpoint, falling back to the raw value if it is not a valid id.
    try:
        account_object_id = ObjectId(str(account_id))
    except Exception:
        account_object_id = account_id

    campaign_name = name or f"Campaign {now.strftime('%d %b %Y %H:%M')}"

    # Step: create the campaign document with status "pending_payment".
    campaign_doc = {
        "_id": campaign_id,
        "name": campaign_name,
        "accountId": account_object_id,
        "templateName": template_name,
        "templateLanguage": template_language or "en_US",
        "bodyVarsTemplate": body_vars_template or [],
        "recipients": recipients,
        "recipientCount": recipient_count,
        "audienceFilters": audience_filters or {},
        "paymentId": None,
        "status": PENDING_PAYMENT,
        "stats": {
            "totalRecipients": recipient_count,
            "sent": 0,
            "failed": 0,
            "pending": recipient_count,
        },
        "createdAt": now,
        "updatedAt": now,
        "sentAt": None,
    }
    campaigns = get_campaigns_collection()
    campaigns.insert_one(campaign_doc)

    # Step: create the campaign_payment record with status "created".
    payment_doc = {
        "campaignId": campaign_id,
        "accountId": account_object_id,
        "razorpayOrderId": razorpay_order_id,
        "razorpayPaymentId": None,
        "razorpaySignature": None,
        "amount": amount_paise,
        "currency": "INR",
        "recipientCount": recipient_count,
        "status": "created",
        "webhookEvent": None,
        "createdAt": now,
        "capturedAt": None,
        "updatedAt": now,
    }
    payments = get_campaign_payments_collection()
    payment_result = payments.insert_one(payment_doc)

    # Step: link the payment record back to the campaign.
    campaigns.update_one(
        {"_id": campaign_id},
        {"$set": {"paymentId": payment_result.inserted_id, "updatedAt": now}},
    )

    return {
        "campaignId": str(campaign_id),
        "razorpayOrderId": razorpay_order_id,
        "amount": amount_paise,
        "razorpayKey": _get_razorpay_key_id(),
    }


# ---------------------------------------------------------------------------
# WhatsApp Delivery Service — Single Template Message (Task 7.3)
# ---------------------------------------------------------------------------

# Maximum length (in characters) for a stored delivery error description.
# Requirement 7.3: failure reasons are recorded with no more than 500 chars.
_MAX_ERROR_LEN = 500


def _truncate_error(message):
    """Truncate an error description to at most 500 characters (Requirement 7.3)."""
    text = "" if message is None else str(message)
    if len(text) > _MAX_ERROR_LEN:
        return text[:_MAX_ERROR_LEN]
    return text


def send_single_template_message(
    to,
    template_name,
    language,
    body_vars,
    access_token,
    phone_number_id,
):
    """Send one WhatsApp template message via the Meta Graph API v24.0.

    POSTs a template message to the Meta Cloud API ``/messages`` endpoint,
    mirroring the existing OTP integration (Graph API v24.0, Bearer auth,
    template payload with a body component). The recipient's resolved body
    variables are passed as positional body text parameters.

    Args:
        to: The recipient phone number (normalized, e.g. "91XXXXXXXXXX").
        template_name: The Meta WhatsApp template name.
        language: The template language code (e.g. "en_US", "mr").
        body_vars: List of resolved body variable strings (in order).
        access_token: Meta WhatsApp access token (Bearer).
        phone_number_id: Meta WhatsApp phone number id (path segment).

    Returns:
        A tuple ``(success, message_id, error)``:
            success (bool): True when the message was accepted by the API.
            message_id (str | None): The WhatsApp message id on success, else None.
            error (str | None): An error description (<= 500 chars) on failure,
                else None.

    Notes:
        - On HTTP 429 (rate limit) or any other non-OK response, the message is
          marked failed and the error is returned so the caller can continue
          processing remaining recipients (Requirements 7.3, 14.4).
        - Network/exception failures are caught and returned as an error string
          rather than raised, so a single failure never aborts a campaign run.
    """
    import requests

    # Build the template body component from the resolved body variables.
    components = []
    if body_vars:
        components.append({
            "type": "body",
            "parameters": [
                {"type": "text", "text": str(var)} for var in body_vars
            ],
        })

    payload = {
        "messaging_product": "whatsapp",
        "to": str(to).replace("+", ""),
        "type": "template",
        "template": {
            "name": template_name,
            "language": {"code": language or "en_US"},
            "components": components,
        },
    }

    try:
        response = requests.post(
            f"https://graph.facebook.com/v24.0/{phone_number_id}/messages",
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=15,
        )
    except Exception as exc:  # network failure, timeout, etc.
        return False, None, _truncate_error(f"Request failed: {exc}")

    # Non-OK responses (including HTTP 429 rate limit) are treated as a failure
    # for this individual message; the caller continues with the next recipient.
    if not response.ok:
        try:
            error_body = response.json()
            error = error_body.get("error") or {}
            detail = (
                error.get("message")
                or error.get("error_user_msg")
                or str(error_body)
            )
        except Exception:
            detail = response.text or response.reason or ""

        if response.status_code == 429:
            detail = f"Rate limited (HTTP 429): {detail}"
        else:
            detail = f"WhatsApp API error ({response.status_code}): {detail}"

        return False, None, _truncate_error(detail)

    # Success — extract the WhatsApp message id from the response body.
    try:
        body = response.json()
    except Exception as exc:
        return False, None, _truncate_error(f"Invalid API response: {exc}")

    message_id = ((body.get("messages") or [{}])[0]).get("id") or None
    if not message_id:
        return False, None, _truncate_error(
            f"WhatsApp API returned no message id: {body}"
        )

    return True, message_id, None


# ---------------------------------------------------------------------------
# WhatsApp Delivery Service — Campaign Execution (Task 7.2)
# ---------------------------------------------------------------------------

# Settings document key and collection name mirror the OTP settings storage in
# samaj/app.py (app_settings collection, document keyed by "otp_settings", with
# a nested "metaWhatsApp" object holding the Meta WhatsApp credentials).
_SETTINGS_COLLECTION_NAME = "app_settings"
_OTP_SETTINGS_KEY = "otp_settings"


def _get_settings_collection():
    """Return the 'app_settings' MongoDB collection (OTP / WhatsApp settings)."""
    return _get_database()[_SETTINGS_COLLECTION_NAME]


def load_whatsapp_settings():
    """Load Meta WhatsApp delivery credentials from the settings collection.

    Reads the OTP settings document (key "otp_settings") and extracts the
    nested ``metaWhatsApp`` credentials, mirroring the existing OTP integration
    in ``samaj/app.py``. Falls back to the ``WA_TOKEN`` / ``WA_PHONE_ID``
    environment variables when the stored values are absent.

    Returns:
        dict with keys ``accessToken`` and ``phoneNumberId`` (each a string,
        possibly empty when not configured).
    """
    access_token = ""
    phone_number_id = ""

    try:
        settings_doc = (
            _get_settings_collection().find_one({"key": _OTP_SETTINGS_KEY})
            or {}
        )
    except Exception:
        settings_doc = {}

    meta = settings_doc.get("metaWhatsApp") or {}
    access_token = meta.get("accessToken") or os.getenv("WA_TOKEN", "") or ""
    phone_number_id = (
        meta.get("phoneNumberId") or os.getenv("WA_PHONE_ID", "") or ""
    )

    return {"accessToken": access_token, "phoneNumberId": phone_number_id}


def _to_object_id(value):
    """Best-effort conversion of a value to ObjectId, returning the raw value
    unchanged when it is not a valid 24-char hex id."""
    if isinstance(value, ObjectId):
        return value
    try:
        return ObjectId(str(value))
    except Exception:
        return value


def execute_campaign_send(campaign):
    """Send a paid campaign's WhatsApp template messages to every recipient.

    Called only after payment is confirmed (Razorpay webhook ``payment.captured``).
    The campaign status is moved to "sending", every recipient is processed
    exactly once (creating one ``campaign_message`` record each), and the
    campaign is finalized to "sent" (if at least one message succeeded) or
    "failed" (if all messages failed). Campaign stats are recorded on the
    campaign document.

    Args:
        campaign: The campaign document dict (must contain ``_id``,
            ``recipients``, ``templateName``, ``templateLanguage``, and
            optionally ``bodyVarsTemplate``).

    Returns:
        dict with keys ``sent``, ``failed``, and ``total``.

    Notes:
        - Requirement 14.3: when WhatsApp credentials are not configured, the
          campaign is marked "failed" and a failed ``campaign_message`` record
          with error "WhatsApp not configured" is created for every recipient.
        - Requirement 12.2 / 12.3: recipients with missing or invalid mobile
          numbers are marked failed (without an API call) and processing
          continues.
        - Requirement 14.4: individual rate-limit / API failures are recorded
          as failed messages and never abort the run.
    """
    campaigns = get_campaigns_collection()
    messages = get_campaign_messages_collection()

    # Accept either a campaign document dict or a campaign id (ObjectId/str).
    # The webhook handler (task 7.1) triggers execution by campaign id, while
    # direct callers (and unit tests) may pass the already-loaded document.
    if not isinstance(campaign, dict):
        campaign = campaigns.find_one({"_id": _to_object_id(campaign)})
        if campaign is None:
            # Unknown campaign id — nothing to send.
            return {"sent": 0, "failed": 0, "total": 0}

    campaign_id = campaign.get("_id")
    recipients = campaign.get("recipients") or []
    total = len(recipients)

    # Step 1: Mark the campaign as "sending". Requirement 10.3 requires a
    # campaign reach "payment_verified" before "sending"; if the campaign is
    # still "pending_payment" (webhook path), advance it through the valid
    # transition first.
    current_status = campaign.get("status")
    now = datetime.now(timezone.utc)

    if current_status == PENDING_PAYMENT:
        campaigns.update_one(
            {"_id": campaign_id},
            {"$set": {"status": PAYMENT_VERIFIED, "updatedAt": now}},
        )
        current_status = PAYMENT_VERIFIED

    transition = validate_campaign_status_transition(current_status, SENDING)
    if not transition["valid"]:
        # The campaign is not in a state from which it may be sent. Leave it
        # unchanged (Requirement 10.2) and report nothing sent.
        return {"sent": 0, "failed": 0, "total": total}

    campaigns.update_one(
        {"_id": campaign_id},
        {"$set": {"status": SENDING, "updatedAt": now}},
    )

    # Step 2: Load WhatsApp credentials.
    wa_settings = load_whatsapp_settings()
    access_token = wa_settings.get("accessToken") or ""
    phone_number_id = wa_settings.get("phoneNumberId") or ""
    credentials_missing = not access_token or not phone_number_id

    template_name = campaign.get("templateName")
    template_language = campaign.get("templateLanguage") or "en_US"
    body_vars_template = campaign.get("bodyVarsTemplate") or []

    sent = 0
    failed = 0

    # Step 3: Process every recipient exactly once.
    for recipient in recipients:
        mobile_raw = recipient.get("mobileNumber")
        success = False
        message_id = None
        error = None
        normalized = None

        if credentials_missing:
            # Requirement 14.3: credentials not configured -> every recipient
            # fails with a fixed error and no API call is made.
            error = "WhatsApp not configured"
        elif not mobile_raw or not str(mobile_raw).strip():
            # Requirement 12.3: missing mobile number -> skip delivery.
            error = "Missing mobile number"
        else:
            normalized = normalize_wa_number(mobile_raw)
            if not normalized:
                # Requirement 12.2: invalid mobile number format.
                error = "Invalid mobile number format"
            else:
                body_vars = resolve_body_vars(body_vars_template, recipient)
                success, message_id, error = send_single_template_message(
                    to=normalized,
                    template_name=template_name,
                    language=template_language,
                    body_vars=body_vars,
                    access_token=access_token,
                    phone_number_id=phone_number_id,
                )

        msg_now = datetime.now(timezone.utc)
        # Persist the normalized mobile when available, else the raw value so
        # the report can still display something for invalid entries.
        recorded_mobile = normalized or (mobile_raw or "")

        messages.insert_one({
            "campaignId": campaign_id,
            "recipientMobile": recorded_mobile,
            "recipientName": recipient.get("name") or "",
            "registrationId": _to_object_id(recipient.get("registrationId")),
            "waMessageId": message_id if success else None,
            "status": SENT if success else FAILED,
            "error": None if success else _truncate_error(error),
            "sentAt": msg_now if success else None,
            "createdAt": msg_now,
        })

        if success:
            sent += 1
        else:
            failed += 1

    # Step 4: Finalize the campaign. Requirement 6.5: "sent" if at least one
    # message succeeded, otherwise "failed". An empty recipient list yields
    # "failed" (nothing succeeded).
    final_status = SENT if sent > 0 else FAILED
    finalize_now = datetime.now(timezone.utc)

    campaigns.update_one(
        {"_id": campaign_id},
        {"$set": {
            "status": final_status,
            "stats": {
                "totalRecipients": total,
                "sent": sent,
                "failed": failed,
                "pending": 0,
            },
            "sentAt": finalize_now,
            "updatedAt": finalize_now,
        }},
    )

    # Requirement 7.4: the number of campaign_message records must equal the
    # campaign's total recipient count; log a warning if they diverge.
    if sent + failed != total:
        try:
            current_app.logger.warning(
                "Campaign %s message count mismatch: processed %s, expected %s",
                campaign_id, sent + failed, total,
            )
        except Exception:
            pass

    return {"sent": sent, "failed": failed, "total": total}


# ---------------------------------------------------------------------------
# Payment Service — Razorpay Webhook Handling (Task 7.1)
# ---------------------------------------------------------------------------


def _get_razorpay_webhook_secret():
    """Return the configured Razorpay webhook secret.

    Reads from the Flask app config first (RAZORPAY_WEBHOOK_SECRET) and falls
    back to the RAZORPAY_WEBHOOK_SECRET environment variable. Returns an empty
    string when no secret is configured.
    """
    secret = ""
    try:
        secret = current_app.config.get("RAZORPAY_WEBHOOK_SECRET", "") or ""
    except RuntimeError:
        # Outside of an application context — fall back to the environment.
        secret = ""
    if not secret:
        secret = os.getenv("RAZORPAY_WEBHOOK_SECRET", "") or ""
    return secret


def verify_razorpay_webhook_signature(raw_body, signature, webhook_secret=None):
    """
    Verify a Razorpay webhook signature using HMAC-SHA256.

    Razorpay signs each webhook delivery by computing
    HMAC-SHA256(raw_request_body, webhook_secret) and sending the hexadecimal
    digest in the ``X-Razorpay-Signature`` header. This recomputes that digest
    over the exact raw request body and compares it against the provided
    signature in constant time.

    Args:
        raw_body: The raw webhook request body, as ``bytes`` or ``str``. The
            signature must be computed over the unmodified bytes Razorpay sent.
        signature: The value of the ``X-Razorpay-Signature`` header.
        webhook_secret: Optional override for the webhook secret. When omitted,
            the secret is read from app config / environment.

    Returns:
        True if the signature is valid, False otherwise.
    """
    if webhook_secret is None:
        webhook_secret = _get_razorpay_webhook_secret()

    if not raw_body or not signature or not webhook_secret:
        return False

    body_bytes = raw_body.encode("utf-8") if isinstance(raw_body, str) else raw_body

    expected = hmac.new(
        webhook_secret.encode("utf-8"),
        body_bytes,
        hashlib.sha256,
    ).hexdigest()

    return hmac.compare_digest(expected, str(signature))


def process_razorpay_webhook(raw_body, signature, webhook_secret=None):
    """
    Process a Razorpay webhook delivery and trigger campaign execution.

    Verifies the webhook signature, parses ``payment.captured`` events,
    locates the matching campaign_payment by ``razorpayOrderId``, marks it as
    captured, transitions the linked campaign towards sending, and triggers
    message delivery via ``execute_campaign_send``.

    The behavior is idempotent: a duplicate webhook for a payment that is
    already "captured" returns success without re-executing the campaign.

    Args:
        raw_body: The raw webhook request body (``bytes`` or ``str``). The
            signature is verified against these exact bytes.
        signature: The ``X-Razorpay-Signature`` header value.
        webhook_secret: Optional override for the webhook secret. When omitted,
            the secret is read from app config / environment.

    Returns:
        dict with keys:
            "ok" (bool): True when the request was accepted (HTTP 200), False
                only when the signature is invalid (HTTP 400).
            "status" (int): The HTTP status code the endpoint should return.
            "reason" (str): A short machine-readable reason for the outcome.

    Requirements: 6.1, 6.2, 6.3, 6.6, 6.7.
    """
    # ---- Requirements 6.1, 6.2: verify the signature first ----
    if not verify_razorpay_webhook_signature(raw_body, signature, webhook_secret):
        # Invalid signature: reject with 400 and make no database changes.
        return {"ok": False, "status": 400, "reason": "invalid_signature"}

    # ---- Parse the JSON payload ----
    try:
        if isinstance(raw_body, bytes):
            payload = json.loads(raw_body.decode("utf-8"))
        elif isinstance(raw_body, str):
            payload = json.loads(raw_body)
        else:
            # Already a parsed mapping (defensive — supports dict input).
            payload = raw_body
    except (ValueError, TypeError):
        return {"ok": False, "status": 400, "reason": "invalid_payload"}

    if not isinstance(payload, dict):
        return {"ok": False, "status": 400, "reason": "invalid_payload"}

    # ---- Only handle payment.captured events (Requirement 6.3) ----
    if payload.get("event") != "payment.captured":
        # Other events are acknowledged with 200 and ignored.
        return {"ok": True, "status": 200, "reason": "ignored_event"}

    entity = (
        ((payload.get("payload") or {}).get("payment") or {}).get("entity") or {}
    )
    order_id = entity.get("order_id")
    payment_id = entity.get("id")

    if not order_id:
        # Malformed event without an order id — acknowledge, change nothing.
        return {"ok": True, "status": 200, "reason": "missing_order_id"}

    payments = get_campaign_payments_collection()
    payment = payments.find_one({"razorpayOrderId": order_id})

    # ---- Requirement 6.7: unknown order id — 200 OK, no DB changes ----
    if payment is None:
        return {"ok": True, "status": 200, "reason": "order_not_found"}

    # ---- Requirement 6.6: idempotency for duplicate webhooks ----
    if payment.get("status") == "captured":
        return {"ok": True, "status": 200, "reason": "already_captured"}

    now = datetime.now(timezone.utc)
    campaign_id = payment.get("campaignId")

    # ---- Requirement 6.3: mark the payment captured and link the payment ----
    payments.update_one(
        {"razorpayOrderId": order_id},
        {"$set": {
            "status": "captured",
            "razorpayPaymentId": payment_id,
            "webhookEvent": payload,
            "capturedAt": now,
            "updatedAt": now,
        }},
    )

    # ---- Requirement 10.3: transition pending_payment -> payment_verified ----
    # before the campaign can move to "sending". When the client-side verify
    # step has already advanced the campaign to "payment_verified", this is a
    # no-op and execution proceeds.
    campaigns = get_campaigns_collection()
    campaign_doc = campaigns.find_one({"_id": campaign_id})
    if campaign_doc is not None and campaign_doc.get("status") == PENDING_PAYMENT:
        transition = validate_campaign_status_transition(
            PENDING_PAYMENT, PAYMENT_VERIFIED
        )
        if transition["valid"]:
            campaigns.update_one(
                {"_id": campaign_id},
                {"$set": {"status": PAYMENT_VERIFIED, "updatedAt": now}},
            )

    # ---- Requirement 6.3/6.4: trigger campaign message sending ----
    # Delivery (execute_campaign_send, task 7.2) handles its own status
    # transitions and finalization. A failure during delivery must not cause
    # the webhook to be re-delivered (the payment is already captured and the
    # idempotency guard above protects against re-execution), so any error is
    # swallowed and reported in the response reason.
    try:
        execute_campaign_send(campaign_id)
    except Exception as exc:  # noqa: BLE001 — delivery errors must not 4xx/5xx
        return {
            "ok": True,
            "status": 200,
            "reason": "captured_send_error",
            "error": str(exc),
        }

    return {"ok": True, "status": 200, "reason": "processed"}


# ---------------------------------------------------------------------------
# Delivery Report (Task 11.4)
# ---------------------------------------------------------------------------


def mask_mobile(mobile):
    """Mask a mobile number so only the last 4 digits remain visible.

    Every character preceding the final four is replaced with an asterisk
    (Requirement 8.2). Numbers with four or fewer characters are returned
    unchanged since there are no preceding digits to mask.

    Args:
        mobile: The mobile number string (any format/length).

    Returns:
        The masked string, e.g. "919876543210" -> "********3210". An empty
        string is returned for empty/None input.
    """
    if not mobile:
        return ""
    digits = str(mobile)
    if len(digits) <= 4:
        return digits
    return ("*" * (len(digits) - 4)) + digits[-4:]


def _message_timestamp(message):
    """Return the UTC delivery-attempt timestamp for a campaign_message.

    Prefers ``sentAt`` (the moment of the delivery attempt) and falls back to
    ``createdAt`` when the message has no sent timestamp yet. Datetime values
    are serialized to ISO-8601 strings; missing values yield None
    (Requirement 8.2).
    """
    timestamp = message.get("sentAt") or message.get("createdAt")
    if isinstance(timestamp, datetime):
        return timestamp.isoformat()
    return timestamp


def build_campaign_report(campaign_doc, messages_collection):
    """Build a delivery report for a single campaign.

    Aggregates the campaign_message records belonging to the campaign into
    summary statistics and a per-recipient status list with masked mobile
    numbers (Requirements 8.1, 8.2).

    Args:
        campaign_doc: The campaign document (used for the total recipient
            count and campaign id).
        messages_collection: The campaign_messages MongoDB collection.

    Returns:
        dict with keys:
            "stats": {"total": int, "sent": int, "failed": int, "pending": int}
            "recipients": list of dicts with keys:
                "name" (str), "mobile" (masked str), "status" (str),
                "timestamp" (ISO-8601 UTC str | None)
    """
    campaign_id = campaign_doc.get("_id")

    messages = list(messages_collection.find({"campaignId": campaign_id}))

    sent = 0
    failed = 0
    recipients = []

    for message in messages:
        status = message.get("status") or "pending"
        if status == SENT:
            sent += 1
        elif status == FAILED:
            failed += 1

        recipients.append({
            "name": message.get("recipientName") or "",
            "mobile": mask_mobile(message.get("recipientMobile")),
            "status": status,
            "timestamp": _message_timestamp(message),
        })

    # Total recipients comes from the campaign document so that recipients who
    # have not yet had a campaign_message created (delivery not started) are
    # still reflected as pending (Requirement 8.1).
    stats_block = campaign_doc.get("stats") or {}
    total = (
        campaign_doc.get("recipientCount")
        or stats_block.get("totalRecipients")
        or len(messages)
    )

    pending = total - sent - failed
    if pending < 0:
        pending = 0

    return {
        "stats": {
            "total": total,
            "sent": sent,
            "failed": failed,
            "pending": pending,
        },
        "recipients": recipients,
    }
