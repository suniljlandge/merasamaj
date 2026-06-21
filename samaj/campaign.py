"""Campaign Manager module.

Provides MongoDB collection accessors, status constants, and data model
helpers for the WhatsApp Ads Campaign feature.
"""

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
REJECTED = "rejected"

# Valid status transitions as a dict mapping current -> set of allowed targets.
_VALID_TRANSITIONS = {
    PENDING_PAYMENT: {PAYMENT_VERIFIED, REJECTED},
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


# Salutation options offered as a per-family toggle during recipient
# selection. The toggle "answer" (one of these keys) is stored on each
# recipient and resolved into the {salutation} template variable at send time.
#   - "shri-sau"     -> addresses the head of family couple (Mr. & Mrs.)
#   - "sah-parivaar" -> addresses the whole family ("and family")
SALUTATION_SHRI_SAU = "shri-sau"
SALUTATION_SAH_PARIVAAR = "sah-parivaar"

_SALUTATION_TEXT = {
    SALUTATION_SHRI_SAU: "श्री व सौ.",
    SALUTATION_SAH_PARIVAAR: "सह परिवार",
}

# Default salutation used when a recipient has no explicit choice.
DEFAULT_SALUTATION = SALUTATION_SHRI_SAU


def salutation_text(salutation):
    """Resolve a salutation toggle answer into its display text.

    Accepts one of the SALUTATION_* keys (e.g. "shri-sau", "sah-parivaar").
    Unknown/empty values fall back to the default salutation so the template
    variable is never blank.

    Args:
        salutation: The stored toggle answer (key string) or None.

    Returns:
        The Marathi salutation text for the chosen option.
    """
    key = (salutation or DEFAULT_SALUTATION)
    return _SALUTATION_TEXT.get(key, _SALUTATION_TEXT[DEFAULT_SALUTATION])


def resolve_body_vars(template_vars, recipient):
    """
    Replace placeholders in template variables with recipient data.

    Recognized placeholders:
        - {name}       -> recipient's name
        - {salutation} -> recipient's salutation (श्री व सौ. / सह परिवार)
        - {mobile}     -> recipient's normalized mobile number (91XXXXXXXXXX)

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
        elif entry == "{salutation}":
            result.append(salutation_text(recipient.get("salutation")))
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
        "language": "hi",
        "bodyText": "नमस्कार {name} {salutation}, आपको अपने समाज के आगामी "
                    "कार्यक्रम के लिए सहर्ष निमंत्रण. अधिक जानकारी के लिए "
                    "संपर्क करें.",
    },
    {
        "name": "samaj_promo_offer",
        "language": "en_US",
        "bodyText": "Hi {name} {salutation}, a special offer from our samaj "
                    "community is now available. Reply to this message on "
                    "{mobile} to know more.",
    },
    {
        "name": "samaj_wedding_invite",
        "language": "hi",
        "bodyText": "नमस्कार {name}, हमारे परिवार में एक शुभ विवाह समारोह "
                "का आयोजन हो रहा है. आपको {salutation} सादर आमंत्रित "
                "किया जाता है. आपकी उपस्थिति हमारे लिए सौभाग्य की बात "
                "होगी. समय और स्थान की जानकारी नीचे संलग्न निमंत्रण "
                "पत्र में दी गई है.",
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
            "membersCount": _family_members_count(doc),
        })

    return results


def _family_members_count(doc):
    """Return the total number of members in a family record.

    A family's total is the head of family (the applicant) plus every entry in
    the ``familyMembers`` array. Always at least 1 (the applicant), even when
    no additional members are recorded.
    """
    family_members = doc.get("familyMembers")
    extra = len(family_members) if isinstance(family_members, list) else 0
    return extra + 1


def resolve_recipients_by_ids(registration_ids, collection, salutations=None):
    """Resolve selected registration ids into recipient dicts server-side.

    Full mobile numbers are looked up from the registrations collection here so
    the browser never needs to receive or send them back. The campaign wizard
    sends only the selected registration ids; this function turns them into the
    recipient records ({registrationId, name, mobileNumber, salutation}) that
    get stored on the campaign for delivery.

    Order of the input ids is preserved and recipients are deduplicated by
    mobile number (keeping the first occurrence), mirroring get_hof_by_area.

    Args:
        registration_ids: list of registration id strings (or ObjectId-likes).
        collection: MongoDB registrations collection.
        salutations: optional dict mapping registration id -> salutation toggle
            answer ("shri-sau" / "sah-parivaar"). Ids without an entry fall back
            to the default salutation.

    Returns:
        List of {registrationId (str), name (str), mobileNumber (str),
        salutation (str)} dicts.
    """
    registration_ids = registration_ids or []
    salutations = salutations or {}

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
        chosen = salutations.get(rid) or DEFAULT_SALUTATION
        if chosen not in _SALUTATION_TEXT:
            chosen = DEFAULT_SALUTATION
        recipients.append({
            "registrationId": rid,
            "name": _hof_name(doc),
            "mobileNumber": mobile,
            "salutation": chosen,
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
# Payment Service — UPI QR Code + Manual Verification
# ---------------------------------------------------------------------------


def _get_upi_id():
    """Return the configured UPI ID (VPA) for receiving payments.

    Reads from Flask app config first (UPI_ID), falls back to the UPI_ID
    environment variable. Returns an empty string when not configured.
    """
    upi_id = ""
    try:
        upi_id = current_app.config.get("UPI_ID", "") or ""
    except RuntimeError:
        upi_id = ""
    if not upi_id:
        upi_id = os.getenv("UPI_ID", "") or ""
    return upi_id


def _get_upi_payee_name():
    """Return the configured UPI payee display name.

    Reads from Flask app config first (UPI_PAYEE_NAME), falls back to the
    UPI_PAYEE_NAME environment variable. Defaults to "SAMAJ".
    """
    name = ""
    try:
        name = current_app.config.get("UPI_PAYEE_NAME", "") or ""
    except RuntimeError:
        name = ""
    if not name:
        name = os.getenv("UPI_PAYEE_NAME", "") or "SAMAJ"
    return name


def upi_is_configured():
    """Return True when a UPI ID is configured for receiving payments."""
    return bool(_get_upi_id())


def build_upi_link(amount_rupees, transaction_note):
    """Build a UPI deep-link URL for the given amount and note.

    Format: upi://pay?pa=<VPA>&pn=<Name>&am=<Amount>&cu=INR&tn=<Note>

    Args:
        amount_rupees: Payment amount in rupees (integer).
        transaction_note: A short note to identify the payment (e.g.
            "Campaign-abc123"). This helps the admin match the payment
            in their UPI app.

    Returns:
        The UPI deep-link string, or empty string if UPI is not configured.
    """
    from urllib.parse import quote

    upi_id = _get_upi_id()
    if not upi_id:
        return ""

    payee_name = _get_upi_payee_name()

    return (
        f"upi://pay?"
        f"pa={quote(upi_id)}"
        f"&pn={quote(payee_name)}"
        f"&am={amount_rupees}"
        f"&cu=INR"
        f"&tn={quote(str(transaction_note))}"
    )


def create_campaign_with_upi(
    account_id,
    recipients,
    template_name,
    template_language=None,
    body_vars_template=None,
    audience_filters=None,
    name=None,
):
    """Create a campaign and generate a UPI payment link for it.

    Validates the recipient list, persists the campaign document (status
    "pending_payment") and the linked campaign_payment record (status
    "awaiting_upi"), and returns the UPI deep-link for the user to pay.

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
        dict with keys: campaignId (str), upiLink (str), amount (int, rupees),
        transactionNote (str).

    Raises:
        ValueError: If the recipients list is empty.
    """
    recipients = recipients or []
    recipient_count = len(recipients)

    if recipient_count == 0:
        raise ValueError("At least 1 recipient is required.")

    # ₹1 per recipient.
    amount_rupees = recipient_count

    campaign_id = ObjectId()

    # Short transaction note for easy identification in the bank app.
    short_id = str(campaign_id)[-8:]
    transaction_note = f"Campaign-{short_id}"

    upi_link = build_upi_link(amount_rupees, transaction_note)

    now = datetime.now(timezone.utc)

    try:
        account_object_id = ObjectId(str(account_id))
    except Exception:
        account_object_id = account_id

    campaign_name = name or f"Campaign {now.strftime('%d %b %Y %H:%M')}"

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

    payment_doc = {
        "campaignId": campaign_id,
        "accountId": account_object_id,
        "upiLink": upi_link,
        "transactionNote": transaction_note,
        "upiTransactionRef": None,
        "amount": amount_rupees * 100,  # Store in paise for consistency.
        "amountRupees": amount_rupees,
        "currency": "INR",
        "recipientCount": recipient_count,
        "status": "awaiting_upi",
        "createdAt": now,
        "confirmedAt": None,
        "updatedAt": now,
    }
    payments = get_campaign_payments_collection()
    payment_result = payments.insert_one(payment_doc)

    campaigns.update_one(
        {"_id": campaign_id},
        {"$set": {"paymentId": payment_result.inserted_id, "updatedAt": now}},
    )

    return {
        "campaignId": str(campaign_id),
        "upiLink": upi_link,
        "amount": amount_rupees,
        "transactionNote": transaction_note,
    }


def submit_upi_reference(campaign_id, upi_ref):
    """Record the user-submitted UPI transaction reference for a campaign.

    After paying via UPI, the user enters their 12-digit UTR / UPI reference
    number. This stores it on the payment record and keeps the campaign in
    pending_payment status until an admin confirms.

    Args:
        campaign_id: The campaign ObjectId or its string form.
        upi_ref: The UPI transaction reference string provided by the user.

    Returns:
        dict: {"ok": True} on success, {"ok": False, "error": str} on failure.
    """
    if not upi_ref or not str(upi_ref).strip():
        return {"ok": False, "error": "UPI transaction reference is required."}

    upi_ref = str(upi_ref).strip()

    try:
        cid = ObjectId(str(campaign_id))
    except Exception:
        return {"ok": False, "error": "Invalid campaign id."}

    payments = get_campaign_payments_collection()
    result = payments.update_one(
        {"campaignId": cid},
        {"$set": {
            "upiTransactionRef": upi_ref,
            "status": "submitted",
            "updatedAt": datetime.now(timezone.utc),
        }},
    )

    if result.matched_count == 0:
        return {"ok": False, "error": "Payment record not found."}

    return {"ok": True}


def confirm_upi_payment(campaign_id):
    """Admin action: confirm a UPI payment and trigger campaign sending.

    Marks the payment as confirmed, transitions the campaign from
    pending_payment → payment_verified, and triggers execute_campaign_send.

    Args:
        campaign_id: The campaign ObjectId or its string form.

    Returns:
        dict with "ok" (bool) and optional "error" or "reason" keys.
    """
    try:
        cid = ObjectId(str(campaign_id))
    except Exception:
        return {"ok": False, "error": "Invalid campaign id."}

    campaigns = get_campaigns_collection()
    campaign_doc = campaigns.find_one({"_id": cid})

    if campaign_doc is None:
        return {"ok": False, "error": "Campaign not found."}

    current_status = campaign_doc.get("status")
    if current_status != PENDING_PAYMENT:
        return {
            "ok": False,
            "error": f"Campaign is in '{current_status}' status, not pending_payment.",
        }

    now = datetime.now(timezone.utc)

    # Mark payment as confirmed.
    payments = get_campaign_payments_collection()
    payments.update_one(
        {"campaignId": cid},
        {"$set": {
            "status": "confirmed",
            "confirmedAt": now,
            "updatedAt": now,
        }},
    )

    # Transition campaign to payment_verified.
    transition = validate_campaign_status_transition(PENDING_PAYMENT, PAYMENT_VERIFIED)
    if not transition["valid"]:
        return {"ok": False, "error": transition["error"]}

    campaigns.update_one(
        {"_id": cid},
        {"$set": {"status": PAYMENT_VERIFIED, "updatedAt": now}},
    )

    # Trigger campaign message delivery.
    try:
        execute_campaign_send(cid)
    except Exception as exc:
        return {"ok": True, "reason": "confirmed_send_error", "error": str(exc)}

    return {"ok": True, "reason": "confirmed_and_sent"}


def reject_upi_payment(campaign_id, reason=""):
    """Admin action: reject a UPI payment submission.

    Marks the payment as rejected with a reason, transitions the campaign
    from pending_payment → rejected. The campaign will not be executed.

    Args:
        campaign_id: The campaign ObjectId or its string form.
        reason: A human-readable reason for the rejection (e.g. "Fake UTR",
            "Amount mismatch", "Payment not found in bank statement").

    Returns:
        dict with "ok" (bool) and optional "error" or "reason" keys.
    """
    reason = str(reason).strip() if reason else ""

    try:
        cid = ObjectId(str(campaign_id))
    except Exception:
        return {"ok": False, "error": "Invalid campaign id."}

    campaigns = get_campaigns_collection()
    campaign_doc = campaigns.find_one({"_id": cid})

    if campaign_doc is None:
        return {"ok": False, "error": "Campaign not found."}

    current_status = campaign_doc.get("status")
    if current_status != PENDING_PAYMENT:
        return {
            "ok": False,
            "error": f"Campaign is in '{current_status}' status, not pending_payment.",
        }

    now = datetime.now(timezone.utc)

    # Mark payment as rejected with reason.
    payments = get_campaign_payments_collection()
    payments.update_one(
        {"campaignId": cid},
        {"$set": {
            "status": "rejected",
            "rejectionReason": reason,
            "rejectedAt": now,
            "updatedAt": now,
        }},
    )

    # Transition campaign to rejected.
    transition = validate_campaign_status_transition(PENDING_PAYMENT, REJECTED)
    if not transition["valid"]:
        return {"ok": False, "error": transition["error"]}

    campaigns.update_one(
        {"_id": cid},
        {"$set": {
            "status": REJECTED,
            "rejectionReason": reason,
            "updatedAt": now,
        }},
    )

    return {"ok": True, "reason": "rejected"}


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

    Called only after payment is confirmed (admin confirms UPI payment).
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
