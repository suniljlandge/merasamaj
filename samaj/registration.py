import re
from copy import deepcopy
from uuid import uuid4

from .transliterate import transliterate_to_marathi

TEXT_FIELDS = (
    {"key": "firstName", "label": "First name", "required": True},
    {"key": "middleName", "label": "Middle name", "required": False},
    {"key": "lastName", "label": "Last name", "required": True},
    {"key": "address1", "label": "Address 1", "required": True},
    {"key": "address2", "label": "Address 2", "required": False},
)

MEMBER_TEXT_FIELDS = (
    {"key": "name", "label": "Member name", "required": True},
)

REQUIRED_TEXT_KEYS = {
    field["key"]
    for field in TEXT_FIELDS
    if field["required"]
}

PHONE_PATTERN = re.compile(
    r"^(?:\+91)?[6-9]\d{9}$"
)

FAMILY_TYPES = {
    "nuclear",
    "joint",
}

RELATIONSHIP_TYPES = {
    "spouse_of",
    "parent_of",
    "child_of",
    "sibling_of",
    "guardian_of",
    "belongs_to_household",
    "other",
}

MARRIED_MEMBER_EXCLUDED_RELATIONS = {
    "daughter",
    "daughter(beti)",
    "granddaughter",
    "granddaughter(poti)",
    "grand-daughter",
    "sister",
    "sister(behen)",
}

SPOUSE_COUNTED_RELATIONS = {
    "Son(beta)",
    "Grandson(pota)",
    "Grand-son(pota)",
    "Brother(bhai)",
    "Uncle",
    "Cousin",
    "Nephew",
}

# Maximum allowed family members per registration (excluding applicant)
MAX_FAMILY_MEMBERS = 50


def normalize_registration(
    payload=None,
    overrides=None,
):
    source = deepcopy(payload or {})

    normalized = {}

    for field in TEXT_FIELDS:
        normalized[field["key"]] = normalize_bilingual(
            source.get(field["key"]),
            overrides,
        )

    normalized["birthDate"] = clean_text(
        source.get("birthDate")
    )

    normalized["birthYear"] = clean_text(
        source.get("birthYear")
    )

    normalized["state"] = clean_text(
        source.get("state")
    )

    normalized["district"] = clean_text(
        source.get("district")
    )

    normalized["taluka"] = clean_text(
        source.get("taluka")
    )

    normalized["mobileNumber"] = normalize_phone(
        source.get("mobileNumber")
    )

    normalized["familyId"] = clean_text(
        source.get("familyId")
    ) or f"family-{uuid4().hex[:12]}"

    family_type = clean_text(
        source.get("familyType")
    ).lower()

    normalized["familyType"] = (
        family_type
        if family_type in FAMILY_TYPES
        else "nuclear"
    )

    normalized["primaryHouseholdId"] = clean_text(
        source.get("primaryHouseholdId")
    ) or "household-primary"

    normalized["familyMembers"] = (
        normalize_family_members(
            source.get("familyMembers"),
            normalized["primaryHouseholdId"],
            overrides,
        )
    )

    normalized["membersCount"] = calculate_family_members_count(
        normalized["familyMembers"]
    )

    normalized["surnameGroup"] = (
        normalized["lastName"]["en"]
        .lower()
        .strip()
    )

    normalized["invitationName"] = clean_text(
        source.get("invitationName")
    )

    return normalized


def validate_registration(
    payload=None,
    overrides=None,
    max_family_members=None,
):
    value = normalize_registration(
        payload,
        overrides,
    )

    errors = []

    member_limit = (
        max_family_members
        if isinstance(max_family_members, int) and max_family_members > 0
        else MAX_FAMILY_MEMBERS
    )

    if len(value.get("familyMembers") or []) > member_limit:
        errors.append({
            "field": "familyMembers",
            "message": f"At most {member_limit} family members are allowed."
        })

    for field in TEXT_FIELDS:
        if (
            field["key"] in REQUIRED_TEXT_KEYS
            and not value[field["key"]]["en"]
        ):
            errors.append(
                {
                    "field": f"{field['key']}.en",
                    "message": f"{field['label']} in English is required.",
                }
            )

    if not value["state"]:
        errors.append({
            "field": "state",
            "message": "State is required."
        })

    if not value["district"]:
        errors.append({
            "field": "district",
            "message": "District is required."
        })

    if not value["taluka"]:
        errors.append({
            "field": "taluka",
            "message": "Taluka is required."
        })

    if not PHONE_PATTERN.match(
        value["mobileNumber"]
    ):
        errors.append(
            {
                "field": "mobileNumber",
                "message": "Mobile number must be valid.",
            }
        )

    birth_date = value.get(
        "birthDate",
        "",
    ).strip()

    birth_year = value.get(
        "birthYear",
        "",
    ).strip()

    if (
        birth_date
        and not re.match(
            r"^\d{4}-\d{2}-\d{2}$",
            birth_date,
        )
    ):
        errors.append(
            {
                "field": "birthDate",
                "message": "Birth date must be YYYY-MM-DD.",
            }
        )

    if (
        birth_year
        and not re.match(
            r"^\d{4}$",
            birth_year,
        )
    ):
        errors.append(
            {
                "field": "birthYear",
                "message": "Birth year must be 4 digits.",
            }
        )

    if not birth_date and not birth_year:
        errors.append(
            {
                "field": "birthDate",
                "message": "Provide full DOB or birth year.",
            }
        )

    for index, member in enumerate(
        value["familyMembers"]
    ):
        if not member["name"]["en"]:
            errors.append(
                {
                    "field": f"familyMembers.{index}.name.en",
                    "message": "Family member name required.",
                }
            )

        if not member["relationToApplicant"]:
            errors.append(
                {
                    "field": f"familyMembers.{index}.relationToApplicant",
                    "message": "Relation to applicant required.",
                }
            )

        if not PHONE_PATTERN.match(
            member["contactNumber"]
        ):
            errors.append(
                {
                    "field": f"familyMembers.{index}.contactNumber",
                    "message": "Contact number invalid.",
                }
            )
########
        relation = normalize_relation_key(
            member.get("relationToApplicant")
        )

        requires_spouse_name = relation in {
            "daughter",
            "sister",
            "granddaughter",
            "grand-daughter",
        }

        if member.get("isMarried") and requires_spouse_name:

            if not member["spouseName"]["en"]:
                errors.append(
                    {
                        "field": f"familyMembers.{index}.spouseName",
                        "message": "Spouse name required.",
                    }
                )

            if not member["currentCity"]:
                errors.append(
                    {
                        "field": f"familyMembers.{index}.currentCity",
                        "message": "Current city required.",
                    }
                )
    return {
        "valid": not errors,
        "errors": errors,
        "value": value,
    }


def normalize_bilingual(
    value=None,
    overrides=None,
):
    value = value or {}

    english = clean_text(
        value.get("en")
        or value.get("english")
        or ""
    )

    marathi = clean_text(
        value.get("mr")
        or value.get("marathi")
        or ""
    )

    return {
        "en": english,
        "mr": (
            marathi
            or (
                transliterate_to_marathi(
                    english,
                    overrides,
                )
                if english
                else ""
            )
        ),
    }


def normalize_family_members(
    value,
    primary_household_id="household-primary",
    overrides=None,
):
    if not isinstance(value, list):
        return []

    members = [
        _normalize_family_member(
            member,
            primary_household_id,
            overrides,
        )
        for member in value
    ]

    return [
        member
        for member in members
        if not _is_blank_member(member)
    ]


def clean_text(value=""):
    return re.sub(
        r"\s+",
        " ",
        str(value or "").strip(),
    )


def normalize_phone(value=""):
    text = str(value or "").strip()

    normalized = re.sub(
        r"[\s()-]",
        "",
        text,
    )

    if not normalized:
        return normalized

    # Already has + prefix with country code
    if normalized.startswith("+"):
        return normalized

    # Indian number without + (e.g. 919876543210)
    if (
        normalized.startswith("91")
        and len(normalized) == 12
    ):
        return f"+{normalized}"

    # 10-digit Indian mobile number without country code
    if (
        len(normalized) == 10
        and normalized[0] in "6789"
    ):
        return f"+91{normalized}"

    return normalized


def normalize_public_mobile(value=""):
    """Normalize a public-account / OTP mobile number to a bare 10-digit form.

    Public accounts and their OTP challenges are stored and looked up using a
    plain 10-digit Indian mobile number (e.g. "9876543210"). This keeps the
    OTP challenge, the account lookup, and account creation consistent with
    each other so a campaigner account is always matched on login.

    Unlike ``normalize_phone`` (used for registration data), this strips any
    "+91", "91", "0091", or single leading "0" prefix and returns just the
    10 digits. The shared registration phone handling is intentionally left
    untouched.

    Returns:
        The 10-digit string when the input resolves to a valid Indian mobile
        number (10 digits starting 6-9), otherwise the digit-stripped input
        (which may be empty) so callers can still reject it.
    """
    digits = re.sub(r"\D", "", str(value or ""))

    if not digits:
        return ""

    # Strip a "0091" / "91" country code prefix when it leaves 10 digits.
    if len(digits) == 14 and digits.startswith("0091"):
        digits = digits[4:]
    elif len(digits) == 12 and digits.startswith("91"):
        digits = digits[2:]
    elif len(digits) == 11 and digits.startswith("0"):
        digits = digits[1:]

    if len(digits) == 10 and digits[0] in "6789":
        return digits

    # Not a recognizable Indian mobile number — return the bare digits so the
    # caller's own validation can reject it.
    return digits


def _normalize_family_member(
    member=None,
    primary_household_id="household-primary",
    overrides=None,
):
    member = member or {}
    person_id = (
        clean_text(member.get("personId"))
        or clean_text(member.get("memberId"))
        or f"person-{uuid4().hex[:12]}"
    )

    relation_to_applicant = clean_text(
        read_relation_value(
            member.get("relationToApplicant")
        )
        or read_relation_value(
            member.get("relation")
        )
        or ""
    )

    return {
        "personId": person_id,

        "memberId": person_id,

        "householdId": clean_text(
            member.get("householdId")
        ) or primary_household_id,

        "name": normalize_bilingual(
            member.get("name"),
            overrides,
        ),

        "relationToApplicant": relation_to_applicant,

        "contactNumber": normalize_phone(
            member.get("contactNumber")
        ),

        "isMarried": bool(
            member.get("isMarried")
        ),

        "spouseName": normalize_bilingual(
            member.get("spouseName"),
            overrides,
        ),


        "currentCity": clean_text(
            member.get("currentCity")
        ),

        "spouseMemberId": clean_text(
            member.get("spouseMemberId")
        ),

        "relationshipLinks": normalize_relationship_links(
            member.get("relationshipLinks"),
            member,
        ),
    }

def _is_blank_member(member):
    return (
        not member["name"]["en"]
        and not member["name"]["mr"]
        and not member["relationToApplicant"]
        and not member["contactNumber"]
    )


def normalize_relation_key(value=""):
    return (
        read_relation_value(value)
        .strip()
        .lower()
    )


def calculate_family_members_count(members=None):
    total = 0

    for member in members or []:
        relation = normalize_relation_key(
            member.get("relationToApplicant")
            or member.get("relation")
            or ""
        )
        is_married = bool(
            member.get("isMarried")
        )

        if (
            is_married
            and relation in MARRIED_MEMBER_EXCLUDED_RELATIONS
        ):
            continue

        total += 1

        if (
            is_married
            and relation in SPOUSE_COUNTED_RELATIONS
            and (member.get("spouseName") or {}).get("en")
        ):
            total += 1

    return total



def normalize_relationship_links(value=None, member=None):
    if isinstance(value, list):
        links = [
            normalize_relationship_link(item)
            for item in value
        ]

        return [
            link
            for link in links
            if link
        ]

    member = member or {}
    legacy_links = []

    spouse_member_id = clean_text(
        member.get("spouseMemberId")
    )

    if spouse_member_id:
        legacy_links.append({
            "type": "spouse_of",
            "targetPersonId": spouse_member_id,
        })

    for parent_id in normalize_member_id_list(
        member.get("parentMemberIds")
    ):
        legacy_links.append({
            "type": "child_of",
            "targetPersonId": parent_id,
        })

    for child_id in normalize_member_id_list(
        member.get("childMemberIds")
    ):
        legacy_links.append({
            "type": "parent_of",
            "targetPersonId": child_id,
        })

    for linked_id in normalize_member_id_list(
        member.get("linkedMemberIds")
    ):
        legacy_links.append({
            "type": "other",
            "targetPersonId": linked_id,
        })

    return legacy_links


def normalize_relationship_link(value=None):
    if not isinstance(value, dict):
        return None

    link_type = clean_text(
        value.get("type")
    ).lower()
    target_person_id = clean_text(
        value.get("targetPersonId")
        or value.get("targetMemberId")
    )

    if (
        link_type not in RELATIONSHIP_TYPES
        or not target_person_id
    ):
        return None

    return {
        "type": link_type,
        "targetPersonId": target_person_id,
    }


def normalize_member_id_list(value=None):
    if not isinstance(value, list):
        return []

    normalized = [
        clean_text(item)
        for item in value
    ]

    return [
        item
        for item in normalized
        if item
    ]


def read_relation_value(value=None):
    if isinstance(value, dict):
        return clean_text(
            value.get("en")
            or value.get("value")
            or ""
        )

    return clean_text(value)


# Account type constants for public_accounts routing.
ACCOUNT_TYPE_CAMPAIGNER = "campaigner"
ACCOUNT_TYPE_REGISTRANT = "registrant"
DEFAULT_ACCOUNT_TYPE = ACCOUNT_TYPE_REGISTRANT


def normalize_account_type(value=None):
    """Return a recognized account type, defaulting to "registrant"."""
    account_type = clean_text(value).lower()

    if account_type == ACCOUNT_TYPE_CAMPAIGNER:
        return ACCOUNT_TYPE_CAMPAIGNER

    return ACCOUNT_TYPE_REGISTRANT


def get_redirect_for_account(account=None):
    """Determine the post-OTP redirect target for a public_account.

    Routing rules (deterministic for a given account document):
      - campaigner account              -> "/campaign-manager"
      - registrant + status "approved"  -> "/directory"
      - registrant + any other status   -> "/self-register"

    A missing or unrecognized ``accountType`` defaults to "registrant".
    """
    account = account or {}

    account_type = normalize_account_type(
        account.get("accountType")
    )

    if account_type == ACCOUNT_TYPE_CAMPAIGNER:
        return "/campaign-manager"

    status = clean_text(account.get("status")).lower()

    if status == "approved":
        return "/directory"

    return "/self-register"
