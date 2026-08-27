# Multi-City Tenant Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert SAMAJ from single-city operation to a shared-database multi-city system with server-enforced isolation, audited record transfers, active-city registration, disabled-city controls, and superadmin city management.

**Architecture:** Add a focused `samaj/tenancy.py` boundary that resolves the current actor's global or single-city scope, builds mandatory Mongo predicates, validates active cities, and records transfers. Add an idempotent migration module that seeds Washim and backfills legacy documents, then update `samaj/app.py`, `samaj/campaign.py`, and `samaj/whatsapp_web_routes.py` to call the boundary for every city-owned operation. Extend existing templates/JS only after API contracts and regression tests prove isolation.

**Tech Stack:** Flask, Flask-Session, PyMongo, MongoDB, unittest/pytest-compatible tests, existing vanilla JavaScript templates; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-27-multi-city-tenant-isolation-design.md`

## Global Constraints

- Existing users and records migrate to the initial active city **Washim**.
- Public registrants select a city from active cities only; review is city-scoped.
- Superadmins have global scope; all other staff and public accounts have one city.
- City isolation is enforced server-side; client filters never grant access.
- Ordinary updates cannot change `cityId`; a dedicated audited transfer operation does.
- City-admin transfers target a different active city and immediately leave source scope.
- Disabled cities preserve data but block users, writes, and public selection.
- No new external dependency is required.
- Every implementation task must add or update regression tests before implementation and run the focused test command before committing.

---

## File Map and Ownership

- Create `samaj/tenancy.py`: city normalization, scope predicates, active-city checks, transfer service, and migration-facing constants.
- Create `samaj/tenant_migration.py`: idempotent Washim seed/backfill/validation entry points.
- Modify `samaj/db.py`: city/transfer collections and indexes.
- Modify `samaj/app.py`: app extensions/getters, login/session validation, route query scoping, public city endpoint, transfer/city APIs, and serialization.
- Modify `samaj/campaign.py`: optional `query`/scope parameters for audience and campaign ownership helpers.
- Modify `samaj/whatsapp_web_routes.py`: scope city-owned WhatsApp templates/sessions and exports; preserve global-only routes for superadmin.
- Modify `samaj/templates/login.html`, `samaj/static/login.js`: active-city selector for new OTP/public accounts.
- Modify `samaj/templates/self-register.html`, `samaj/static/self-register.js`: display the session city and preserve it in submission payloads.
- Modify `samaj/templates/user-management.html`, `samaj/static/user-management.js`: city display and superadmin city assignment controls.
- Modify `samaj/templates/superadmin.html`, `samaj/static/superadmin.js`: city management and transfer-history panels.
- Modify `samaj/templates/_topbar.html` only if a city/status indicator or navigation link is needed by the existing layout.
- Create `tests/test_tenancy.py`: pure scope, city lifecycle, transfer, and migration tests using existing fake Mongo helpers.
- Create `tests/test_multi_city_isolation.py`: HTTP-level cross-city regression tests spanning users, registrations, review, campaigns, and exports.
- Modify `tests/test_user_management.py`, `tests/test_self_registration_flow.py`, `tests/test_registration_permissions.py`, and campaign endpoint tests to provide explicit city assignments and preserve existing behavior.

## Task 1: Add Pure Tenant Primitives and Collection Contracts

**Files:**
- Create: `samaj/tenancy.py`
- Modify: `samaj/db.py`
- Test: `tests/test_tenancy.py`

**Interfaces:**
- `normalize_city_name(value: str) -> tuple[str, str]` returns `(display_name, name_key)` or raises `ValueError`.
- `is_superadmin(role: str | None) -> bool`.
- `scope_for_session(session_data: Mapping[str, Any], user_doc: Mapping[str, Any] | None, city_doc: Mapping[str, Any] | None) -> TenantScope` where `TenantScope` exposes `is_global: bool`, `city_id: Any | None`, and `reason: str`.
- `scoped_query(scope: TenantScope, query: Mapping[str, Any] | None = None) -> dict` merges `cityId` for non-global scope without mutating the input.
- `require_active_city(cities_collection, city_id) -> dict` returns the active city or raises `TenantError`.

- [ ] **Step 1: Write the failing tests**

```python
def test_scoped_query_adds_city_without_mutating_input():
    scope = TenantScope(is_global=False, city_id="city-a", reason="staff")
    query = {"role": "operator"}
    assert scoped_query(scope, query) == {"role": "operator", "cityId": "city-a"}
    assert query == {"role": "operator"}

def test_global_scope_does_not_add_city_predicate():
    scope = TenantScope(is_global=True, city_id=None, reason="superadmin")
    assert scoped_query(scope, {"role": "operator"}) == {"role": "operator"}

def test_invalid_city_scope_fails_closed():
    with pytest.raises(TenantError):
        scope_for_session({"role": "admin", "cityId": "missing"}, None, None)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_tenancy.py -q`
Expected: FAIL because `samaj.tenancy` and its interfaces do not exist.

- [ ] **Step 3: Implement the minimal primitives**

Implement `TenantScope` as a small dataclass, `TenantError` as an application exception, immutable predicate merging, strict city ID validation, and active-city lookup. In `db.py`, add `create_index("cityId")` and compound indexes for registrations/users/campaign collections where those collections are created by the app.

- [ ] **Step 4: Run focused tests**

Run: `pytest tests/test_tenancy.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add samaj/tenancy.py samaj/db.py tests/test_tenancy.py
git commit -m "Prevent city-owned queries from escaping tenant scope" -m "Confidence: high" -m "Scope-risk: moderate" -m "Tested: pytest tests/test_tenancy.py -q"
```

## Task 2: Implement Idempotent Washim Migration and Validation

**Files:**
- Create: `samaj/tenant_migration.py`
- Modify: `samaj/db.py`
- Test: `tests/test_tenancy.py`

**Interfaces:**
- `ensure_initial_city(cities_collection, actor="migration") -> dict`.
- `backfill_city_ids(database, default_city_id, *, dry_run=False) -> dict[str, int]`.
- `validate_city_references(database, cities_collection) -> dict` returning `missing_by_collection`, `invalid_by_collection`, and `ok`.
- `migrate_legacy_tenants(database, *, default_city_name="Washim", dry_run=False) -> dict`.

- [ ] **Step 1: Add failing migration tests**

```python
def test_migration_seeds_washim_once_and_backfills_legacy_documents(fake_db):
    fake_db["users"].insert_one({"username": "admin", "role": "admin"})
    fake_db["registrations"].insert_one({"firstName": {"en": "Asha"}})
    first = migrate_legacy_tenants(fake_db)
    second = migrate_legacy_tenants(fake_db)
    cities = list(fake_db["cities"].find({"nameKey": "washim"}))
    assert len(cities) == 1
    assert first["backfilled"] >= 2
    assert second["backfilled"] == 0

def test_validation_reports_orphan_city_reference(fake_db):
    fake_db["registrations"].insert_one({"cityId": "missing"})
    result = validate_city_references(fake_db, fake_db["cities"])
    assert result["ok"] is False
    assert result["invalid_by_collection"]["registrations"] == 1
```

- [ ] **Step 2: Run the migration tests and confirm failure**

Run: `pytest tests/test_tenancy.py -k migration -q`
Expected: FAIL because migration interfaces do not exist.

- [ ] **Step 3: Implement idempotent backfill**

Use one canonical city document keyed by `nameKey`. Backfill only documents missing `cityId`; never overwrite an existing valid assignment. Cover `users` excluding `super_admin`, `registrations`, `public_accounts`, `self_registrations`, `campaigns`, `campaign_payments`, `campaign_messages`, and known supporting collections. Return per-collection counts. Add a strict validation pass that resolves every referenced city ID and reports missing assignments separately from invalid references.

- [ ] **Step 4: Run focused migration tests**

Run: `pytest tests/test_tenancy.py -k migration -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add samaj/tenant_migration.py samaj/db.py tests/test_tenancy.py
git commit -m "Preserve legacy access while introducing city ownership" -m "Constraint: Existing data defaults to Washim" -m "Confidence: high" -m "Scope-risk: broad" -m "Tested: pytest tests/test_tenancy.py -k migration -q"
```

## Task 3: Wire App Scope Resolution and Staff Authentication

**Files:**
- Modify: `samaj/app.py`
- Modify: `samaj/tenancy.py`
- Test: `tests/test_tenancy.py`, `tests/test_user_management.py`

**Interfaces:**
- Flask app extension `app.extensions["tenant_scope"]` is resolved per request.
- `current_tenant_scope() -> TenantScope`.
- `tenant_query(query=None) -> dict` delegates to `scoped_query`.
- `tenant_can_access(document) -> bool`.
- `ensure_active_staff_session() -> bool`.

- [ ] **Step 1: Add failing authentication/scope tests**

```python
def test_staff_login_stores_city_id_and_active_city(fake_app):
    response = fake_app.post("/login", json={"username": "washim-admin", "password": "secret"})
    assert response.status_code == 200
    with fake_app.session_transaction() as session:
        assert session["cityId"] == "washim-id"

def test_inactive_city_invalidates_existing_session(client, inactive_city_admin_session):
    response = client.get("/directory")
    assert response.status_code in (302, 403)
```

- [ ] **Step 2: Run focused tests to verify failure**

Run: `pytest tests/test_tenancy.py tests/test_user_management.py -q`
Expected: FAIL on missing city/session behavior while existing unrelated tests may expose fixture assumptions.

- [ ] **Step 3: Implement request scope and login checks**

At staff login, load the user, reject inactive/missing city for non-superadmins, and store `cityId`; superadmin stores global scope. On each protected request, re-read the staff user/city as needed and clear or reject inactive sessions. Preserve public-session handling for Task 4. Add app collection getters for `cities`, `city_transfers`, `campaign_messages`, and any supporting collection currently accessed through raw database indexing.

- [ ] **Step 4: Run focused tests and update fixtures**

Run: `pytest tests/test_tenancy.py tests/test_user_management.py -q`
Expected: PASS after existing staff test helpers include a valid city for city-scoped roles; superadmin tests remain global.

- [ ] **Step 5: Commit**

```bash
git add samaj/app.py samaj/tenancy.py tests/test_tenancy.py tests/test_user_management.py
git commit -m "Block inactive or unscoped staff sessions" -m "Confidence: high" -m "Scope-risk: broad" -m "Tested: pytest tests/test_tenancy.py tests/test_user_management.py -q"
```

## Task 4: Scope Public Accounts, City Selection, and Review Queues

**Files:**
- Modify: `samaj/app.py`
- Modify: `samaj/templates/login.html`
- Modify: `samaj/static/login.js`
- Modify: `samaj/templates/self-register.html`
- Modify: `samaj/static/self-register.js`
- Test: `tests/test_self_registration_flow.py`, `tests/test_multi_city_isolation.py`

**Interfaces:**
- `GET /api/cities/active -> {"items": [{"id": str, "name": str}]}`.
- A new OTP/public account chooses `cityId` before OTP verification; the OTP challenge carries that city and account creation validates it again.
- Existing public accounts retain their stored city; a client cannot move them by selecting another city during login.
- `cityId` is included in `POST /api/self-registrations` payloads but must match the authenticated public account's city.
- `serialize_public_account` and `serialize_self_registration` include city display metadata where authorized.

- [ ] **Step 1: Add failing public-registration tests**

```python
def test_active_city_endpoint_excludes_disabled_cities(client, seeded_cities):
    body = client.get("/api/cities/active").get_json()
    assert [item["name"] for item in body["items"]] == ["Washim"]

def test_self_registration_rejects_inactive_city(client, seeded_cities, public_session):
    response = client.post("/api/self-registrations", json={**valid_payload(), "cityId": "inactive-id"})
    assert response.status_code == 400

def test_new_otp_account_is_created_in_selected_city(client, seeded_cities):
    client.post("/api/public/request-otp", json={"mobileNumber": "9876543210", "cityId": "city-a"})
    response = client.post("/api/public/verify-otp", json={"mobileNumber": "9876543210", "otp": "123456"})
    assert response.get_json()["account"]["cityId"] == "city-a"

def test_review_queue_is_limited_to_admin_city(two_city_client):
    login_city(two_city_client, "city-a", "admin")
    body = two_city_client.get("/api/self-registrations/review").get_json()
    assert {item["cityId"] for item in body["items"]} == {"city-a"}
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `pytest tests/test_self_registration_flow.py tests/test_multi_city_isolation.py -k city -q`
Expected: FAIL because city endpoint/payload/scoping is absent.

- [ ] **Step 3: Implement city selection and public scope**

Add the read-only active-city endpoint. Render the selector in the public OTP/login flow, store the validated choice on the OTP challenge, and use it when creating a new public account. Existing accounts keep their stored city even when a different login choice is submitted. Show the assigned city on the self-register page and require the submission city to match the session account. Preserve `cityId` across version edits and approval, and scope `/api/self-registrations/me`, review, approve, and reject operations. If a submitted city becomes inactive, preserve the submission but prevent city-admin processing.

- [ ] **Step 4: Run focused tests**

Run: `pytest tests/test_self_registration_flow.py tests/test_multi_city_isolation.py -k city -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add samaj/app.py samaj/templates/login.html samaj/static/login.js samaj/templates/self-register.html samaj/static/self-register.js tests/test_self_registration_flow.py tests/test_multi_city_isolation.py
git commit -m "Send new public accounts to the selected active city" -m "Confidence: high" -m "Scope-risk: broad" -m "Tested: pytest tests/test_self_registration_flow.py tests/test_multi_city_isolation.py -k city -q"
```

## Task 5: Enforce Registration and Directory Isolation Across All CRUD/Export Paths

**Files:**
- Modify: `samaj/app.py`
- Modify: `samaj/campaign.py` only if helper signatures need scope arguments
- Test: `tests/test_multi_city_isolation.py`, `tests/test_registration_permissions.py`, `tests/test_get_hof_by_area.py`

**Interfaces:**
- All registration reads use `tenant_query({"_id": ...})` or `tenant_can_access(document)`.
- `get_hof_by_area(filters, collection, query_scope=None)` accepts an optional query predicate without breaking existing callers.
- `build_directory_export_rows(documents, ...)` receives already-scoped documents; it never performs an unscoped database read.

- [ ] **Step 1: Add failing cross-city CRUD/export tests**

```python
def test_city_admin_cannot_read_update_delete_or_export_other_city(two_city_client):
    login_city(two_city_client, "city-a", "admin")
    other_id = seed_registration(city_id="city-b")
    assert two_city_client.get(f"/api/registrations/{other_id}").status_code in (403, 404)
    assert two_city_client.put(f"/api/registrations/{other_id}", json=valid_payload()).status_code == 403
    assert two_city_client.delete(f"/api/registrations/{other_id}").status_code in (403, 404)
    assert str(other_id) not in two_city_client.get("/api/export").get_data(as_text=True)

def test_superadmin_can_filter_or_view_both_cities(two_city_client):
    login_city(two_city_client, None, "super_admin")
    assert two_city_client.get("/api/registrations").get_json()["items"]
```

- [ ] **Step 2: Run tests to verify the isolation failures**

Run: `pytest tests/test_multi_city_isolation.py tests/test_registration_permissions.py -q`
Expected: FAIL because routes currently query by ID or `{}` without city predicates.

- [ ] **Step 3: Scope every registration path**

Update detail pages/API, member search, list/count, family tree, edit, invitation-name, delete, create, bulk import, transliteration scans/fixes, address-area tools, `/api/export/filters`, `/api/export`, and operator-performance queries. Inserted city comes from server scope. Ordinary payload `cityId` is rejected/ignored. Ensure public viewers still reach only their own approved registration and city-admin access remains role-controlled in addition to tenant scope.

- [ ] **Step 4: Run all registration and directory tests**

Run: `pytest tests/test_multi_city_isolation.py tests/test_registration_permissions.py tests/test_get_hof_by_area.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add samaj/app.py samaj/campaign.py tests/test_multi_city_isolation.py tests/test_registration_permissions.py tests/test_get_hof_by_area.py
git commit -m "Prevent member data from crossing city boundaries" -m "Directive: Every registration query must include tenant scope" -m "Confidence: high" -m "Scope-risk: broad" -m "Tested: registration, permissions, and HOF suites"
```

## Task 6: Add Audited Record Transfers

**Files:**
- Modify: `samaj/tenancy.py`
- Modify: `samaj/app.py`
- Test: `tests/test_tenancy.py`, `tests/test_multi_city_isolation.py`

**Interfaces:**
- `transfer_registration(registrations, transfers, cities, registration_id, destination_city_id, actor, reason, scope) -> dict`.
- `POST /api/registrations/<id>/transfer -> {"destinationCityId": str, "reason": str}` returns `{ok, auditId}`.
- `GET /api/city-transfers` is superadmin-only and accepts `sourceCityId`, `destinationCityId`, `actor`, `entityType`, `from`, `to` filters.

- [ ] **Step 1: Add failing transfer tests**

```python
def test_city_admin_transfer_moves_record_and_writes_audit(two_city_client):
    record_id = seed_registration(city_id="city-a")
    login_city(two_city_client, "city-a", "admin")
    response = two_city_client.post(f"/api/registrations/{record_id}/transfer", json={"destinationCityId": "city-b", "reason": "Requested"})
    assert response.status_code == 200
    assert registrations.find_one({"_id": record_id})["cityId"] == "city-b"
    assert transfers.find_one({"entityId": record_id, "sourceCityId": "city-a", "destinationCityId": "city-b"})
    assert two_city_client.get(f"/api/registrations/{record_id}").status_code in (403, 404)

def test_transfer_requires_active_destination_and_reason(two_city_client):
    login_city(two_city_client, "city-a", "admin")
    assert two_city_client.post("/api/registrations/id/transfer", json={"destinationCityId": "inactive", "reason": ""}).status_code == 400
```

- [ ] **Step 2: Run focused transfer tests and confirm failure**

Run: `pytest tests/test_tenancy.py -k transfer -q`
Expected: FAIL because no transfer service or routes exist.

- [ ] **Step 3: Implement guarded transfer**

Use a MongoDB transaction when available. For fake/standalone deployments, use a pending audit marker plus conditional update matching source city, then finalize the audit; on audit failure, restore the old city assignment. Store `sourceCityName` and `destinationCityName` snapshots so history remains accurate after a city rename. Enforce destination active/different, actor scope, required reason, and supported entity type. Never return the moved document to the source admin.

- [ ] **Step 4: Run transfer and concurrency tests**

Run: `pytest tests/test_tenancy.py -k transfer -q; pytest tests/test_multi_city_isolation.py -k transfer -q`
Expected: PASS, including stale-source conflict and failed-audit compensation tests.

- [ ] **Step 5: Commit**

```bash
git add samaj/tenancy.py samaj/app.py tests/test_tenancy.py tests/test_multi_city_isolation.py
git commit -m "Prevent ownership changes without durable audit history" -m "Constraint: Source admins lose access immediately after transfer" -m "Confidence: high" -m "Scope-risk: broad" -m "Tested: tenant transfer and cross-city isolation suites"
```

## Task 7: Scope Users and Add Staff City Administration

**Files:**
- Modify: `samaj/app.py`
- Modify: `samaj/templates/user-management.html`
- Modify: `samaj/static/user-management.js`
- Test: `tests/test_user_management.py`, `tests/test_multi_city_isolation.py`

**Interfaces:**
- `GET /api/users` returns city-scoped users for city admins and all users plus city metadata for superadmins.
- `POST /api/users` accepts optional `cityId` only for superadmins; city admins are forced to their own city.
- `PUT /api/users/<username>/city` is superadmin-only for staff reassignment.
- `GET /api/cities/manage` and `POST/PUT /api/cities` are superadmin-only administration APIs.

- [ ] **Step 1: Add failing user isolation tests**

```python
def test_city_admin_lists_and_manages_only_own_city_users(two_city_client):
    seed_user("a-viewer", "viewer", city_id="city-a")
    seed_user("b-viewer", "viewer", city_id="city-b")
    login_city(two_city_client, "city-a", "admin")
    items = two_city_client.get("/api/users").get_json()["items"]
    assert {item["username"] for item in items} == {"a-viewer"}
    assert two_city_client.delete("/api/users/b-viewer").status_code == 403

def test_superadmin_can_assign_city_on_user_creation(two_city_client):
    login_city(two_city_client, None, "super_admin")
    response = two_city_client.post("/api/users", json={"username": "b-admin", "password": "secret123", "role": "admin", "cityId": "city-b"})
    assert response.status_code == 201
```

- [ ] **Step 2: Run focused user tests and confirm failure**

Run: `pytest tests/test_user_management.py tests/test_multi_city_isolation.py -k user -q`
Expected: FAIL because current user queries are global and create payloads have no city contract.

- [ ] **Step 3: Implement scoped user administration and city CRUD**

Merge the tenant predicate before role filters, hide global superadmin identities from city admins, force city assignment on city-admin creation, and prevent city-admin reassignment. Add superadmin city create/rename/activate/deactivate endpoints with duplicate-name checks and referenced-city deletion protection. Return record/user counts using scoped counts.

- [ ] **Step 4: Update UI and run focused tests**

Render city columns and a city selector only for superadmins; show a read-only current city for city admins. Run: `pytest tests/test_user_management.py tests/test_multi_city_isolation.py -k user -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add samaj/app.py samaj/templates/user-management.html samaj/static/user-management.js tests/test_user_management.py tests/test_multi_city_isolation.py
git commit -m "Stop city admins from managing another city's staff" -m "Confidence: high" -m "Scope-risk: broad" -m "Tested: user-management and cross-city user tests"
```

## Task 8: Scope Campaigns, Payments, Audience Resolution, and Contact Reveal

**Files:**
- Modify: `samaj/app.py`
- Modify: `samaj/campaign.py`
- Test: `tests/test_multi_city_isolation.py`, existing `tests/test_campaign*.py` endpoint/integration tests

**Interfaces:**
- `get_hof_by_area(filters, collection, query_scope=None)` and `get_areas_with_counts(filters, collection, query_scope=None)` apply the supplied scope before deduplication/counting.
- `resolve_recipients_by_ids(registration_ids, collection, salutations=None, query_scope=None)` never resolves an out-of-scope ID.
- Campaign creation stores the actor's `cityId`; superadmin may optionally provide an explicit city filter.

- [ ] **Step 1: Add failing campaign isolation tests**

```python
def test_campaign_audience_and_contact_reveal_never_cross_city(two_city_client):
    own_id = seed_registration(city_id="city-a", mobile="9800000001")
    other_id = seed_registration(city_id="city-b", mobile="9800000002")
    login_campaigner(two_city_client, "city-a")
    body = two_city_client.get("/api/campaigns/audience-preview").get_json()
    assert {item["registrationId"] for item in body["recipients"]} == {str(own_id)}
    assert two_city_client.post("/api/campaigns/reveal-contact", json={"registrationId": str(other_id)}).status_code in (403, 404)
```

- [ ] **Step 2: Run focused campaign tests and confirm failure**

Run: `pytest tests/test_campaign_audience_preview_endpoint.py tests/test_resolve_recipients_by_ids.py tests/test_multi_city_isolation.py -k campaign -q`
Expected: FAIL because campaign helpers currently query the shared registrations collection without scope.

- [ ] **Step 3: Implement scope propagation**

Pass `tenant_query()` into every audience/filter helper, reject selected recipient IDs outside scope, assign campaign/payment/message city from actor or campaign parent, and scope list/detail/submit/confirm/reject/report operations. Contact reveal must resolve only a record visible to the current actor. Preserve superadmin global behavior.

- [ ] **Step 4: Run campaign regression suite**

Run: `pytest tests/test_campaign*.py tests/test_multi_city_isolation.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add samaj/app.py samaj/campaign.py tests/test_campaign*.py tests/test_multi_city_isolation.py
git commit -m "Prevent campaigns from resolving cross-city recipients" -m "Directive: Recipient IDs must be re-resolved with tenant scope" -m "Confidence: high" -m "Scope-risk: broad" -m "Tested: full campaign test suite"
```

## Task 9: Scope WhatsApp/Public Supporting Records and Data Exports

**Files:**
- Modify: `samaj/app.py`
- Modify: `samaj/whatsapp_web_routes.py`
- Test: `tests/test_multi_city_isolation.py`, relevant WhatsApp/campaign/export tests

**Interfaces:**
- Supporting records inherit city from their parent account, user, campaign, or registration.
- City-scoped WhatsApp template/session routes use `tenant_query`; explicit superadmin-only backup and routing routes remain global by capability.

- [ ] **Step 1: Add failing supporting-data tests**

```python
def test_city_admin_cannot_export_or_read_other_city_supporting_data(two_city_client):
    seed_campaign(city_id="city-b")
    seed_whatsapp_template(city_id="city-b")
    login_city(two_city_client, "city-a", "campaign_admin")
    assert two_city_client.get("/api/campaigns").get_json()["items"] == []
    assert "city-b-template" not in two_city_client.get("/wa-web/templates").get_data(as_text=True)
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `pytest tests/test_multi_city_isolation.py -k 'supporting or export or whatsapp' -q`
Expected: FAIL or expose unscoped supporting routes.

- [ ] **Step 3: Implement inheritance and scope**

Audit each collection accessor in `app.py`, `campaign.py`, and `whatsapp_web_routes.py`. Add city to newly-created supporting documents, resolve parent city when handling existing ones, scope city-admin template/session/message access, and ensure superadmin-only backup routes are not accidentally widened to city staff.

- [ ] **Step 4: Run relevant regression tests**

Run: `pytest tests/test_multi_city_isolation.py tests/test_campaign*.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add samaj/app.py samaj/whatsapp_web_routes.py tests/test_multi_city_isolation.py
git commit -m "Close tenant exposure through supporting records" -m "Confidence: medium" -m "Scope-risk: broad" -m "Tested: supporting, export, WhatsApp, and campaign isolation tests"
```

## Task 10: Add Superadmin City and Transfer-History UI

**Files:**
- Modify: `samaj/templates/superadmin.html`
- Modify: `samaj/static/superadmin.js`
- Modify: `samaj/app.py`
- Test: `tests/test_multi_city_isolation.py`

**Interfaces:**
- `GET /api/cities/manage` returns city status/counts for superadmins.
- `POST /api/cities`, `PUT /api/cities/<id>`, and `POST /api/cities/<id>/status` implement city lifecycle.
- `GET /api/city-transfers` returns newest-first audited transfer rows and filters.

- [ ] **Step 1: Add failing superadmin API/UI contract tests**

```python
def test_superadmin_sees_city_counts_and_transfer_history(two_city_client):
    login_city(two_city_client, None, "super_admin")
    assert two_city_client.get("/api/cities/manage").status_code == 200
    assert two_city_client.get("/api/city-transfers").status_code == 200

def test_city_admin_cannot_open_city_management(two_city_client):
    login_city(two_city_client, "city-a", "admin")
    assert two_city_client.get("/api/cities/manage").status_code == 403
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `pytest tests/test_multi_city_isolation.py -k superadmin -q`
Expected: FAIL because city-management/history APIs and panels do not exist.

- [ ] **Step 3: Implement APIs and UI panels**

Add a Cities panel with status toggles, create/rename forms, counts, and staff-management links. Add a read-only City Transfer History table with source, destination, entity snapshot, actor, reason, timestamp, and filters. Keep all actions capability-checked and server-validated; never expose edit/delete history controls.

- [ ] **Step 4: Run API/UI contract tests**

Run: `pytest tests/test_multi_city_isolation.py -k superadmin -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add samaj/app.py samaj/templates/superadmin.html samaj/static/superadmin.js tests/test_multi_city_isolation.py
git commit -m "Make city lifecycle and transfers operable by superadmins" -m "Confidence: high" -m "Scope-risk: moderate" -m "Tested: superadmin city and transfer API tests"
```

## Task 11: Disabled-City Enforcement, Full Regression Matrix, and Static Audit

**Files:**
- Modify: `samaj/app.py`, `samaj/tenancy.py`, `samaj/db.py`
- Modify: `tests/test_multi_city_isolation.py`, all affected existing tests
- Optional: `docs/README` or deployment notes only if the repository has an established operations document

**Interfaces:**
- `disable_city` preserves all city-owned documents and makes the city unavailable for login, writes, and public selection.
- `validate_city_references` is callable from deployment/migration tooling and returns a non-OK result for any missing/invalid protected document.

- [ ] **Step 1: Add final failing matrix tests**

```python
def test_deactivated_city_preserves_records_but_blocks_login_and_new_writes(two_city_client):
    deactivate_city("city-a")
    assert staff_login(two_city_client, "a-admin").status_code == 401
    assert two_city_client.get("/api/cities/active").get_json()["items"] == [{"id": "city-b", "name": "City B"}]
    assert registrations.find_one({"cityId": "city-a"}) is not None

def test_two_city_direct_api_matrix_has_no_cross_city_leaks(two_city_client):
    for route in protected_city_routes:
        assert no_other_city_content(two_city_client, route, city_id="city-a")
```

- [ ] **Step 2: Run the complete suite to expose remaining leaks**

Run: `pytest -q`
Expected: failures identify any route or fixture still assuming global/unscoped data.

- [ ] **Step 3: Fix remaining route/query leaks and migration edge cases**

Search for every `find({})`, `find_one({"_id"`, `update_one({"_id"`, `delete_one({"_id"`, `count_documents(`, aggregate, campaign resolver, and raw database collection access in city-owned paths. Add the mandatory scope or explicitly document why the route is global and superadmin-only. Confirm disabled-city checks happen on login and protected request continuation.

- [ ] **Step 4: Run verification commands**

Run:

```bash
pytest -q
python -m compileall samaj
git diff --check origin/merasamaj...HEAD
```

Expected: all tests pass, compileall exits 0, and diff check reports no whitespace errors. If a configured lint/typecheck command exists, run it as well; otherwise record that this Python project has no dedicated lint/typecheck configuration.

- [ ] **Step 5: Commit the final hardening pass**

```bash
git add samaj tests
git commit -m "Prevent rollout while any tenant boundary remains unverified" -m "Confidence: high" -m "Scope-risk: broad" -m "Tested: pytest -q; python -m compileall samaj; git diff --check origin/merasamaj...HEAD" -m "Not-tested: Production MongoDB transaction topology"
```

## Plan Self-Review

- **Spec coverage:** Data model and indexes (Tasks 1-2); authentication and disabled cities (Tasks 3 and 11); public registration/review (Task 4); registration CRUD, directory, exports, and tools (Task 5); transfer/audit (Task 6); users/city lifecycle (Task 7); campaigns/payments/messages/audience (Task 8); supporting WhatsApp state (Task 9); superadmin UI/history (Task 10); complete verification and migration validation (Task 11).
- **Placeholder scan:** No TBD/TODO/"implement later" placeholders; each task includes concrete files, interfaces, tests, commands, and commit scope.
- **Type consistency:** `TenantScope`, `tenant_query`, `tenant_can_access`, `require_active_city`, migration functions, and campaign optional `query_scope` signatures are defined before downstream use.
- **Risk note:** Existing tests manually create sessions without database-backed users/cities. Tasks 3-4 explicitly update those fixtures to include valid city assignments while retaining superadmin-global fixtures.
