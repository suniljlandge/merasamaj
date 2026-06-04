import unittest
from datetime import datetime, timezone

from bson import ObjectId

from samaj.app import create_app
from tests.test_user_management import FakeDatabase


def valid_registration_payload():
    return {
        "firstName": {"en": "Asha", "mr": ""},
        "middleName": {"en": "", "mr": ""},
        "lastName": {"en": "Patil", "mr": ""},
        "address1": {"en": "Main Road", "mr": ""},
        "address2": {"en": "", "mr": ""},
        "birthYear": "1998",
        "birthDate": "",
        "state": "Maharashtra",
        "district": "Washim",
        "taluka": "Washim",
        "mobileNumber": "9876543210",
        "familyMembers": [
            {
                "name": {"en": "Ramesh", "mr": ""},
                "relationToApplicant": "Father",
                "relation": "Father",
                "contactNumber": "9876543211",
            }
        ],
    }


class RegistrationPermissionsTests(unittest.TestCase):
    def setUp(self):
        self.database = FakeDatabase()
        self.registrations = self.database["registrations"]
        self.corrections = self.database["transliteration_corrections"]
        self.app = create_app(
            config={
                "TESTING": True,
                "SECRET_KEY": "test-secret",
            },
            collection=self.registrations,
            correction_collection=self.corrections,
        )
        self.client = self.app.test_client()

    def login_as(self, role, username):
        with self.client.session_transaction() as session:
            session.clear()
            session["auth_type"] = "staff"
            session["user_id"] = str(ObjectId())
            session["username"] = username
            session["role"] = role

    def test_operator_created_registration_records_creator(self):
        self.login_as("operator", "operator-one")

        response = self.client.post(
            "/api/registrations",
            json=valid_registration_payload(),
        )

        self.assertEqual(response.status_code, 201)
        registration = response.get_json()["registration"]
        self.assertEqual(
            registration["createdBy"],
            "operator-one",
        )

    def test_update_registration_preserves_created_by(self):
        registration_id = ObjectId()
        self.registrations.insert_one(
            {
                "_id": registration_id,
                **valid_registration_payload(),
                "createdBy": "operator-one",
                "createdAt": datetime.now(timezone.utc),
                "updatedAt": datetime.now(timezone.utc),
            }
        )
        self.login_as("admin", "admin-one")
        payload = valid_registration_payload()
        payload["address1"]["en"] = "Updated Address"

        response = self.client.put(
            f"/api/registrations/{registration_id}",
            json=payload,
        )

        self.assertEqual(response.status_code, 200)
        saved = self.registrations.find_one(
            {"_id": registration_id}
        )
        self.assertEqual(
            saved["createdBy"],
            "operator-one",
        )

    def test_staff_viewer_can_view_own_registration_only(self):
        own_id = ObjectId()
        other_id = ObjectId()
        self.registrations.insert_one(
            {
                "_id": own_id,
                **valid_registration_payload(),
                "createdBy": "viewer-one",
                "createdAt": datetime.now(timezone.utc),
                "updatedAt": datetime.now(timezone.utc),
            }
        )
        self.registrations.insert_one(
            {
                "_id": other_id,
                **valid_registration_payload(),
                "createdBy": "someone-else",
                "createdAt": datetime.now(timezone.utc),
                "updatedAt": datetime.now(timezone.utc),
            }
        )
        self.login_as("viewer", "viewer-one")

        own_response = self.client.get(
            f"/api/registrations/{own_id}"
        )
        other_response = self.client.get(
            f"/api/registrations/{other_id}"
        )

        self.assertEqual(own_response.status_code, 200)
        self.assertEqual(other_response.status_code, 403)

    def test_admin_can_view_any_family_tree(self):
        registration_id = ObjectId()
        self.registrations.insert_one(
            {
                "_id": registration_id,
                **valid_registration_payload(),
                "createdBy": "operator-one",
                "createdAt": datetime.now(timezone.utc),
                "updatedAt": datetime.now(timezone.utc),
            }
        )
        self.login_as("admin", "admin-one")

        response = self.client.get(
            f"/family-tree/{registration_id}"
        )

        self.assertEqual(response.status_code, 200)

    def test_super_admin_can_view_any_family_tree(self):
        registration_id = ObjectId()
        self.registrations.insert_one(
            {
                "_id": registration_id,
                **valid_registration_payload(),
                "createdBy": "operator-one",
                "createdAt": datetime.now(timezone.utc),
                "updatedAt": datetime.now(timezone.utc),
            }
        )
        self.login_as("super_admin", "root-user")

        response = self.client.get(
            f"/family-tree/{registration_id}"
        )

        self.assertEqual(response.status_code, 200)

    def test_operator_can_view_own_family_tree(self):
        registration_id = ObjectId()
        self.registrations.insert_one(
            {
                "_id": registration_id,
                **valid_registration_payload(),
                "createdBy": "operator-one",
                "createdAt": datetime.now(timezone.utc),
                "updatedAt": datetime.now(timezone.utc),
            }
        )
        self.login_as("operator", "operator-one")

        response = self.client.get(
            f"/family-tree/{registration_id}"
        )

        self.assertEqual(response.status_code, 200)

    def test_operator_can_view_other_operator_family_tree(self):
        registration_id = ObjectId()
        self.registrations.insert_one(
            {
                "_id": registration_id,
                **valid_registration_payload(),
                "createdBy": "operator-one",
                "createdAt": datetime.now(timezone.utc),
                "updatedAt": datetime.now(timezone.utc),
            }
        )
        self.login_as("operator", "operator-two")

        response = self.client.get(
            f"/family-tree/{registration_id}"
        )

        self.assertEqual(response.status_code, 200)

    def test_viewer_cannot_view_any_family_tree(self):
        registration_id = ObjectId()
        self.registrations.insert_one(
            {
                "_id": registration_id,
                **valid_registration_payload(),
                "createdBy": "viewer-one",
                "createdAt": datetime.now(timezone.utc),
                "updatedAt": datetime.now(timezone.utc),
            }
        )
        self.login_as("viewer", "viewer-one")

        response = self.client.get(
            f"/family-tree/{registration_id}"
        )

        self.assertEqual(response.status_code, 302)
        self.assertTrue(
            response.headers["Location"].endswith("/directory")
        )

    def test_staff_viewer_can_edit_own_registration_only(self):
        own_id = ObjectId()
        other_id = ObjectId()
        self.registrations.insert_one(
            {
                "_id": own_id,
                **valid_registration_payload(),
                "createdBy": "viewer-one",
                "createdAt": datetime.now(timezone.utc),
                "updatedAt": datetime.now(timezone.utc),
            }
        )
        self.registrations.insert_one(
            {
                "_id": other_id,
                **valid_registration_payload(),
                "createdBy": "someone-else",
                "createdAt": datetime.now(timezone.utc),
                "updatedAt": datetime.now(timezone.utc),
            }
        )
        self.login_as("viewer", "viewer-one")
        payload = valid_registration_payload()
        payload["address1"]["en"] = "Viewer Updated Address"

        own_response = self.client.put(
            f"/api/registrations/{own_id}",
            json=payload,
        )
        other_response = self.client.put(
            f"/api/registrations/{other_id}",
            json=payload,
        )

        self.assertEqual(own_response.status_code, 200)
        self.assertEqual(other_response.status_code, 403)

    def test_approved_public_viewer_can_view_and_edit_own_registration_only(self):
        own_id = ObjectId()
        other_id = ObjectId()
        account_id = ObjectId()
        self.registrations.insert_one(
            {
                "_id": own_id,
                **valid_registration_payload(),
                "createdBy": "self-register",
                "createdAt": datetime.now(timezone.utc),
                "updatedAt": datetime.now(timezone.utc),
            }
        )
        self.registrations.insert_one(
            {
                "_id": other_id,
                **valid_registration_payload(),
                "createdBy": "someone-else",
                "createdAt": datetime.now(timezone.utc),
                "updatedAt": datetime.now(timezone.utc),
            }
        )
        self.database["public_accounts"].insert_one(
            {
                "_id": account_id,
                "mobileNumber": "9876543210",
                "status": "approved",
                "approvedRegistrationId": own_id,
                "latestSubmissionId": "",
                "latestVersion": 1,
                "createdAt": datetime.now(timezone.utc),
                "updatedAt": datetime.now(timezone.utc),
            }
        )
        with self.client.session_transaction() as session:
            session.clear()
            session["auth_type"] = "public"
            session["public_account_id"] = str(account_id)
            session["public_mobile"] = "9876543210"
            session["public_status"] = "approved"
            session["role"] = "viewer"

        payload = valid_registration_payload()
        payload["address1"]["en"] = "Public Viewer Address"

        own_get = self.client.get(f"/api/registrations/{own_id}")
        other_get = self.client.get(f"/api/registrations/{other_id}")
        own_put = self.client.put(
            f"/api/registrations/{own_id}",
            json=payload,
        )
        other_put = self.client.put(
            f"/api/registrations/{other_id}",
            json=payload,
        )

        self.assertEqual(own_get.status_code, 200)
        self.assertEqual(other_get.status_code, 403)
        self.assertEqual(own_put.status_code, 202)
        self.assertEqual(other_put.status_code, 403)


if __name__ == "__main__":
    unittest.main()
