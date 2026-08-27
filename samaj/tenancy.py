from copy import deepcopy
from dataclasses import dataclass
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


def scope_for_session(
    session_data: Mapping[str, Any],
    user_doc: Mapping[str, Any] | None,
    city_doc: Mapping[str, Any] | None,
) -> TenantScope:
    role = session_data.get("role")

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
    if not session_city_id or session_city_id != user_city_id:
        raise TenantError("User city does not match the session.")

    if (
        not city_doc
        or city_doc.get("_id") != session_city_id
        or not city_doc.get("isActive", False)
    ):
        raise TenantError("Active city is required.")

    return TenantScope(
        is_global=False,
        city_id=session_city_id,
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
