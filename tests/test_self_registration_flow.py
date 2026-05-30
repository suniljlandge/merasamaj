import unittest
from datetime import datetime, timedelta

from bson import ObjectId

from samaj.app import create_app
from tests.test_user_management import FakeDatabase


def build_valid_registration_payload():
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


class SelfRegistrationFlowTests(unittest.TestCase):
    def setUp(self):
        self.database = FakeDatabase()
        self.registrations = self.database["registrations"]
        self.corrections = self.database["transliteration_corrections"]
        self.users = self.database["users"]
        self.users.insert_one(
            {
                "_id": ObjectId(),
                "username": "root",
                "passwordHash": "hashed",
                "role": "super_admin",
                "isActive": True,
            }
        )
        self.users.insert_one(
            {
                "_id": ObjectId(),
                "username": "admin",
                "passwordHash": "hashed",
                "role": "admin",
                "isActive": True,
            }
        )

        self.app = create_app(
            config={
                "TESTING": True,
                "SECRET_KEY": "test-secret",
                "OTP_TEST_MODE": True,
                "OTP_FIXED_CODE": "123456",
            },
            collection=self.registrations,
            correction_collection=self.corrections,
        )
        self.client = self.app.test_client()

    def login_staff(self, role):
        with self.client.session_transaction() as session:
            session.clear()
            session["auth_type"] = "staff"
            session["user_id"] = str(ObjectId())
            session["username"] = role
            session["role"] = role

    def verify_public_mobile(self, mobile_number="9876543210"):
        response = self.client.post(
            "/api/public/request-otp",
            json={"mobileNumber": mobile_number},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.get_json()["otpCode"],
            "123456",
        )

        response = self.client.post(
            "/api/public/verify-otp",
            json={
                "mobileNumber": mobile_number,
                "otp": "123456",
            },
        )
        self.assertEqual(response.status_code, 200)
        return response.get_json()

    def test_public_request_and_verify_otp_creates_pending_account(self):
        payload = self.verify_public_mobile()

        self.assertEqual(payload["account"]["status"], "pending")
        self.assertEqual(payload["role"], "pending_public")

        public_accounts = self.database["public_accounts"]
        account = public_accounts.find_one(
            {"mobileNumber": "9876543210"}
        )
        self.assertIsNotNone(account)

    def test_test_provider_defaults_to_123456_without_explicit_fixed_code(self):
        app = create_app(
            config={
                "TESTING": True,
                "SECRET_KEY": "test-secret",
                "OTP_TEST_MODE": False,
                "OTP_FIXED_CODE": "",
            },
            collection=self.registrations,
            correction_collection=self.corrections,
        )
        client = app.test_client()
        self.database["app_settings"].insert_one(
            {
                "key": "otp_settings",
                "activeProvider": "test",
                "msg91": {},
                "metaWhatsApp": {},
            }
        )

        response = client.post(
            "/api/public/request-otp",
            json={"mobileNumber": "8888888888"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.get_json()["otpCode"],
            "123456",
        )

    def test_verify_otp_accepts_mongo_style_naive_expiry_datetime(self):
        self.database["public_otp"].insert_one(
            {
                "mobileNumber": "9999999999",
                "otpCode": "123456",
                "attempts": 0,
                "verifiedAt": None,
                "expiresAt": datetime.utcnow() + timedelta(minutes=5),
                "resendAvailableAt": datetime.utcnow() + timedelta(seconds=30),
                "createdAt": datetime.utcnow(),
                "updatedAt": datetime.utcnow(),
            }
        )

        response = self.client.post(
            "/api/public/verify-otp",
            json={
                "mobileNumber": "9999999999",
                "otp": "123456",
            },
        )

        self.assertEqual(response.status_code, 200)

    def test_pending_user_can_submit_and_edit_with_version_history(self):
        self.verify_public_mobile()
        payload = build_valid_registration_payload()

        create_response = self.client.post(
            "/api/self-registrations",
            json=payload,
        )

        self.assertEqual(create_response.status_code, 201)
        self.assertEqual(
            create_response.get_json()["submission"]["version"],
            1,
        )

        payload["address1"]["en"] = "Updated Main Road"
        edit_response = self.client.post(
            "/api/self-registrations",
            json=payload,
        )

        self.assertEqual(edit_response.status_code, 201)
        self.assertEqual(
            edit_response.get_json()["submission"]["version"],
            2,
        )

        history_response = self.client.get(
            "/api/self-registrations/me"
        )
        self.assertEqual(history_response.status_code, 200)
        history = history_response.get_json()["history"]

        self.assertEqual(
            [item["version"] for item in history],
            [2, 1],
        )

    def test_pending_user_cannot_access_directory(self):
        self.verify_public_mobile()
        response = self.client.get("/directory")

        self.assertEqual(response.status_code, 302)
        self.assertTrue(
            response.headers["Location"].endswith("/self-register")
        )

    def test_super_admin_can_save_provider_settings(self):
        self.login_staff("super_admin")

        response = self.client.put(
            "/api/otp-settings",
            json={
                "activeProvider": "meta_whatsapp",
                "msg91": {
                    "authKey": "msg91-key",
                    "widgetId": "widget-1",
                },
                "metaWhatsApp": {
                    "accessToken": "meta-token",
                    "phoneNumberId": "123456",
                    "templateName": "otp_template",
                    "templateLanguage": "en_US",
                },
            },
        )

        self.assertEqual(response.status_code, 200)
        settings_doc = self.database["app_settings"].find_one(
            {"key": "otp_settings"}
        )
        self.assertEqual(
            settings_doc["activeProvider"],
            "meta_whatsapp",
        )

    def test_admin_can_approve_latest_pending_submission(self):
        verify_payload = self.verify_public_mobile()
        account_id = verify_payload["account"]["id"]
        self.client.post(
            "/api/self-registrations",
            json=build_valid_registration_payload(),
        )

        self.login_staff("admin")
        response = self.client.post(
            f"/api/self-registrations/{account_id}/approve",
            json={"note": "Looks good"},
        )

        self.assertEqual(response.status_code, 200)
        public_account = self.database["public_accounts"].find_one(
            {"_id": ObjectId(account_id)}
        )
        self.assertEqual(
            public_account["status"],
            "approved",
        )
        self.assertTrue(public_account["approvedRegistrationId"])

        approved_registration = self.registrations.find_one(
            {"_id": ObjectId(public_account["approvedRegistrationId"])}
        )
        self.assertIsNotNone(approved_registration)

    def test_approved_public_user_gets_viewer_access_on_next_otp_login(self):
        verify_payload = self.verify_public_mobile()
        account_id = verify_payload["account"]["id"]
        self.client.post(
            "/api/self-registrations",
            json=build_valid_registration_payload(),
        )

        self.login_staff("admin")
        self.client.post(
            f"/api/self-registrations/{account_id}/approve",
            json={"note": "Approved"},
        )

        fresh_client = self.app.test_client()
        otp_request = fresh_client.post(
            "/api/public/request-otp",
            json={"mobileNumber": "9876543210"},
        )
        self.assertEqual(otp_request.status_code, 200)

        verify_response = fresh_client.post(
            "/api/public/verify-otp",
            json={
                "mobileNumber": "9876543210",
                "otp": "123456",
            },
        )

        self.assertEqual(verify_response.status_code, 200)
        self.assertEqual(
            verify_response.get_json()["role"],
            "viewer",
        )

        directory_response = fresh_client.get("/directory")
        self.assertEqual(directory_response.status_code, 200)

    def test_approved_public_viewer_edit_creates_pending_review_version(self):
        verify_payload = self.verify_public_mobile()
        account_id = verify_payload["account"]["id"]
        self.client.post(
            "/api/self-registrations",
            json=build_valid_registration_payload(),
        )

        self.login_staff("admin")
        self.client.post(
            f"/api/self-registrations/{account_id}/approve",
            json={"note": "Approved"},
        )

        approved_registration_id = self.database["public_accounts"].find_one(
            {"_id": ObjectId(account_id)}
        )["approvedRegistrationId"]

        fresh_client = self.app.test_client()
        fresh_client.post(
            "/api/public/request-otp",
            json={"mobileNumber": "9876543210"},
        )
        fresh_client.post(
            "/api/public/verify-otp",
            json={
                "mobileNumber": "9876543210",
                "otp": "123456",
            },
        )

        payload = build_valid_registration_payload()
        payload["address1"]["en"] = "Needs Review Address"
        response = fresh_client.put(
            f"/api/registrations/{approved_registration_id}",
            json=payload,
        )

        self.assertEqual(response.status_code, 202)
        body = response.get_json()
        self.assertEqual(body["redirectTo"], "/self-register")
        self.assertEqual(body["submission"]["version"], 2)

        public_account = self.database["public_accounts"].find_one(
            {"_id": ObjectId(account_id)}
        )
        self.assertEqual(public_account["status"], "pending")

        approved_registration = self.registrations.find_one(
            {"_id": ObjectId(approved_registration_id)}
        )
        self.assertEqual(
            approved_registration["address1"]["en"],
            "Main Road",
        )

        directory_response = fresh_client.get("/directory")
        self.assertEqual(directory_response.status_code, 302)
        self.assertTrue(
            directory_response.headers["Location"].endswith("/self-register")
        )


if __name__ == "__main__":
    unittest.main()
