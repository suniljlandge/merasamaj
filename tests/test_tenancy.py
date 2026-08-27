from copy import deepcopy

import pytest

from samaj.tenancy import (
    TenantError,
    TenantScope,
    is_superadmin,
    normalize_city_name,
    require_active_city,
    scope_for_session,
    scoped_query,
)
from samaj.db import ensure_tenant_indexes
from samaj.tenant_migration import (
    backfill_city_ids,
    ensure_initial_city,
    migrate_legacy_tenants,
    validate_city_references,
)
from tests.test_user_management import FakeDatabase


class FakeCitiesCollection:
    def __init__(self, documents=None):
        self.documents = [deepcopy(item) for item in (documents or [])]

    def find_one(self, query):
        for document in self.documents:
            if all(document.get(key) == value for key, value in query.items()):
                return deepcopy(document)
        return None


class FakeIndexCollection:
    def __init__(self):
        self.indexes = []

    def create_index(self, keys, **options):
        self.indexes.append((keys, options))


class FakeIndexDatabase:
    def __init__(self):
        self.collections = {}

    def __getitem__(self, name):
        return self.collections.setdefault(name, FakeIndexCollection())


def test_normalize_city_name_returns_display_and_casefolded_key():
    assert normalize_city_name("  New   Washim  ") == (
        "New Washim",
        "new washim",
    )


@pytest.mark.parametrize("value", [None, "", "   ", 123])
def test_normalize_city_name_rejects_blank_or_non_text_values(value):
    with pytest.raises(ValueError):
        normalize_city_name(value)


def test_is_superadmin_accepts_only_super_admin_role():
    assert is_superadmin("super_admin") is True
    assert is_superadmin("admin") is False
    assert is_superadmin(None) is False


def test_scoped_query_adds_city_without_mutating_input():
    scope = TenantScope(
        is_global=False,
        city_id="city-a",
        reason="staff",
    )
    query = {"role": "operator"}

    assert scoped_query(scope, query) == {
        "role": "operator",
        "cityId": "city-a",
    }
    assert query == {"role": "operator"}


def test_global_scope_does_not_add_city_predicate():
    scope = TenantScope(
        is_global=True,
        city_id=None,
        reason="superadmin",
    )

    assert scoped_query(scope, {"role": "operator"}) == {
        "role": "operator",
    }


def test_scope_for_superadmin_is_global_without_city():
    scope = scope_for_session(
        {"role": "super_admin"},
        {"role": "super_admin", "isActive": True},
        None,
    )

    assert scope.is_global is True
    assert scope.city_id is None


def test_scope_for_active_staff_uses_matching_city():
    scope = scope_for_session(
        {"role": "admin", "cityId": "city-a"},
        {"role": "admin", "cityId": "city-a", "isActive": True},
        {"_id": "city-a", "isActive": True},
    )

    assert scope == TenantScope(
        is_global=False,
        city_id="city-a",
        reason="staff",
    )


@pytest.mark.parametrize(
    "session_data,user_doc,city_doc",
    [
        ({"role": "admin"}, None, None),
        (
            {"role": "admin", "cityId": "city-a"},
            {"role": "admin", "cityId": "city-b", "isActive": True},
            {"_id": "city-a", "isActive": True},
        ),
        (
            {"role": "admin", "cityId": "city-a"},
            {"role": "admin", "cityId": "city-a", "isActive": False},
            {"_id": "city-a", "isActive": True},
        ),
        (
            {"role": "admin", "cityId": "city-a"},
            {"role": "admin", "cityId": "city-a", "isActive": True},
            {"_id": "city-a", "isActive": False},
        ),
    ],
)
def test_invalid_city_scope_fails_closed(session_data, user_doc, city_doc):
    with pytest.raises(TenantError):
        scope_for_session(session_data, user_doc, city_doc)


def test_require_active_city_returns_matching_active_city():
    cities = FakeCitiesCollection([
        {"_id": "city-a", "name": "Washim", "isActive": True},
    ])

    assert require_active_city(cities, "city-a")["name"] == "Washim"


@pytest.mark.parametrize("city_id", [None, "", "missing", "inactive"])
def test_require_active_city_rejects_missing_or_inactive_city(city_id):
    cities = FakeCitiesCollection([
        {"_id": "inactive", "name": "Inactive", "isActive": False},
    ])

    with pytest.raises(TenantError):
        require_active_city(cities, city_id)


def test_ensure_tenant_indexes_covers_city_owned_collections_and_audit():
    database = FakeIndexDatabase()
    registrations = database["registrations"]

    ensure_tenant_indexes(database, registrations)

    assert ("cityId", {}) in registrations.indexes
    assert ("nameKey", {"unique": True}) in database["cities"].indexes
    assert ([('sourceCityId', 1), ('changedAt', -1)], {}) in (
        database["city_transfers"].indexes
    )


def test_ensure_initial_city_seeds_active_washim_once():
    database = FakeDatabase()
    cities = database["cities"]

    first = ensure_initial_city(cities)
    second = ensure_initial_city(cities)

    assert first["_id"] == second["_id"]
    assert first["name"] == "Washim"
    assert first["nameKey"] == "washim"
    assert first["isActive"] is True
    assert len(list(cities.find({"nameKey": "washim"}))) == 1


def test_backfill_assigns_only_missing_city_ids_and_skips_superadmin():
    database = FakeDatabase()
    existing_city = "existing-city"
    database["registrations"].insert_one({"name": "legacy"})
    database["registrations"].insert_one({
        "name": "assigned",
        "cityId": existing_city,
    })
    database["users"].insert_one({"username": "admin", "role": "admin"})
    database["users"].insert_one({
        "username": "root",
        "role": "super_admin",
    })

    counts = backfill_city_ids(database, "washim-id")

    assert counts["registrations"] == 1
    assert counts["users"] == 1
    assert database["registrations"].find_one({"name": "legacy"})[
        "cityId"
    ] == "washim-id"
    assert database["registrations"].find_one({"name": "assigned"})[
        "cityId"
    ] == existing_city
    assert "cityId" not in database["users"].find_one({"username": "root"})


def test_backfill_dry_run_counts_without_writing():
    database = FakeDatabase()
    database["campaigns"].insert_one({"name": "legacy"})

    counts = backfill_city_ids(database, "washim-id", dry_run=True)

    assert counts["campaigns"] == 1
    assert "cityId" not in database["campaigns"].find_one({"name": "legacy"})


def test_validation_reports_missing_and_invalid_city_references():
    database = FakeDatabase()
    database["cities"].insert_one({
        "_id": "washim-id",
        "name": "Washim",
        "nameKey": "washim",
        "isActive": True,
    })
    database["registrations"].insert_one({"name": "missing"})
    database["registrations"].insert_one({
        "name": "invalid",
        "cityId": "missing-city",
    })
    database["registrations"].insert_one({
        "name": "valid",
        "cityId": "washim-id",
    })

    result = validate_city_references(database, database["cities"])

    assert result["ok"] is False
    assert result["missing_by_collection"]["registrations"] == 1
    assert result["invalid_by_collection"]["registrations"] == 1


def test_migration_is_idempotent_and_validates_backfill():
    database = FakeDatabase()
    database["registrations"].insert_one({"name": "legacy"})
    database["public_accounts"].insert_one({"mobileNumber": "9876543210"})

    first = migrate_legacy_tenants(database)
    second = migrate_legacy_tenants(database)

    assert first["backfilled"]["registrations"] == 1
    assert first["backfilled"]["public_accounts"] == 1
    assert second["backfilled"]["registrations"] == 0
    assert second["backfilled"]["public_accounts"] == 0
    assert second["validation"]["ok"] is True
