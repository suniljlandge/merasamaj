import re
from copy import deepcopy

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

    normalized["familyMembers"] = (
        normalize_family_members(
            source.get("familyMembers"),
            overrides,
        )
    )

    normalized["membersCount"] = len(
        normalized["familyMembers"]
    )

    normalized["surnameGroup"] = (
        normalized["lastName"]["en"]
        .lower()
        .strip()
    )
    return normalized


def validate_registration(
    payload=None,
    overrides=None,
):
    value = normalize_registration(
        payload,
        overrides,
    )

    errors = []

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

        if not member["relation"]:
            errors.append(
                {
                    "field": f"familyMembers.{index}.relation",
                    "message": "Relation required.",
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

#Spouse name should be provided if member is married
        if member.get("isMarried"):

            if not member["spouseName"]["en"]:
                errors.append(
                    {
                        "field": f"familyMembers.{index}.spouseName.en",
                        "message": "Spouse name required for married member.",
                    }
                )

            if not PHONE_PATTERN.match(
                member["spouseContactNumber"]
            ):
                errors.append(
                    {
                        "field": f"familyMembers.{index}.spouseContactNumber",
                        "message": "Valid spouse contact number required.",
                    }
                )


            if not member["currentCity"]:
                errors.append(
                    {
                        "field": f"familyMembers.{index}.currentCity",
                        "message": "Current city required for married member.",
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
    overrides=None,
):
    if not isinstance(value, list):
        return []

    members = [
        _normalize_family_member(
            member,
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

    if (
        normalized.startswith("91")
        and len(normalized) == 12
    ):
        return f"+{normalized}"

    return normalized


def _normalize_family_member(
    member=None,
    overrides=None,
):
    member = member or {}

    return {

        "name": normalize_bilingual(
            member.get("name"),
            overrides,
        ),

        "relation": clean_text(
            member.get("relation", {}).get("en")
            or member.get("relation")
            or ""
        ),

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

        "spouseContactNumber": normalize_phone(
            member.get("spouseContactNumber")
        ),

        "currentCity": clean_text(
            member.get("currentCity")
        ),
    }

def _is_blank_member(member):
    return (
        not member["name"]["en"]
        and not member["name"]["mr"]
        and not member["relation"]
        and not member["contactNumber"]
    )