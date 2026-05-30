import json
import re
from datetime import datetime, timezone
from uuid import uuid4

from pymongo import MongoClient

from .registration import (
    validate_registration,
    normalize_bilingual,
)

from .corrections import (
    load_corrections,
    collect_transliteration_corrections,
    save_corrections,
)

from .transliterate import transliterate_to_marathi


MONGO_URI = "mongodb://127.0.0.1:27017"
DB_NAME = "samaj"
COLLECTION_NAME = "registrations"
CORRECTION_COLLECTION = "transliteration_corrections"


client = MongoClient(MONGO_URI)
db = client[DB_NAME]
collection = db[COLLECTION_NAME]
correction_collection = db[CORRECTION_COLLECTION]


# ==========================================
# HELPERS
# ==========================================


def clean(value=""):
    return re.sub(
        r"\s+",
        " ",
        str(value or "").strip(),
    )



def normalize_phone(value=""):
    text = re.sub(r"[^0-9+]", "", str(value or ""))

    if text.startswith("91") and len(text) == 12:
        return f"+{text}"

    return text


# ==========================================
# DUPLICATE DETECTION
# ==========================================


def find_duplicate(payload):
    mobile = normalize_phone(
        payload.get("mobileNumber")
    )

    first_name = clean(
        payload.get("firstName", {}).get("en")
    ).lower()

    last_name = clean(
        payload.get("lastName", {}).get("en")
    ).lower()

    birth_year = clean(
        payload.get("birthYear")
    )

    # strict mobile match
    if mobile:
        existing = collection.find_one({
            "mobileNumber": mobile
        })

        if existing:
            return existing

    # soft identity match
    if first_name and last_name:
        existing = collection.find_one({
            "firstName.en": {
                "$regex": f"^{re.escape(first_name)}$",
                "$options": "i"
            },
            "lastName.en": {
                "$regex": f"^{re.escape(last_name)}$",
                "$options": "i"
            },
            "birthYear": birth_year,
        })

        if existing:
            return existing

    return None


# ==========================================
# TRANSLITERATION REGENERATION
# ==========================================


def regenerate_marathi_fields(record, overrides):

    bilingual_fields = [
        "firstName",
        "middleName",
        "lastName",
        "address1",
        "address2",
    ]

    for field in bilingual_fields:
        current = record.get(field) or {}

        english = clean(current.get("en"))

        if not english:
            continue

        record[field] = {
            "en": english,
            "mr": transliterate_to_marathi(
                english,
                overrides,
            )
        }

    family_members = record.get("familyMembers") or []

    for member in family_members:

        member_name = clean(
            member.get("name", {}).get("en")
        )

        spouse_name = clean(
            member.get("spouseName", {}).get("en")
        )

        if member_name:
            member["name"] = {
                "en": member_name,
                "mr": transliterate_to_marathi(
                    member_name,
                    overrides,
                )
            }

        if spouse_name:
            member["spouseName"] = {
                "en": spouse_name,
                "mr": transliterate_to_marathi(
                    spouse_name,
                    overrides,
                )
            }

    return record


# ==========================================
# OLD DATA -> NEW FORMAT
# ==========================================


def transform_old_record(old_record, overrides):

    first_name = clean(
        old_record.get("first_name")
    )

    middle_name = clean(
        old_record.get("middle_name")
    )

    last_name = clean(
        old_record.get("last_name")
    )

    family_members = []

    for item in old_record.get("family", []):

        person_id = f"person-{uuid4().hex[:12]}"

        family_members.append({
            "personId": person_id,
            "memberId": person_id,
            "householdId": "household-primary",
            "name": normalize_bilingual({
                "en": item.get("name")
            }, overrides),
            "relationToApplicant": clean(
                item.get("relation")
            ),
            "relation": clean(
                item.get("relation")
            ),
            "contactNumber": normalize_phone(
                item.get("mobile")
            ),
            "isMarried": bool(
                item.get("married")
            ),
            "spouseName": normalize_bilingual({
                "en": item.get("spouse_name")
            }, overrides),
            "spouseContactNumber": normalize_phone(
                item.get("spouse_mobile")
            ),
            "currentCity": clean(
                item.get("city")
            ),
            "spouseMemberId": "",
            "linkedMemberIds": [],
            "parentMemberIds": [],
            "childMemberIds": [],
            "relationshipLinks": [],
        })

    document = {
        "familyId": f"family-{uuid4().hex[:10]}",
        "familyType": old_record.get(
            "family_type",
            "nuclear"
        ),
        "primaryHouseholdId": "household-primary",
        "createdAt": datetime.now(timezone.utc),
        "updatedAt": datetime.now(timezone.utc),

        "firstName": normalize_bilingual({
            "en": first_name
        }, overrides),

        "middleName": normalize_bilingual({
            "en": middle_name
        }, overrides),

        "lastName": normalize_bilingual({
            "en": last_name
        }, overrides),

        "mobileNumber": normalize_phone(
            old_record.get("mobile")
        ),

        "birthYear": clean(
            old_record.get("birth_year")
        ),

        "gender": clean(
            old_record.get("gender")
        ),

        "district": clean(
            old_record.get("district")
        ),

        "taluka": clean(
            old_record.get("taluka")
        ),

        "state": clean(
            old_record.get("state")
        ),

        "address1": normalize_bilingual({
            "en": old_record.get("address1")
        }, overrides),

        "address2": normalize_bilingual({
            "en": old_record.get("address2")
        }, overrides),

        "familyMembers": family_members,
    }

    return regenerate_marathi_fields(
        document,
        overrides,
    )


# ==========================================
# BULK IMPORT
# ==========================================


def bulk_import(json_path):

    overrides = load_corrections(
        correction_collection
    )

    with open(json_path, "r", encoding="utf-8") as file:
        data = json.load(file)

    imported = 0
    duplicates = 0
    invalid = 0

    for old_record in data:

        try:
            transformed = transform_old_record(
                old_record,
                overrides,
            )

            validation = validate_registration(
                transformed,
                overrides,
            )

            if not validation["valid"]:
                invalid += 1
                print("INVALID:")
                print(validation["errors"])
                continue

            normalized = validation["value"]

            duplicate = find_duplicate(normalized)

            if duplicate:
                duplicates += 1
                print(
                    "DUPLICATE:",
                    normalized["firstName"]["en"],
                    normalized["mobileNumber"]
                )
                continue

            collection.insert_one(normalized)

            corrections = collect_transliteration_corrections(
                normalized,
                overrides,
            )

            save_corrections(
                correction_collection,
                corrections,
            )

            imported += 1

        except Exception as error:
            invalid += 1
            print("FAILED:", error)

    print()
    print("============================")
    print("IMPORT FINISHED")
    print("============================")
    print("Imported  :", imported)
    print("Duplicates:", duplicates)
    print("Invalid   :", invalid)


if __name__ == "__main__":
    bulk_import("old_data.json")