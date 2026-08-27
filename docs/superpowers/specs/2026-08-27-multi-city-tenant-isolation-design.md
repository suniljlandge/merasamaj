# Multi-City Tenant Isolation Design

## Purpose

SAMAJ currently operates as a single-city application. This change makes the
application usable by multiple cities while preventing a city's staff from
reading, modifying, deleting, exporting, or administering another city's data.
Superadmins retain cross-city control.

The existing installation and all existing city-owned data will become part of
the initial city, **Washim**.

## Approved Requirements

- Every city has isolated users and data.
- A city admin and the users they manage can access only their assigned city.
- A superadmin can access and manage all cities, users, and records.
- Public registrants select an active city from a dropdown.
- A public submission is reviewed only by admins of its selected city, while
  remaining visible to superadmins.
- A city admin may transfer a record to another active city. Once transferred,
  the source admin immediately loses access to it.
- A superadmin may transfer records between any cities.
- Every transfer records its source, destination, record, actor, timestamp, and
  reason in an append-only application audit history.
- Superadmins receive city-management and city-transfer-history views.
- Deactivating a city preserves its data but blocks its users from logging in
  and removes the city from public registration choices.

## Chosen Architecture

Use one MongoDB database and shared collections, with a required `cityId` field
on every city-owned document. This preserves the application's current storage
model and makes cross-city superadmin reporting practical.

Separate databases per city were rejected because they would duplicate
configuration and indexes, complicate migrations, and make superadmin queries
and record transfers expensive. Separate collections per city were rejected
because collection routing would spread throughout the application and produce
the same cross-city reporting difficulties.

City isolation is an authorization concern enforced on the server. Browser
filters and dropdowns improve usability but never establish access rights.

## Data Model

### Cities

Create a `cities` collection with documents shaped as follows:

```json
{
  "_id": "ObjectId",
  "name": "Washim",
  "nameKey": "washim",
  "isActive": true,
  "createdAt": "datetime",
  "createdBy": "username",
  "updatedAt": "datetime",
  "updatedBy": "username"
}
```

`nameKey` is a normalized case-insensitive key with a unique index. City names
may be renamed without changing their immutable `_id`.

### City-Owned Documents

The following document families are city-owned and require `cityId`:

- staff users except the global superadmin identity
- public accounts
- registrations and their embedded family members
- self-registration submissions
- campaigns
- campaign payments
- campaign messages and delivery state
- temporary or supporting records whose authorization is inherited from one of
  the above, including applicable WhatsApp/public-login state
- future records that belong to a city's operations

Embedded family members inherit the parent registration's city and do not have
independent city assignments.

Global configuration may remain unscoped only when it is explicitly intended
to apply to all cities. Settings that control city operations must either carry
`cityId` or be represented as a global default plus city override. The first
implementation should scope existing operational settings only where differing
city behavior is required; it must not silently expose city-owned content.

### Transfer History

Create a `city_transfers` collection:

```json
{
  "_id": "ObjectId",
  "entityType": "registration",
  "entityId": "ObjectId or stable string",
  "entityLabel": "human-readable snapshot",
  "sourceCityId": "ObjectId",
  "destinationCityId": "ObjectId",
  "changedBy": "username",
  "changedByRole": "admin",
  "reason": "required text",
  "changedAt": "datetime"
}
```

Transfer entries are never editable or deletable through application routes.
The label is a snapshot for audit readability; the entity ID remains the
authoritative reference.

## Authentication and Request Scope

Successful city-user authentication stores the user's `cityId` in the session
alongside the existing identity and role fields. Each protected request still
validates the current user and city state from the database where security or
city activation can have changed since login.

- A `super_admin` session has global scope.
- Every other staff session has exactly one valid active `cityId`.
- Public accounts and submissions have exactly one city assignment.
- A user belonging to an inactive city cannot start or continue an authorized
  city session.
- A missing, malformed, deleted, or mismatched city assignment fails closed.

The system must not accept a client-supplied city as authorization. A city
parameter may narrow a superadmin query, but it cannot widen a city user's
session scope.

## Central Authorization Boundary

Introduce focused tenant helpers rather than duplicating raw checks across
routes. Their responsibilities are:

- resolve the current actor's city scope
- determine whether the actor has global superadmin scope
- merge a mandatory city predicate into MongoDB queries
- verify that a loaded document belongs to the actor's city
- validate active destination cities
- reject invalid or unscoped protected operations consistently

Every protected list, count, aggregate, detail, insert, update, delete, export,
campaign, review, and user-management operation must use these helpers. Existing
role capabilities remain in effect in addition to city scope; city membership
does not grant a capability that the role lacks.

For city-scoped users:

- list/count/aggregate queries always include their `cityId`
- detail/update/delete queries include both the record identity and `cityId`
- inserted records receive the session city from the server
- user creation automatically assigns the creator's city
- attempts to name another city in an ordinary create/update payload are
  ignored or rejected

Superadmin operations may omit the city predicate or explicitly filter by a
chosen city.

## Record Transfers

A dedicated transfer operation changes city ownership. Ordinary update routes
must not permit `cityId` changes.

Transfer authorization:

- superadmins may transfer a supported entity from any city to any active city
- city admins may transfer only an entity currently inside their own city
- the destination must be a different active city
- the reason is required
- roles without city-administration authority cannot transfer records

The ownership change and transfer-history insert must behave atomically. Use a
MongoDB transaction when the deployment supports transactions. If transactions
are unavailable in the configured MongoDB topology, use a guarded transfer
workflow that writes a pending audit record, performs a conditional ownership
update matching the source city, finalizes the audit record, and compensates on
failure. A transfer must never report success without a durable audit event.

After a successful city-admin transfer, the response contains only a success
confirmation and audit identifier; it must not return the now-out-of-scope
record. Subsequent reads by the source admin fail the normal scope check.

## Public Registration

The public registration page loads active cities from a public, read-only city
endpoint exposing only identifiers and display names. A city choice is required.

On submission, the server verifies that the selected city exists and is active,
then assigns its `cityId` to both the public account where applicable and the
self-registration submission. Review queues are city-scoped. Approval creates
the final registration with the same city assignment; the client cannot change
the city during approval.

If a city becomes inactive after submission but before review, the submission
is preserved. City users cannot process it while their city is inactive;
superadmins can review it or transfer it to another active city.

## User Administration

- Superadmins can create city admins and other staff for any active city and can
  reassign staff between cities.
- City admins can list, create, change passwords for, activate/deactivate, and
  delete only manageable users in their own city, subject to the existing role
  hierarchy and capability rules.
- A city admin cannot create or reassign a user into another city.
- Superadmin identities are global and must not appear in city-admin user lists.
- Deactivating a city blocks all non-superadmin staff assigned to it without
  deleting those accounts.

Staff reassignment is a superadmin operation. Record-transfer permissions do
not imply permission to transfer staff accounts.

## Superadmin Experience

Add these superadmin-only surfaces:

### City Management

- list cities with active status and basic record/user counts
- create a city
- rename a city
- activate or deactivate a city
- open city-filtered user and record views
- assign or reassign city admins

Cities are deactivated, not deleted, once referenced by users, records, or audit
history. This preserves referential and reporting integrity.

### City Transfer History

- list transfers newest first
- filter by source city, destination city, actor, entity type, and date range
- show the entity label and link to the entity when the superadmin can still
  access it
- show source and destination city names as historical display values even if a
  city is later renamed

The history interface has no edit or delete action.

## Disabled-City Behavior

Deactivation is reversible and preserves all records.

- the city disappears from public registration choices
- new city-owned writes targeting it are rejected
- its non-superadmin users cannot log in
- existing sessions lose access when the city is checked on the next protected
  request
- superadmins retain read, reporting, transfer, and reactivation access
- records may be transferred from an inactive city only by a superadmin

## Migration and Rollout

The migration is idempotent and runs before city scoping is enforced:

1. Create or locate the active city named Washim.
2. Backfill all existing city-owned records and non-superadmin users with the
   Washim `cityId`.
3. Backfill related campaign, payment, message, public-account, self-registration,
   and supporting documents using their parent relationship where possible,
   otherwise assign Washim as the legacy default.
4. Add city-aware indexes after backfill, including compound indexes matching
   existing high-use queries.
5. Validate that every city-owned document references an existing city.
6. Report counts by collection and abort tenant enforcement when any orphaned or
   unscoped protected document remains.
7. Enable scoped authorization and inactive-city enforcement.

Re-running the migration must not create duplicate cities, overwrite deliberate
post-migration city assignments, or duplicate transfer history.

## Error Handling

- `400 Bad Request`: missing/invalid city selection, destination equals source,
  or missing transfer reason
- `401 Unauthorized`: no valid authenticated session
- `403 Forbidden`: role lacks permission, cross-city access attempt, or inactive
  city session
- `404 Not Found`: a scoped entity is absent; detail/update/delete operations may
  use `404` rather than reveal that another city's entity exists
- `409 Conflict`: duplicate city name, stale transfer source, or another
  concurrent ownership change

Protected operations fail closed. API errors must not reveal another city's
record content or confirm sensitive cross-city identifiers beyond what a
superadmin is authorized to see.

## Verification Strategy

Automated tests must prove the security boundary, not only the UI behavior.

### Migration

- Washim is created once and is active.
- Existing documents receive Washim's ID.
- Re-running the migration is idempotent.
- Missing/invalid assignments cause validation failure.

### Authentication

- active city users can log in
- inactive city users cannot log in or continue a protected session
- superadmin login remains global

### Isolation

For two cities, tests verify that city staff cannot list, view, update, delete,
count, aggregate, export, campaign against, or administer the other city's
records and users. Tests make direct HTTP requests with another city's IDs to
prove server-side enforcement.

### Public Registration

- only active cities appear in the dropdown endpoint
- invalid or inactive city submissions are rejected
- submissions appear only in the selected city's review queue
- approval preserves the submitted city

### Transfers

- city admin can transfer a record from their own city to an active destination
- source admin loses access immediately
- destination staff gains normal scoped access
- cross-city source transfers by city admins are rejected
- superadmin can transfer across any cities
- stale/concurrent transfers fail without corrupting ownership
- every successful transfer has exactly one complete audit record
- failed audit persistence does not produce an unaudited successful transfer

### User and City Management

- city admins manage only allowed roles in their own city
- city admins cannot assign or reassign users to another city
- superadmins can manage all cities and assignments
- deactivation preserves data and blocks city operations

## Compatibility and Scope Boundaries

- No new external dependency is required.
- Existing role/capability behavior remains unless tenant isolation requires a
  stricter check.
- The change does not introduce separate databases, domains, deployments, or
  per-city branding.
- The initial implementation focuses on strict city isolation, city lifecycle,
  transfers, migration, and administration. More granular per-city settings can
  be added later using the same `cityId` boundary.

## Completion Criteria

The feature is complete when:

- all existing protected data belongs to Washim or another valid city
- every city-owned server operation enforces tenant scope
- city admins cannot access another city's data through UI or direct API calls
- public registrations route to the selected active city
- transfers are durable, audited, and immediately change visibility
- inactive-city behavior matches this specification
- superadmins can manage cities, assignments, all records, and transfer history
- the full automated test suite passes with dedicated cross-city regression tests
