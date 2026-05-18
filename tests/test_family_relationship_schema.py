import unittest

from samaj.app import serialize_registration_document
from samaj.registration import normalize_registration, validate_registration


class FamilyRelationshipSchemaTests(unittest.TestCase):
    def test_registration_adds_family_identity_and_type(self):
        normalized = normalize_registration(
            {
                "firstName": {"en": "Asha"},
                "lastName": {"en": "Patil"},
                "address1": {"en": "Main Road"},
                "birthYear": "1998",
                "state": "Maharashtra",
                "district": "Washim",
                "taluka": "Washim",
                "mobileNumber": "9876543210",
                "familyType": "joint",
                "familyMembers": [],
            }
        )

        self.assertTrue(
            normalized["familyId"].startswith("family-")
        )
        self.assertEqual(
            normalized["familyType"],
            "joint",
        )
        self.assertEqual(
            normalized["primaryHouseholdId"],
            "household-primary",
        )

    def test_old_relation_is_normalized_to_relation_to_applicant(self):
        normalized = normalize_registration(
            {
                "firstName": {"en": "Asha"},
                "lastName": {"en": "Patil"},
                "address1": {"en": "Main Road"},
                "birthYear": "1998",
                "state": "Maharashtra",
                "district": "Washim",
                "taluka": "Washim",
                "mobileNumber": "9876543210",
                "familyMembers": [
                    {
                        "name": {"en": "Ramesh"},
                        "relation": "Father",
                        "contactNumber": "9876543211",
                    }
                ],
            }
        )

        member = normalized["familyMembers"][0]

        self.assertEqual(
            member["relationToApplicant"],
            "Father",
        )
        self.assertTrue(
            member["personId"].startswith("person-")
        )
        self.assertEqual(
            member["memberId"],
            member["personId"],
        )
        self.assertEqual(
            member["householdId"],
            "household-primary",
        )
        self.assertEqual(
            member["relationshipLinks"],
            [],
        )
        self.assertEqual(
            member["spouseMemberId"],
            "",
        )

    def test_new_relation_and_link_fields_are_preserved(self):
        normalized = normalize_registration(
            {
                "firstName": {"en": "Asha"},
                "lastName": {"en": "Patil"},
                "address1": {"en": "Main Road"},
                "birthYear": "1998",
                "state": "Maharashtra",
                "district": "Washim",
                "taluka": "Washim",
                "mobileNumber": "9876543210",
                "familyMembers": [
                    {
                        "memberId": "m-child",
                        "personId": "p-child",
                        "householdId": "hh-sonal",
                        "name": {"en": "Sonal"},
                        "relationToApplicant": "Daughter",
                        "contactNumber": "9876543212",
                        "spouseMemberId": "m-spouse",
                        "relationshipLinks": [
                            {
                                "type": "spouse_of",
                                "targetPersonId": "p-spouse",
                            },
                            {
                                "type": "parent_of",
                                "targetPersonId": "p-grandchild",
                            },
                            {
                                "type": "",
                                "targetPersonId": "ignored",
                            },
                        ],
                    }
                ],
            }
        )

        member = normalized["familyMembers"][0]

        self.assertEqual(
            member["personId"],
            "p-child",
        )
        self.assertEqual(
            member["memberId"],
            "p-child",
        )
        self.assertEqual(
            member["householdId"],
            "hh-sonal",
        )
        self.assertEqual(
            member["relationToApplicant"],
            "Daughter",
        )
        self.assertEqual(
            member["spouseMemberId"],
            "m-spouse",
        )
        self.assertEqual(
            member["relationshipLinks"],
            [
                {
                    "type": "spouse_of",
                    "targetPersonId": "p-spouse",
                },
                {
                    "type": "parent_of",
                    "targetPersonId": "p-grandchild",
                },
            ],
        )

    def test_client_serialization_adds_backward_compatible_relation_alias(self):
        serialized = serialize_registration_document(
            {
                "familyMembers": [
                    {
                        "name": {"en": "Sonal", "mr": ""},
                        "relationToApplicant": "Daughter",
                        "contactNumber": "9876543212",
                    },
                    {
                        "name": {"en": "Ramesh", "mr": ""},
                        "relation": "Father",
                        "contactNumber": "9876543211",
                    },
                ]
            }
        )

        first_member = serialized["familyMembers"][0]
        second_member = serialized["familyMembers"][1]

        self.assertEqual(
            first_member["relationToApplicant"],
            "Daughter",
        )
        self.assertEqual(
            first_member["relation"],
            "Daughter",
        )
        self.assertEqual(
            second_member["relationToApplicant"],
            "Father",
        )
        self.assertEqual(
            second_member["relation"],
            "Father",
        )

    def test_members_count_includes_home_spouses_but_excludes_married_daughters(self):
        normalized = normalize_registration(
            {
                "firstName": {"en": "Asha"},
                "lastName": {"en": "Patil"},
                "address1": {"en": "Main Road"},
                "birthYear": "1998",
                "state": "Maharashtra",
                "district": "Washim",
                "taluka": "Washim",
                "mobileNumber": "9876543210",
                "familyMembers": [
                    {
                        "name": {"en": "Ravi"},
                        "relationToApplicant": "Son",
                        "contactNumber": "9876543211",
                        "isMarried": True,
                        "spouseName": {"en": "Neha"},
                        "spouseContactNumber": "9876543212",
                        "currentCity": "Washim",
                    },
                    {
                        "name": {"en": "Suresh"},
                        "relationToApplicant": "Brother",
                        "contactNumber": "9876543213",
                        "isMarried": True,
                        "spouseName": {"en": "Kavita"},
                        "spouseContactNumber": "9876543214",
                        "currentCity": "Washim",
                    },
                    {
                        "name": {"en": "Meena"},
                        "relationToApplicant": "Daughter",
                        "contactNumber": "9876543215",
                        "isMarried": True,
                        "spouseName": {"en": "Amit"},
                        "spouseContactNumber": "9876543216",
                        "currentCity": "Pune",
                    },
                    {
                        "name": {"en": "Sunita"},
                        "relationToApplicant": "Sister",
                        "contactNumber": "9876543217",
                        "isMarried": True,
                        "spouseName": {"en": "Raj"},
                        "spouseContactNumber": "9876543218",
                        "currentCity": "Nagpur",
                    },
                    {
                        "name": {"en": "Mohan"},
                        "relationToApplicant": "Father",
                        "contactNumber": "9876543219",
                    },
                ],
            }
        )

        self.assertEqual(
            normalized["membersCount"],
            5,
        )

    def test_married_status_does_not_require_nested_spouse_details(self):
        result = validate_registration(
            {
                "firstName": {"en": "Asha"},
                "lastName": {"en": "Patil"},
                "address1": {"en": "Main Road"},
                "birthYear": "1998",
                "state": "Maharashtra",
                "district": "Washim",
                "taluka": "Washim",
                "mobileNumber": "9876543210",
                "familyMembers": [
                    {
                        "name": {"en": "Suman"},
                        "relationToApplicant": "Mother",
                        "contactNumber": "9876543211",
                        "isMarried": True,
                    }
                ],
            }
        )

        self.assertTrue(
            result["valid"],
            result["errors"],
        )


if __name__ == "__main__":
    unittest.main()
