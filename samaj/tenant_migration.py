from datetime import datetime, timezone

from .db import CITY_OWNED_COLLECTIONS
from .tenancy import normalize_city_name


DEFAULT_CITY_NAME = "Washim"

TENANT_COLLECTIONS = (
    "registrations",
    *CITY_OWNED_COLLECTIONS,
    "public_otp",
    "wa_login_sessions",
    "whatsapp_templates",
)


def ensure_initial_city(cities_collection, actor="migration") -> dict:
    display_name, name_key = normalize_city_name(DEFAULT_CITY_NAME)
    existing = cities_collection.find_one({"nameKey": name_key})
    now = datetime.now(timezone.utc)

    if existing:
        if not existing.get("isActive", False):
            cities_collection.update_one(
                {"_id": existing["_id"]},
                {
                    "$set": {
                        "isActive": True,
                        "updatedAt": now,
                        "updatedBy": actor,
                    }
                },
            )
            existing["isActive"] = True
            existing["updatedAt"] = now
            existing["updatedBy"] = actor
        return existing

    city = {
        "name": display_name,
        "nameKey": name_key,
        "isActive": True,
        "createdAt": now,
        "createdBy": actor,
        "updatedAt": now,
        "updatedBy": actor,
    }
    result = cities_collection.insert_one(city)
    city["_id"] = result.inserted_id
    return city


def _is_city_owned_document(collection_name, document):
    return not (
        collection_name == "users"
        and document.get("role") == "super_admin"
    )


def backfill_city_ids(database, default_city_id, *, dry_run=False):
    counts = {}

    for collection_name in TENANT_COLLECTIONS:
        collection = database[collection_name]
        count = 0

        for document in collection.find({}):
            if not _is_city_owned_document(collection_name, document):
                continue
            if document.get("cityId") not in (None, ""):
                continue

            count += 1
            if not dry_run:
                collection.update_one(
                    {"_id": document["_id"]},
                    {"$set": {"cityId": default_city_id}},
                )

        counts[collection_name] = count

    return counts


def validate_city_references(database, cities_collection):
    valid_city_ids = {
        city.get("_id")
        for city in cities_collection.find({})
        if city.get("_id") is not None
    }
    missing_by_collection = {}
    invalid_by_collection = {}

    for collection_name in TENANT_COLLECTIONS:
        missing = 0
        invalid = 0

        for document in database[collection_name].find({}):
            if not _is_city_owned_document(collection_name, document):
                continue

            city_id = document.get("cityId")
            if city_id in (None, ""):
                missing += 1
            elif city_id not in valid_city_ids:
                invalid += 1

        missing_by_collection[collection_name] = missing
        invalid_by_collection[collection_name] = invalid

    return {
        "missing_by_collection": missing_by_collection,
        "invalid_by_collection": invalid_by_collection,
        "ok": not any(missing_by_collection.values())
        and not any(invalid_by_collection.values()),
    }


def migrate_legacy_tenants(
    database,
    *,
    default_city_name=DEFAULT_CITY_NAME,
    dry_run=False,
):
    display_name, name_key = normalize_city_name(default_city_name)
    cities = database["cities"]
    city = cities.find_one({"nameKey": name_key})

    if city is None:
        if dry_run:
            city = {
                "_id": "dry-run-default-city",
                "name": display_name,
                "nameKey": name_key,
                "isActive": True,
            }
        elif name_key == normalize_city_name(DEFAULT_CITY_NAME)[1]:
            city = ensure_initial_city(cities)
        else:
            now = datetime.now(timezone.utc)
            city = {
                "name": display_name,
                "nameKey": name_key,
                "isActive": True,
                "createdAt": now,
                "createdBy": "migration",
                "updatedAt": now,
                "updatedBy": "migration",
            }
            result = cities.insert_one(city)
            city["_id"] = result.inserted_id

    backfilled = backfill_city_ids(
        database,
        city["_id"],
        dry_run=dry_run,
    )
    validation = (
        {"missing_by_collection": {}, "invalid_by_collection": {}, "ok": True}
        if dry_run
        else validate_city_references(database, cities)
    )

    return {
        "city": city,
        "backfilled": backfilled,
        "validation": validation,
        "dry_run": dry_run,
    }
