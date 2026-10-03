from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Mapping


class TenantError(ValueError):
    """Raised when a city-scoped request cannot establish a safe scope."""


@dataclass(frozen=True)
class TenantScope:
    is_global: bool
    city_id: Any | None
    reason: str


def normalize_city_name(value: str) -> tuple[str, str]:
    if not isinstance(value, str):
        raise ValueError("City name is required.")

    display_name = " ".join(value.split())
    if not display_name:
        raise ValueError("City name is required.")

    return display_name, display_name.casefold()


def is_superadmin(role: str | None) -> bool:
    return role == "super_admin"


def city_ids_match(left: Any, right: Any) -> bool:
    if left in (None, "") or right in (None, ""):
        return False

    return str(left) == str(right)


def scope_for_session(
    session_data: Mapping[str, Any],
    user_doc: Mapping[str, Any] | None,
    city_doc: Mapping[str, Any] | None,
) -> TenantScope:
    role = session_data.get("role")

    # Public sessions carry their own immutable city assignment and do not
    # have a staff user document. They still require an active city so public
    # reads/writes fail closed when a city is deactivated.
    if session_data.get("auth_type") == "public":
        session_city_id = session_data.get("cityId")
        if (
            not session_city_id
            or not city_doc
            or not city_ids_match(city_doc.get("_id"), session_city_id)
            or not city_doc.get("isActive", False)
        ):
            raise TenantError("Active city is required.")
        return TenantScope(
            is_global=False,
            city_id=session_city_id,
            reason="public",
        )

    if is_superadmin(role):
        if user_doc is not None and not user_doc.get("isActive", True):
            raise TenantError("User is inactive.")
        return TenantScope(
            is_global=True,
            city_id=None,
            reason="superadmin",
        )

    if not user_doc or not user_doc.get("isActive", True):
        raise TenantError("Active user is required.")

    session_city_id = session_data.get("cityId")
    user_city_id = user_doc.get("cityId")
    if not city_ids_match(session_city_id, user_city_id):
        raise TenantError("User city does not match the session.")

    if (
        not city_doc
        or not city_ids_match(city_doc.get("_id"), user_city_id)
        or not city_doc.get("isActive", False)
    ):
        raise TenantError("Active city is required.")

    return TenantScope(
        is_global=False,
        city_id=user_city_id,
        reason="staff",
    )


def scoped_query(
    scope: TenantScope,
    query: Mapping[str, Any] | None = None,
) -> dict:
    merged = deepcopy(dict(query or {}))
    if scope.is_global:
        return merged

    if not scope.city_id:
        raise TenantError("City scope is required.")

    if "cityId" in merged and merged["cityId"] != scope.city_id:
        raise TenantError("Query city does not match the current scope.")

    merged["cityId"] = scope.city_id
    return merged


def require_active_city(cities_collection, city_id) -> dict:
    if city_id is None or city_id == "":
        raise TenantError("City is required.")

    city = cities_collection.find_one({"_id": city_id})
    if not city or not city.get("isActive", False):
        raise TenantError("Active city is required.")

    return city


def transfer_registration(
    registrations,
    transfers,
    cities,
    registration_id,
    destination_city_id,
    actor,
    reason,
    scope,
) -> dict:
    """Move a registration between active cities with a durable audit row."""
    reason = str(reason or "").strip()
    if not reason:
        raise TenantError("Transfer reason is required.")

    destination = require_active_city(cities, destination_city_id)
    query_ids = [{"_id": registration_id}]
    try:
        from bson import ObjectId
        if not isinstance(registration_id, ObjectId):
            query_ids.append({"_id": ObjectId(str(registration_id))})
    except Exception:
        pass

    registration = None
    for query in query_ids:
        registration = registrations.find_one(query)
        if registration:
            break
    if not registration:
        raise TenantError("Registration not found.")

    source_city_id = registration.get("cityId")
    if not source_city_id:
        raise TenantError("Registration has no city assignment.")
    if not scope.is_global and not city_ids_match(source_city_id, scope.city_id):
        raise TenantError("Registration is outside the current city scope.")
    if city_ids_match(source_city_id, destination.get("_id")):
        raise TenantError("Destination city must differ from source city.")

    source = cities.find_one({"_id": source_city_id}) or {}
    actor_name = actor.get("username", "") if isinstance(actor, Mapping) else str(actor or "")
    actor_role = actor.get("role", "") if isinstance(actor, Mapping) else ""
    now = datetime.now(timezone.utc)
    update_query = {"_id": registration.get("_id"), "cityId": source_city_id}
    update = {"$set": {"cityId": destination.get("_id"), "updatedAt": now, "updatedBy": actor_name}}
    result = registrations.update_one(update_query, update)
    if getattr(result, "matched_count", 0) != 1:
        raise TenantError("Registration changed before transfer.")

    audit = {
        "entityType": "registration",
        "entityId": registration.get("_id"),
        "entityLabel": registration.get("invitationName") or registration.get("mobileNumber") or str(registration.get("_id")),
        "sourceCityId": source_city_id,
        "destinationCityId": destination.get("_id"),
        "sourceCityName": source.get("name", ""),
        "destinationCityName": destination.get("name", ""),
        "changedBy": actor_name,
        "changedByRole": actor_role,
        "reason": reason,
        "changedAt": now,
    }
    try:
        inserted = transfers.insert_one(audit)
    except Exception:
        registrations.update_one(
            {"_id": registration.get("_id"), "cityId": destination.get("_id")},
            {"$set": {"cityId": source_city_id, "updatedAt": now}},
        )
        raise

    return {"ok": True, "auditId": str(inserted.inserted_id)}
