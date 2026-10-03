"""
One-shot migration script: backfill cityId on all legacy Washim records.

Run this ONCE against the production database to fix "Invalid credentials"
for all users and missing data for newly created Washim users.

Usage:
    python run_migration.py            # live run
    python run_migration.py --dry-run  # preview counts without writing
"""

import sys
import os
from dotenv import load_dotenv
from pymongo import MongoClient

# Load .env so MONGO_URI / MONGO_DB are available
load_dotenv()

MONGO_URI = os.environ["MONGO_URI"]
MONGO_DB = os.environ["MONGO_DB"]
MONGO_COLLECTION = os.environ.get("MONGO_COLLECTION", "registrations")

DRY_RUN = "--dry-run" in sys.argv


def main():
    print(f"Connecting to {MONGO_DB} ...")
    client = MongoClient(MONGO_URI)
    database = client[MONGO_DB]

    # Import here so the samaj package resolves relative to this file's location
    from samaj.tenant_migration import migrate_legacy_tenants

    mode = "DRY RUN" if DRY_RUN else "LIVE"
    print(f"\n{'=' * 50}")
    print(f"  Tenant migration  ({mode})")
    print(f"{'=' * 50}\n")

    result = migrate_legacy_tenants(
        database,
        registrations_collection=MONGO_COLLECTION,
        dry_run=DRY_RUN,
    )

    city = result["city"]
    print(f"Default city : {city.get('name')}  (id={city.get('_id')})\n")

    print("Records that will be / were backfilled:")
    total = 0
    for collection, count in result["backfilled"].items():
        print(f"  {collection:<30} {count:>6}")
        total += count
    print(f"  {'TOTAL':<30} {total:>6}\n")

    validation = result["validation"]
    if validation["ok"]:
        print("Validation : PASSED — no documents are missing a cityId.\n")
    else:
        print("Validation : FAILED — orphan documents remain:\n")
        for col, count in validation["missing_by_collection"].items():
            if count:
                print(f"  missing cityId  {col}: {count}")
        for col, count in validation["invalid_by_collection"].items():
            if count:
                print(f"  invalid cityId  {col}: {count}")
        print()

    if DRY_RUN:
        print("Dry-run complete. Re-run without --dry-run to apply changes.")
    else:
        print("Migration complete. All old records now carry the Washim cityId.")

    client.close()


if __name__ == "__main__":
    main()
