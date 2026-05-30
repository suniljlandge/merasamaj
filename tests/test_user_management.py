import unittest
from copy import deepcopy

from bson import ObjectId

from samaj.app import create_app


class FakeInsertResult:
    def __init__(self, inserted_id):
        self.inserted_id = inserted_id


class FakeDeleteResult:
    def __init__(self, deleted_count):
        self.deleted_count = deleted_count


class FakeCursor:
    def __init__(self, documents):
        self.documents = documents

    def sort(self, field, direction):
        reverse = direction == -1
        self.documents.sort(
            key=lambda item: item.get(field) or "",
            reverse=reverse,
        )
        return self

    def limit(self, value):
        self.documents = self.documents[:value]
        return self

    def __iter__(self):
        return iter(self.documents)


class FakeCollection:
    def __init__(self, database, name, documents=None):
        self.database = database
        self.name = name
        self.documents = []

        for document in documents or []:
            self.insert_one(document)

    def create_index(self, *args, **kwargs):
        return None

    def find_one(self, query):
        for document in self.documents:
            if matches_query(document, query):
                return deepcopy(document)

        return None

    def find(self, query=None, projection=None):
        query = query or {}
        filtered = []

        for document in self.documents:
            if matches_query(document, query):
                filtered.append(
                    apply_projection(document, projection)
                )

        return FakeCursor(filtered)

    def insert_one(self, document):
        stored = deepcopy(document)
        stored.setdefault("_id", ObjectId())
        self.documents.append(stored)
        return FakeInsertResult(stored["_id"])

    def delete_one(self, query):
        for index, document in enumerate(self.documents):
            if all(document.get(key) == value for key, value in query.items()):
                self.documents.pop(index)
                return FakeDeleteResult(1)

        return FakeDeleteResult(0)


class FakeDatabase:
    def __init__(self):
        self.collections = {}

    def __getitem__(self, name):
        if name not in self.collections:
            self.collections[name] = FakeCollection(self, name)

        return self.collections[name]


def apply_projection(document, projection):
    cloned = deepcopy(document)

    if not projection:
        return cloned

    excluded_keys = [
        key
        for key, value in projection.items()
        if value == 0
    ]

    for key in excluded_keys:
        cloned.pop(key, None)

    return cloned


def matches_query(document, query):
    for key, value in query.items():
        if isinstance(value, dict):
            if "$ne" in value and document.get(key) == value["$ne"]:
                return False
            continue

        if document.get(key) != value:
            return False

    return True


class UserManagementTests(unittest.TestCase):
    def setUp(self):
        self.database = FakeDatabase()
        self.registrations = self.database["registrations"]
        self.corrections = self.database["transliteration_corrections"]
        self.users = self.database["users"]

        self.app = create_app(
            config={
                "TESTING": True,
                "SECRET_KEY": "test-secret",
            },
            collection=self.registrations,
            correction_collection=self.corrections,
        )

        self.client = self.app.test_client()

    def login_as(self, role):
        with self.client.session_transaction() as session:
            session["user_id"] = str(ObjectId())
            session["username"] = f"{role}-user"
            session["role"] = role

    def test_super_admin_can_create_admin_user(self):
        self.login_as("super_admin")

        response = self.client.post(
            "/api/users",
            json={
                "username": "new-admin",
                "password": "secret123",
                "role": "admin",
            },
        )

        self.assertEqual(response.status_code, 201)
        payload = response.get_json()

        self.assertTrue(payload["ok"])
        self.assertEqual(payload["user"]["username"], "new-admin")
        self.assertEqual(payload["user"]["role"], "admin")
        self.assertIsNotNone(
            self.users.find_one({"username": "new-admin"})
        )

    def test_admin_cannot_create_admin_user(self):
        self.login_as("admin")

        response = self.client.post(
            "/api/users",
            json={
                "username": "blocked-admin",
                "password": "secret123",
                "role": "admin",
            },
        )

        self.assertEqual(response.status_code, 403)
        self.assertEqual(
            response.get_json()["error"],
            "Forbidden",
        )
        self.assertIsNone(
            self.users.find_one({"username": "blocked-admin"})
        )

    def test_admin_can_create_operator_user(self):
        self.login_as("admin")

        response = self.client.post(
            "/api/users",
            json={
                "username": "new-operator",
                "password": "secret123",
                "role": "operator",
            },
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(
            response.get_json()["user"]["role"],
            "operator",
        )

    def test_viewer_cannot_access_user_management_page(self):
        self.login_as("viewer")

        response = self.client.get("/user-management")

        self.assertEqual(response.status_code, 302)
        self.assertTrue(
            response.headers["Location"].endswith("/directory")
        )

    def test_super_admin_can_delete_admin_user(self):
        self.users.insert_one(
            {
                "username": "admin-to-delete",
                "passwordHash": "hashed",
                "role": "admin",
                "isActive": True,
            }
        )
        self.login_as("super_admin")

        response = self.client.delete(
            "/api/users/admin-to-delete"
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["ok"])
        self.assertIsNone(
            self.users.find_one({"username": "admin-to-delete"})
        )

    def test_admin_can_delete_viewer_user(self):
        self.users.insert_one(
            {
                "username": "viewer-to-delete",
                "passwordHash": "hashed",
                "role": "viewer",
                "isActive": True,
            }
        )
        self.login_as("admin")

        response = self.client.delete(
            "/api/users/viewer-to-delete"
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["ok"])
        self.assertIsNone(
            self.users.find_one({"username": "viewer-to-delete"})
        )

    def test_admin_cannot_delete_admin_user(self):
        self.users.insert_one(
            {
                "username": "admin-peer",
                "passwordHash": "hashed",
                "role": "admin",
                "isActive": True,
            }
        )
        self.login_as("admin")

        response = self.client.delete(
            "/api/users/admin-peer"
        )

        self.assertEqual(response.status_code, 403)
        self.assertEqual(
            response.get_json()["error"],
            "Forbidden",
        )
        self.assertIsNotNone(
            self.users.find_one({"username": "admin-peer"})
        )

    def test_admin_list_hides_super_admin_users(self):
        self.users.insert_one(
            {
                "username": "root-user",
                "passwordHash": "hashed",
                "role": "super_admin",
                "isActive": True,
            }
        )
        self.users.insert_one(
            {
                "username": "viewer-user",
                "passwordHash": "hashed",
                "role": "viewer",
                "isActive": True,
            }
        )
        self.login_as("admin")

        response = self.client.get("/api/users")

        self.assertEqual(response.status_code, 200)
        items = response.get_json()["items"]

        self.assertEqual(
            [item["username"] for item in items],
            ["viewer-user"],
        )


if __name__ == "__main__":
    unittest.main()
