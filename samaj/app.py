import os
import re
import secrets
from datetime import datetime, timedelta, timezone
import bcrypt
import requests
from pymongo import MongoClient
from bson import ObjectId
from flask import (
    Flask,
    render_template,
    request,
    jsonify,
    session,
    redirect,
    url_for,
    current_app,
)
from flask_session import Session

from .registration import (
    clean_text,
    normalize_relationship_links,
    normalize_phone,
    validate_registration,
)
from .transliterate import (
    transliteration_suggestions,
    transliterate_to_marathi,
)
from .db import (
    create_collections,
    get_database,
)

from .migration import (
    transform_old_record,
    find_duplicate,
    regenerate_marathi_fields,
)

from .corrections import (
    collect_transliteration_corrections,
    load_corrections,
    save_corrections,
    )


def build_corrected_phrase(text, corrections):
    words = text.split()

    result = []
    i = 0

    while i < len(words):

        matched = False

        # Try 4-word phrase
        for size in [4, 3, 2]:

            if i + size > len(words):
                continue

            phrase = " ".join(
                words[i:i + size]
            ).lower().strip()

            if phrase in corrections:
                result.append(
                    corrections[phrase]
                )
                i += size
                matched = True
                break

        if matched:
            continue

        result.append(
            transliterate_to_marathi(
                words[i],
                corrections
            )
        )

        i += 1

    return " ".join(result)

def create_app(config=None, collection=None, correction_collection=None):
    app = Flask(__name__)

    app.config["SECRET_KEY"] = (
        "samaj-secret-key"
    )

    session_db = get_database({
        "MONGO_URI": os.getenv(
            "MONGO_URI",
            "mongodb://127.0.0.1:27017"
        ),
        "MONGO_DB": os.getenv(
            "MONGO_DB",
            "samaj"
        ),
    })

    app.config["SESSION_TYPE"] = "mongodb"
    app.config["SESSION_MONGODB"] = session_db.client
    app.config["SESSION_MONGODB_DB"] = session_db.name
    app.config["SESSION_MONGODB_COLLECT"] = "sessions"

    app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(days=30)
    app.config["SESSION_PERMANENT"] = True

    Session(app)

    print("SESSION_TYPE =", app.config["SESSION_TYPE"])
    print(
        "SESSION_MONGODB_COLLECT =",
        app.config.get("SESSION_MONGODB_COLLECT")
    )
    print(
        "SESSION_MONGODB_COLLECTION =",
        app.config.get("SESSION_MONGODB_COLLECTION")
    )

    app.config.update(
        MONGO_URI=os.getenv("MONGO_URI", "mongodb://127.0.0.1:27017"),
        MONGO_DB=os.getenv("MONGO_DB", "samaj"),
        MONGO_COLLECTION=os.getenv("MONGO_COLLECTION", "registrations"),
        MONGO_CORRECTIONS_COLLECTION=os.getenv(
            "MONGO_CORRECTIONS_COLLECTION",
            "transliteration_corrections",
        ),
        OTP_TEST_MODE=env_flag("OTP_TEST_MODE"),
        OTP_FIXED_CODE=os.getenv("OTP_FIXED_CODE", "").strip(),
    )

    if config:
        app.config.update(config)

    app.extensions["mongo_client"] = None
    app.extensions["mongo_collection"] = collection
    app.extensions["mongo_correction_collection"] = correction_collection

    @app.route("/")
    def index():

        if not require_auth():
            return redirect("/login")

        if is_pending_public_session():
            return redirect(
                "/self-register"
            )

        role = current_role()

        if role == "viewer":
            return redirect(
                "/directory"
            )

        return render_template(
            "index.html"
        )

    @app.route("/view-member/<id>")
    def view_member_page(id):

        if not can_access_directory():
            return redirect("/login")

        document_id = object_id_or_none(id)

        if not document_id:
            return redirect("/directory")

        document = (
            get_collection()
            .find_one({
                "_id": document_id
            })
        )

        if not can_view_registration(document):
            return redirect("/directory")

        return render_template(
            "view-member.html",
            current_role=session.get("role")
        )

    @app.route("/family-tree/<id>")
    def family_tree_page(id):

        if not can_access_directory():
            return redirect("/login")

        document_id = object_id_or_none(id)

        if not document_id:
            return redirect("/directory")

        document = (
            get_collection()
            .find_one({
                "_id": document_id
            })
        )

        if not can_view_family_tree(document):
            return redirect("/directory")

        return render_template(
            "family-tree.html",
            current_role=current_role(),
        )

    @app.route("/self-register")
    def self_register_page():

        if not is_public_session():
            return redirect("/login")

        if session.get("public_status") == "approved":
            return redirect("/directory")

        public_account = (
            get_public_accounts_collection()
            .find_one({
                "_id": ensure_object_id(
                    session["public_account_id"]
                )
            })
        )

        if not public_account:
            session.clear()
            return redirect("/login")

        latest_submission = None
        latest_submission_id = public_account.get(
            "latestSubmissionId"
        )

        if latest_submission_id:
            latest_submission = (
                get_self_registrations_collection()
                .find_one({
                    "_id": latest_submission_id
                })
            )

        return render_template(
            "self-register.html",
            current_role=current_role(),
            public_account=serialize_public_account(
                public_account
            ),
            initial_submission=serialize_self_registration(
                latest_submission or {}
            ),
        )

    @app.route("/otp-settings")
    def otp_settings_page():

        if not require_role(
            "super_admin"
        ):
            return redirect("/directory")

        return render_template(
            "otp-settings.html",
            current_role=current_role()
        )

    @app.route("/self-registration-review")
    def self_registration_review_page():

        if not require_role(
            "admin",
            "super_admin"
        ):
            return redirect("/directory")

        return render_template(
            "self-registration-review.html",
            current_role=current_role()
        )

    @app.route("/user-management")
    def user_management_page():

        if not require_role(
            "admin",
            "super_admin"
        ):
            return redirect("/directory")

        return render_template(
            "user-management.html",
            current_role=session.get("role"),
            allowed_roles=get_assignable_roles(
                current_role()
            )
        )

    @app.post("/api/bulk-import")
    def bulk_import_endpoint():

        if not require_role(
            "admin",
            "super_admin"
        ):
            return jsonify({
                "error": "Forbidden"
            }), 403

        payload = request.get_json(silent=True)

        if not isinstance(payload, list):
            return jsonify({
                "error": "Array payload required"
            }), 400

        collection = get_collection()

        correction_store = (
            get_correction_collection()
        )

        overrides = load_corrections(
            correction_store
        )

        imported = []
        duplicates = []
        invalid = []

        for index, item in enumerate(payload):

            try:

                transformed = transform_old_record(
                    item,
                    overrides,
                )

                validation = validate_registration(
                    transformed,
                    overrides,
                )

                if not validation["valid"]:

                    invalid.append({
                        "index": index,
                        "errors": validation["errors"]
                    })

                    continue

                normalized = validation["value"]

                duplicate = find_duplicate(
                    normalized
                )

                if duplicate:

                    duplicates.append({
                        "index": index,
                        "existingId": str(
                            duplicate["_id"]
                        ),
                        "mobileNumber": duplicate.get(
                            "mobileNumber"
                        ),
                    })

                    continue

                result = collection.insert_one(
                    normalized
                )

                corrections = (
                    collect_transliteration_corrections(
                        normalized,
                        overrides,
                    )
                )

                save_corrections(
                    correction_store,
                    corrections,
                )

                imported.append({
                    "index": index,
                    "insertedId": str(
                        result.inserted_id
                    )
                })

            except Exception as error:

                invalid.append({
                    "index": index,
                    "error": str(error)
                })

        return jsonify({
            "ok": True,

            "summary": {
                "imported": len(imported),
                "duplicates": len(duplicates),
                "invalid": len(invalid),
            },

            "importedRecords": imported,
            "duplicates": duplicates,
            "invalidRecords": invalid,
        })

    @app.route("/edit-member/<id>")
    def edit_member_page(id):
        document_id = object_id_or_none(id)

        if not document_id:
            return redirect("/directory")

        document = (
            get_collection()
            .find_one({
                "_id": document_id
            })
        )

        if not can_edit_registration(
            document
        ):
            return redirect("/directory")

        return render_template(
            "edit-member.html",
            current_role=session.get("role")
        )

    @app.route("/directory")
    def directory():

        if not require_auth():
            return redirect("/login")

        if is_pending_public_session():
            return redirect("/self-register")

        if not can_access_directory():
            return redirect("/login")

        return render_template(
            "directory.html",
            current_role=current_role(),
            current_username=session.get("username", ""),
            current_owned_registration_id=current_owned_registration_id(),
        )

    @app.route("/operator-leaderboard")
    def operator_leaderboard_page():

        if not require_role(
            "admin",
            "super_admin"
        ):
            return redirect("/directory")

        return render_template(
            "operator-leaderboard.html",
            current_role=current_role()
        )

    @app.get("/api/operator-performance")
    def operator_performance():

        if not require_role(
            "admin",
            "super_admin"
        ):
            return jsonify({
                "error": "Forbidden"
            }), 403

        pipeline = [
            {
                "$group": {
                    "_id": "$createdBy",
                    "count": {
                        "$sum": 1
                    }
                }
            },
            {
                "$sort": {
                    "count": -1
                }
            }
        ]

        results = list(
            get_collection().aggregate(
                pipeline
            )
        )

        total_registrations = sum(
            row["count"]
            for row in results
        )

        items = []

        for row in results:

            count = row["count"]

            share = round(
                (
                    count
                    / total_registrations
                ) * 100,
                1
            ) if total_registrations else 0

            items.append({
                "name":
                    row["_id"]
                    or "Legacy Records",
                "count": count,
                "share": share
            })

        users_collection = (
            get_users_collection()
        )

        total_operators = (
            users_collection.count_documents({
                "role": "operator"
            })
        )

        active_operators = len([
            item
            for item in items
            if item["name"]
            not in [
                "Legacy Records"
            ]
        ])

        top_operator = (
            items[0]["name"]
            if items
            else "-"
        )

        return jsonify({
            "total":
                total_registrations,

            "items":
                items,

            "activeOperators":
                active_operators,

            "totalOperators":
                total_operators,

            "topOperator":
                top_operator
        })

    @app.get("/api/health")
    def health():
        return jsonify({"ok": True})

    @app.route(
        "/logout",
        methods=["GET", "POST"]
    )
    def logout():

        session.clear()

        return redirect("/login")


    @app.get("/api/export")
    def export():

        if not require_role(
            "super_admin",
            "admin"
        ):
            return jsonify({
                "error": "Forbidden"
            }), 403

    @app.route(
        "/login",
        methods=["GET", "POST"]
    )
    def login():

        if request.method == "GET":
            if require_auth():
                if is_pending_public_session():
                    return redirect("/self-register")

                if current_role() == "viewer":
                    return redirect("/directory")

                return redirect("/")

            return render_template(
                "login.html"
            )

        payload = request.get_json()

        username = (
            payload.get("username", "")
            .strip()
        )

        password = payload.get(
            "password",
            ""
        )

        user = (
            get_users_collection()
            .find_one({
                "username": username
            })
        )

        if not user:
            return jsonify({
                "error": "Invalid credentials"
            }), 401

        valid = bcrypt.checkpw(
            password.encode(),
            user["passwordHash"].encode()
        )

        if not valid:
            return jsonify({
                "error": "Invalid credentials"
            }), 401

        session.clear()

        # ADD THIS
        session.permanent = True

        session["auth_type"] = "staff"
        session["user_id"] = str(
            user["_id"]
        )

        session["role"] = user["role"]

        session["username"] = (
            user["username"]
        )

        return jsonify({
            "ok": True,
            "role": user["role"]
        })

    @app.post("/api/public/request-otp")
    def request_public_otp():

        payload = (
            request.get_json(silent=True)
            or {}
        )
        mobile_number = normalize_phone(
            payload.get("mobileNumber")
        )

        if not mobile_number:
            return jsonify({
                "error": "Mobile number required"
            }), 400

        settings_collection = (
            get_settings_collection()
        )
        existing_settings = (
            settings_collection.find_one({
                "key": OTP_SETTINGS_KEY
            })
        )
        settings = normalize_otp_settings(
            existing=existing_settings,
            test_mode=app.config.get(
                "OTP_TEST_MODE",
                False,
            ),
        )
        active_provider = (
            settings.get("activeProvider")
            or OTP_PROVIDER_TEST
        )
        fixed_code = app.config.get(
            "OTP_FIXED_CODE",
            "",
        )

        if (
            not fixed_code
            and active_provider == OTP_PROVIDER_TEST
        ):
            fixed_code = "123456"

        otp_code = generate_otp_code(
            fixed_code
        )

        try:
            provider_result = send_otp_message(
                settings,
                mobile_number,
                otp_code,
                app.config,
            )
        except Exception as error:
            return jsonify({
                "error": str(error)
            }), 400

        now = now_utc()
        expires_at = now + timedelta(
            minutes=OTP_EXPIRY_MINUTES
        )
        resend_at = now + timedelta(
            seconds=OTP_RESEND_SECONDS
        )
        otp_collection = (
            get_public_otp_collection()
        )

        challenge = {
            "mobileNumber": mobile_number,
            "provider": provider_result["provider"],
            "providerRef": provider_result["providerRef"],
            "otpCode": otp_code,
            "attempts": 0,
            "verifiedAt": None,
            "expiresAt": expires_at,
            "resendAvailableAt": resend_at,
            "createdAt": now,
            "updatedAt": now,
        }

        existing_challenge = (
            otp_collection.find_one({
                "mobileNumber": mobile_number
            })
        )

        if existing_challenge:
            otp_collection.update_one(
                {
                    "mobileNumber": mobile_number
                },
                {
                    "$set": challenge
                }
            )
        else:
            otp_collection.insert_one(
                challenge
            )

        response = {
            "ok": True,
            "mobileNumber": mobile_number,
            "provider": provider_result["provider"],
        }

        if app.config.get(
            "OTP_TEST_MODE"
        ) or provider_result["provider"] == OTP_PROVIDER_TEST:
            response["otpCode"] = otp_code

        return jsonify(response)

    @app.post("/api/public/resend-otp")
    def resend_public_otp():

        payload = (
            request.get_json(silent=True)
            or {}
        )
        mobile_number = normalize_phone(
            payload.get("mobileNumber")
        )
        otp_collection = (
            get_public_otp_collection()
        )
        challenge = otp_collection.find_one({
            "mobileNumber": mobile_number
        })

        if not challenge:
            return jsonify({
                "error": "OTP not requested"
            }), 404

        now = now_utc()
        resend_available_at = as_utc_datetime(
            challenge.get("resendAvailableAt")
        )

        if (
            resend_available_at
            and now < resend_available_at
        ):
            return jsonify({
                "error": "Please wait before resending OTP"
            }), 429

        settings_collection = (
            get_settings_collection()
        )
        existing_settings = (
            settings_collection.find_one({
                "key": OTP_SETTINGS_KEY
            })
        )
        settings = normalize_otp_settings(
            existing=existing_settings,
            test_mode=app.config.get(
                "OTP_TEST_MODE",
                False,
            ),
        )

        try:
            provider_result = send_otp_message(
                settings,
                mobile_number,
                challenge["otpCode"],
                app.config,
            )
        except Exception as error:
            return jsonify({
                "error": str(error)
            }), 400

        otp_collection.update_one(
            {
                "mobileNumber": mobile_number
            },
            {
                "$set": {
                    "provider": provider_result["provider"],
                    "providerRef": provider_result["providerRef"],
                    "updatedAt": now,
                    "resendAvailableAt": now + timedelta(
                        seconds=OTP_RESEND_SECONDS
                    ),
                }
            }
        )

        response = {
            "ok": True
        }

        if app.config.get(
            "OTP_TEST_MODE"
        ) or provider_result["provider"] == OTP_PROVIDER_TEST:
            response["otpCode"] = challenge["otpCode"]

        return jsonify(response)

    @app.post("/api/public/verify-otp")
    def verify_public_otp():

        payload = (
            request.get_json(silent=True)
            or {}
        )
        mobile_number = normalize_phone(
            payload.get("mobileNumber")
        )
        provided_otp = clean_text(
            payload.get("otp")
        )
        otp_collection = (
            get_public_otp_collection()
        )
        challenge = otp_collection.find_one({
            "mobileNumber": mobile_number
        })

        if not challenge:
            return jsonify({
                "error": "OTP not requested"
            }), 404

        now = now_utc()
        expires_at = as_utc_datetime(
            challenge.get("expiresAt")
        )

        if (
            expires_at
            and now > expires_at
        ):
            return jsonify({
                "error": "OTP expired"
            }), 400

        if challenge.get("attempts", 0) >= OTP_MAX_ATTEMPTS:
            return jsonify({
                "error": "Too many OTP attempts"
            }), 429

        if provided_otp != str(
            challenge.get("otpCode", "")
        ):
            otp_collection.update_one(
                {
                    "mobileNumber": mobile_number
                },
                {
                    "$set": {
                        "attempts": challenge.get(
                            "attempts",
                            0,
                        ) + 1,
                        "updatedAt": now,
                    }
                }
            )

            return jsonify({
                "error": "Invalid OTP"
            }), 401

        public_accounts = (
            get_public_accounts_collection()
        )
        account = public_accounts.find_one({
            "mobileNumber": mobile_number
        })

        if not account:
            account = {
                "mobileNumber": mobile_number,
                "status": "pending",
                "approvedRegistrationId": "",
                "latestSubmissionId": "",
                "latestVersion": 0,
                "createdAt": now,
                "updatedAt": now,
                "lastOtpVerifiedAt": now,
            }
            result = public_accounts.insert_one(
                account
            )
            account["_id"] = result.inserted_id
        else:
            public_accounts.update_one(
                {
                    "_id": account["_id"]
                },
                {
                    "$set": {
                        "updatedAt": now,
                        "lastOtpVerifiedAt": now,
                    }
                }
            )
            account["updatedAt"] = now
            account["lastOtpVerifiedAt"] = now

        otp_collection.update_one(
            {
                "mobileNumber": mobile_number
            },
            {
                "$set": {
                    "verifiedAt": now,
                    "updatedAt": now,
                }
            }
        )

        build_public_session(account)

        return jsonify({
            "ok": True,
            "role": current_role(),
            "account": serialize_public_account(
                account
            ),
            "redirectTo": (
                "/directory"
                if account.get("status") == "approved"
                else "/self-register"
            ),
        })

    @app.get("/api/otp-settings")
    def get_otp_settings():

        if not require_role(
            "super_admin"
        ):
            return jsonify({
                "error": "Forbidden"
            }), 403

        settings = normalize_otp_settings(
            existing=get_settings_collection().find_one({
                "key": OTP_SETTINGS_KEY
            }),
            test_mode=app.config.get(
                "OTP_TEST_MODE",
                False,
            ),
        )

        return jsonify(
            serialize_document(settings)
        )

    @app.put("/api/otp-settings")
    def save_otp_settings():

        if not require_role(
            "super_admin"
        ):
            return jsonify({
                "error": "Forbidden"
            }), 403

        payload = (
            request.get_json(silent=True)
            or {}
        )
        settings_collection = (
            get_settings_collection()
        )
        existing = settings_collection.find_one({
            "key": OTP_SETTINGS_KEY
        })
        settings = normalize_otp_settings(
            payload,
            existing=existing,
            test_mode=app.config.get(
                "OTP_TEST_MODE",
                False,
            ),
        )
        settings["updatedAt"] = now_utc()
        settings["updatedBy"] = session.get(
            "username",
            "",
        )

        if existing:
            settings_collection.update_one(
                {
                    "key": OTP_SETTINGS_KEY
                },
                {
                    "$set": settings
                }
            )
        else:
            settings_collection.insert_one(
                settings
            )

        return jsonify({
            "ok": True,
            "settings": serialize_document(
                settings
            )
        })

    @app.get("/api/users")
    def list_users():

        if not require_role(
            "admin",
            "super_admin"
        ):
            return jsonify({
                "error": "Forbidden"
            }), 403

        filters = {}

        if current_role() != "super_admin":
            filters["role"] = {
                "$ne": "super_admin"
            }

        cursor = (
            get_users_collection()
            .find(
                filters,
                {
                    "passwordHash": 0
                }
            )
            .sort("createdAt", -1)
            .limit(100)
        )

        return jsonify({
            "items": [
                serialize_document(user)
                for user in cursor
            ],
            "allowedRoles": get_assignable_roles(
                current_role()
            ),
        })

    @app.post("/api/users")
    def create_user():

        if not require_role(
            "admin",
            "super_admin"
        ):
            return jsonify({
                "error": "Forbidden"
            }), 403

        payload = (
            request.get_json(silent=True)
            or {}
        )

        username = (
            payload.get("username", "")
            .strip()
        )
        password = payload.get(
            "password",
            ""
        )
        role = (
            payload.get("role", "")
            .strip()
        )
        allowed_roles = get_assignable_roles(
            current_role()
        )

        if not username:
            return jsonify({
                "error": "Username required"
            }), 400

        if role not in allowed_roles:
            return jsonify({
                "error": "Forbidden"
            }), 403

        if len(password) < 6:
            return jsonify({
                "error": "Password must be at least 6 characters"
            }), 400

        users_collection = (
            get_users_collection()
        )

        result = users_collection.insert_one(
            document
        )

        document["_id"] = (
            result.inserted_id
        )
        document.pop("passwordHash", None)

        return jsonify({
            "ok": True,
            "user": serialize_document(
                document
            ),
        }), 201

    @app.get("/api/debug-session")
    def debug_session():
        return {
            "session_class": str(type(session)),
            "session_data": dict(session),
            "session_type": app.config.get("SESSION_TYPE"),
            "session_interface": str(type(app.session_interface)),
            "mongodb_collect": app.config.get(
                "SESSION_MONGODB_COLLECT"
            ),
            "mongodb_collection": app.config.get(
                "SESSION_MONGODB_COLLECTION"
            ),
        }
    @app.delete("/api/users/<username>")
    def delete_user(username):

        if not require_role(
            "admin",
            "super_admin"
        ):
            return jsonify({
                "error": "Forbidden"
            }), 403

        target_username = username.strip()

        if not target_username:
            return jsonify({
                "error": "Username required"
            }), 400

        users_collection = (
            get_users_collection()
        )
        user = users_collection.find_one({
            "username": target_username
        })

        if not user:
            return jsonify({
                "error": "User not found"
            }), 404

        allowed_roles = get_deletable_roles(
            current_role()
        )

        if user.get("role") not in allowed_roles:
            return jsonify({
                "error": "Forbidden"
            }), 403

        users_collection.delete_one({
            "username": target_username
        })

        return jsonify({
            "ok": True
        })

    @app.get("/api/self-registrations/me")
    def get_my_self_registration():

        if not is_public_session():
            return jsonify({
                "error": "Forbidden"
            }), 403

        account_id = ensure_object_id(
            session["public_account_id"]
        )
        account = (
            get_public_accounts_collection()
            .find_one({
                "_id": account_id
            })
        )

        if not account:
            return jsonify({
                "error": "Not found"
            }), 404

        submissions = list(
            get_self_registrations_collection()
            .find({
                "accountId": account_id
            })
            .sort("version", -1)
        )

        latest_submission = (
            submissions[0]
            if submissions
            else None
        )

        return jsonify({
            "account": serialize_public_account(
                account
            ),
            "submission": serialize_self_registration(
                latest_submission or {}
            ),
            "history": [
                serialize_self_registration(item)
                for item in submissions
            ],
        })

    @app.post("/api/self-registrations")
    def save_self_registration():

        if not is_public_session():
            return jsonify({
                "error": "Forbidden"
            }), 403

        payload = (
            request.get_json(silent=True)
            or {}
        )
        payload["mobileNumber"] = session.get(
            "public_mobile",
            "",
        )

        correction_store = get_correction_collection()
        corrections = load_corrections(correction_store)
        result = validate_registration(
            payload,
            corrections,
        )

        if not result["valid"]:
            return jsonify({
                "error": "Validation failed.",
                "errors": result["errors"],
            }), 400

        public_accounts = (
            get_public_accounts_collection()
        )
        submissions = (
            get_self_registrations_collection()
        )
        now = now_utc()
        account_id = ensure_object_id(
            session["public_account_id"]
        )
        account = public_accounts.find_one({
            "_id": account_id
        })

        if not account:
            return jsonify({
                "error": "Account not found"
            }), 404

        document = create_pending_submission_for_account(
            public_accounts,
            submissions,
            account,
            result["value"],
            session.get(
                "public_mobile",
                "",
            ),
            now,
            prior_status=account.get(
                "status",
                "pending",
            ),
        )

        learned_corrections = collect_transliteration_corrections(
            payload,
            corrections,
        )
        save_corrections(
            correction_store,
            learned_corrections,
            now,
        )

        build_public_session(account)

        return jsonify({
            "ok": True,
            "submission": serialize_self_registration(
                document
            ),
            "redirectTo": "/self-register",
        }), 201

    @app.get("/api/self-registrations/review")
    def list_self_registrations_for_review():

        if not require_role(
            "admin",
            "super_admin"
        ):
            return jsonify({
                "error": "Forbidden"
            }), 403

        public_accounts = list(
            get_public_accounts_collection()
            .find({})
        )
        submissions = (
            get_self_registrations_collection()
        )
        items = []

        for account in public_accounts:
            latest_submission_id = account.get(
                "latestSubmissionId"
            )
            latest_submission = None

            if latest_submission_id:
                latest_submission = submissions.find_one({
                    "_id": latest_submission_id
                })

            history = list(
                submissions.find({
                    "accountId": account["_id"]
                }).sort("version", -1)
            )

            items.append({
                "account": serialize_public_account(
                    account
                ),
                "latestSubmission": serialize_self_registration(
                    latest_submission or {}
                ),
                "history": [
                    serialize_self_registration(item)
                    for item in history
                ],
            })

        return jsonify({
            "items": items
        })

    @app.post("/api/self-registrations/<account_id>/approve")
    def approve_self_registration(account_id):

        if not require_role(
            "admin",
            "super_admin"
        ):
            return jsonify({
                "error": "Forbidden"
            }), 403

        payload = (
            request.get_json(silent=True)
            or {}
        )
        note = clean_text(
            payload.get("note")
        )
        public_accounts = (
            get_public_accounts_collection()
        )
        submissions = (
            get_self_registrations_collection()
        )
        account_object_id = ensure_object_id(
            account_id
        )
        account = public_accounts.find_one({
            "_id": account_object_id
        })

        if not account:
            return jsonify({
                "error": "Not found"
            }), 404

        latest_submission_id = account.get(
            "latestSubmissionId"
        )

        if not latest_submission_id:
            return jsonify({
                "error": "Submission not found"
            }), 404

        submission = submissions.find_one({
            "_id": latest_submission_id
        })

        if not submission:
            return jsonify({
                "error": "Submission not found"
            }), 404

        now = now_utc()
        registration_collection = (
            get_collection()
        )
        approved_registration_id = account.get(
            "approvedRegistrationId"
        )
        registration_document = {
            key: value
            for key, value in submission.items()
            if key not in {
                "_id",
                "accountId",
                "version",
                "submissionStatus",
                "auditTrail",
                "reviewedAt",
                "reviewedBy",
                "reviewNote",
                "approvedRegistrationId",
            }
        }
        registration_document["updatedAt"] = now
        registration_document["updatedBy"] = session.get(
            "username",
            ""
        )

        if approved_registration_id:
            registration_collection.update_one(
                {
                    "_id": ensure_object_id(
                        approved_registration_id
                    )
                },
                {
                    "$set": registration_document
                }
            )
            registration_id = approved_registration_id
        else:
            registration_document["createdAt"] = now
            registration_document["createdBy"] = session.get(
                "username",
                ""
            )
            registration_document["updatedBy"] = session.get(
                "username",
                ""
            )

            insert_result = registration_collection.insert_one(
                registration_document
            )
            registration_id = insert_result.inserted_id

        append_audit_event(
            submission,
            "approved",
            session.get("username", "staff"),
            note=note,
            timestamp=now,
        )
        submission["submissionStatus"] = "approved"
        submission["reviewedAt"] = now
        submission["reviewedBy"] = session.get(
            "username",
            "",
        )
        submission["reviewNote"] = note
        submission["approvedRegistrationId"] = registration_id
        submissions.update_one(
            {
                "_id": submission["_id"]
            },
            {
                "$set": {
                    "submissionStatus": "approved",
                    "reviewedAt": now,
                    "reviewedBy": session.get(
                        "username",
                        "",
                    ),
                    "reviewNote": note,
                    "approvedRegistrationId": registration_id,
                    "auditTrail": submission["auditTrail"],
                    "updatedAt": now,
                }
            }
        )

        public_accounts.update_one(
            {
                "_id": account_object_id
            },
            {
                "$set": {
                    "status": "approved",
                    "approvedRegistrationId": registration_id,
                    "updatedAt": now,
                }
            }
        )

        return jsonify({
            "ok": True,
            "registrationId": str(
                registration_id
            ),
        })

    @app.post("/api/self-registrations/<account_id>/reject")
    def reject_self_registration(account_id):

        if not require_role(
            "admin",
            "super_admin"
        ):
            return jsonify({
                "error": "Forbidden"
            }), 403

        payload = (
            request.get_json(silent=True)
            or {}
        )
        note = clean_text(
            payload.get("note")
        )
        account_object_id = ensure_object_id(
            account_id
        )
        public_accounts = (
            get_public_accounts_collection()
        )
        submissions = (
            get_self_registrations_collection()
        )
        account = public_accounts.find_one({
            "_id": account_object_id
        })

        if not account or not account.get(
            "latestSubmissionId"
        ):
            return jsonify({
                "error": "Submission not found"
            }), 404

        submission = submissions.find_one({
            "_id": account["latestSubmissionId"]
        })

        if not submission:
            return jsonify({
                "error": "Submission not found"
            }), 404

        now = now_utc()
        append_audit_event(
            submission,
            "rejected",
            session.get("username", "staff"),
            note=note,
            timestamp=now,
        )
        submissions.update_one(
            {
                "_id": submission["_id"]
            },
            {
                "$set": {
                    "submissionStatus": "rejected",
                    "reviewedAt": now,
                    "reviewedBy": session.get(
                        "username",
                        "",
                    ),
                    "reviewNote": note,
                    "auditTrail": submission["auditTrail"],
                    "updatedAt": now,
                }
            }
        )
        public_accounts.update_one(
            {
                "_id": account_object_id
            },
            {
                "$set": {
                    "status": "rejected",
                    "updatedAt": now,
                }
            }
        )

        return jsonify({
            "ok": True
        })


    @app.get("/api/registrations/<id>")
    def get_registration(id):
        document_id = object_id_or_none(id)

        if not document_id:
            return jsonify({
                "error": "Not found"
            }), 404

        if not can_access_directory():
            return jsonify({
                "error": "Forbidden"
            }), 403

        document = (
            get_collection()
            .find_one({
                "_id": document_id
            })
        )

        if not document:
            return jsonify({
                "error": "Not found"
            }), 404

        if not can_view_registration(document):
            return jsonify({
                "error": "Forbidden"
            }), 403

        return jsonify(
            serialize_registration_document(
                document
            )
        )

    @app.get("/api/family-tree/<id>")
    def get_family_tree(id):
        document_id = object_id_or_none(id)

        if not document_id:
            return jsonify({
                "error": "Not found"
            }), 404

        if not can_access_directory():
            return jsonify({
                "error": "Forbidden"
            }), 403

        document = (
            get_collection()
            .find_one({
                "_id": document_id
            })
        )

        if not document:
            return jsonify({
                "error": "Not found"
            }), 404

        if not can_view_family_tree(document):
            return jsonify({
                "error": "Forbidden"
            }), 403

        serialized = (
            serialize_registration_document(
                document
            )
        )

        return jsonify({
            "member": {
                "id": str(serialized.get("_id", "")),
                "fullName": build_registration_full_name(
                    serialized
                ),
                "familyCount": (
                    len(serialized.get("familyMembers") or [])
                    + 1
                ),
                "createdBy": serialized.get("createdBy", ""),
            },
            "graph": build_family_tree_graph_data(
                serialized
            ),
        })

    @app.put("/api/registrations/<id>")
    def update_registration(id):
        document_id = object_id_or_none(id)

        if not document_id:
            return jsonify({
                "error": "Not found"
            }), 404

        existing_document = (
            get_collection()
            .find_one({
                "_id": document_id
            })
        )

        if not existing_document:
            return jsonify({
                "error": "Not found"
            }), 404

        if not can_edit_registration(
            existing_document
        ):
            return jsonify({
                "error": "Forbidden"
            }), 403
        payload = (
            request.get_json(
                silent=True
            ) or {}
        )

        correction_store = get_correction_collection()

        corrections = load_corrections(correction_store)

        result = validate_registration(
                payload,
                corrections,
            )

        if not result["valid"]:
            return jsonify({
                "error": "Validation failed",
                "errors": result["errors"]
            }), 400

        if (
            is_public_session()
            and current_role() == "viewer"
        ):
            public_accounts = (
                get_public_accounts_collection()
            )
            submissions = (
                get_self_registrations_collection()
            )
            account = public_accounts.find_one({
                "_id": ensure_object_id(
                    session["public_account_id"]
                )
            })

            if not account:
                return jsonify({
                    "error": "Account not found"
                }), 404

            now = now_utc()
            document = create_pending_submission_for_account(
                public_accounts,
                submissions,
                account,
                result["value"],
                session.get(
                    "public_mobile",
                    "",
                ),
                now,
                prior_status=account.get(
                    "status",
                    "approved",
                ),
            )
            build_public_session(account)

            return jsonify({
                "ok": True,
                "submission": serialize_self_registration(
                    document
                ),
                "redirectTo": "/self-register",
                "message": "Changes submitted for review.",
            }), 202

        document = {
            **result["value"],
            "createdAt": existing_document.get(
                "createdAt"
            ),
            "createdBy": existing_document.get(
                "createdBy",
                ""
            ),
            "updatedAt": datetime.now(
                timezone.utc
            ),
            "updatedBy": session.get(
                "username",
                ""
            )
        }

        get_collection().update_one(
            {
                "_id": document_id
            },
            {
                "$set": document
            }
        )

        return jsonify({
            "ok": True
        })

    @app.delete("/api/registrations/<id>")
    def delete_registration(id):

        if not require_role(
            "admin",
            "super_admin",
        ):
            return jsonify({
                "error": "Forbidden"
            }), 403

        document_id = object_id_or_none(id)

        if not document_id:
            app.logger.info("delete_registration: invalid ObjectId %s", id)
            return jsonify({"error": "Invalid id"}), 400

        result = get_collection().delete_one({"_id": document_id})

        if result.deleted_count:
            app.logger.info("delete_registration: deleted by ObjectId %s", id)
            return jsonify({"ok": True})

        try:
            result2 = get_collection().delete_one({"_id": str(id)})
            if result2.deleted_count:
                app.logger.info("delete_registration: deleted by string _id %s", id)
                return jsonify({"ok": True})
        except Exception:
            app.logger.exception("delete_registration: fallback delete by string failed for %s", id)

        app.logger.info("delete_registration: not found %s", id)
        return jsonify({"error": "Not found"}), 404

    @app.delete("/api/members/<id>")
    def delete_member(id):

        if not require_role(
            "admin",
            "super_admin",
        ):
            return jsonify({
                "error": "Forbidden"
            }), 403

        document_id = object_id_or_none(id)

        if not document_id:
            app.logger.info("delete_member: invalid ObjectId %s", id)
            return jsonify({"error": "Invalid id"}), 400

        result = get_collection().delete_one({"_id": document_id})

        if result.deleted_count:
            app.logger.info("delete_member: deleted by ObjectId %s", id)
            return jsonify({"ok": True})

        try:
            result2 = get_collection().delete_one({"_id": str(id)})
            if result2.deleted_count:
                app.logger.info("delete_member: deleted by string _id %s", id)
                return jsonify({"ok": True})
        except Exception:
            app.logger.exception("delete_member: fallback delete by string failed for %s", id)

        app.logger.info("delete_member: not found %s", id)
        return jsonify({"error": "Not found"}), 404

    @app.post("/api/registrations")

    def create_registration():
        if not require_role(
            "operator",
            "admin",
            "super_admin"
        ):
            return jsonify({
                "error": "Forbidden"
            }), 403

        payload = request.get_json(silent=True) or {}

        correction_store = get_correction_collection()
        corrections = load_corrections(correction_store)
        result = validate_registration(payload, corrections)

        if not result["valid"]:
            return (
                jsonify(
                    {
                        "error": "Validation failed.",
                        "errors": result["errors"],
                    }
                ),
                400,
            )

        now = datetime.now(timezone.utc)

        document = {
            **result["value"],
            "createdAt": now,
            "createdBy": session.get(
                "username",
                "",
            ),
            "updatedAt": now,
            "updatedBy": session.get(
                "username",
                "",
            ),
        }

        insert_result = get_collection().insert_one(document)
        document["_id"] = insert_result.inserted_id

        learned_corrections = collect_transliteration_corrections(
            payload,
            corrections,
        )

        save_corrections(
            correction_store,
            learned_corrections,
            now,
        )

        return (
            jsonify(
                {
                    "id": str(insert_result.inserted_id),
                    "registration": serialize_registration_document(document),
                    "learnedCorrections": learned_corrections,
                }
            ),
            201,
        )

    @app.get("/api/registrations")
    def list_registrations():
        if not require_role(
            "operator",
            "admin",
            "super_admin"
        ):
            return jsonify({
                "error": "Forbidden"
            }), 403

        limit = clamp(
            request.args.get("limit", default=10, type=int),
            1,
            10,
        )

        cursor = (
            get_collection()
            .find({})
            .sort("createdAt", -1)
            .limit(limit)
        )

        return jsonify(
            {
                "items": [
                    serialize_registration_document(document)
                    for document in cursor
                ]
            }
        )

    @app.get("/api/member-search")
    def member_search():
        if not can_access_directory():
            return jsonify({
                "error": "Forbidden"
            }), 403

        query = (
            request.args.get("q", "")
            .strip()
        )

        state = request.args.get(
            "state",
            "",
        ).strip()

        district = request.args.get(
            "district",
            "",
        ).strip()

        taluka = request.args.get(
            "taluka",
            "",
        ).strip()

        surname = request.args.get(
            "surname",
            "",
        ).strip()

        mongo_query = {}

        if query:
            query_tokens = [
                token.strip()
                for token in re.split(r"\s+", query)
                if token.strip()
            ]

            if query_tokens:
                default_search_fields = [
                    "firstName.en",
                    "lastName.en",
                    "firstName.mr",
                    "lastName.mr",
                    "familyMembers.name.en",
                    "familyMembers.name.mr",
                    "familyMembers.spouseName.en",
                    "familyMembers.spouseName.mr",
                    "mobileNumber",
                ]

                mongo_query["$and"] = []

                for token in query_tokens:
                    if token.startswith("#"):
                        username = token[1:]
                        if username:
                            mongo_query["$and"].append({
                                "createdBy": {
                                    "$regex": f"^{re.escape(username)}$",
                                    "$options": "i",
                                }
                            })
                    else:
                        mongo_query["$and"].append({
                            "$or": [
                                {
                                    field: {
                                        "$regex": token,
                                        "$options": "i",
                                    }
                                }
                                for field in default_search_fields
                            ]
                        })

        if state:
            mongo_query["state"] = state

        if district:
            mongo_query["district"] = district

        if taluka:
            mongo_query["taluka"] = taluka

        if surname:
            mongo_query["surnameGroup"] = (
                surname.lower()
            )

        # Pagination support: page (1-based) and per_page
        try:
            page = int(request.args.get("page", "1") or "1")
        except Exception:
            page = 1

        try:
            per_page = int(request.args.get("per_page", "15") or "15")
        except Exception:
            per_page = 15

        if per_page < 1:
            per_page = 1

        # Cap per_page to avoid very large responses
        if per_page > 200:
            per_page = 200

        total_count = get_collection().count_documents(mongo_query)

        skip = (page - 1) * per_page

        cursor = (
            get_collection()
            .find(mongo_query)
            .sort("createdAt", -1)
            .skip(skip)
            .limit(per_page)
        )

        items = [
            serialize_registration_document(doc)
            for doc in cursor
        ]

        return jsonify({
            "items": items,
            "total_count": total_count,
            "page": page,
            "per_page": per_page,
        })


        @app.delete("/api/members/<id>")
        def delete_member(id):

            if not require_role(
                "admin",
                "super_admin",
            ):
                return jsonify({
                    "error": "Forbidden"
                }), 403

            document_id = object_id_or_none(id)

            if not document_id:
                app.logger.info("delete_member: invalid ObjectId %s", id)
                return jsonify({
                    "error": "Invalid id"
                }), 400

            # Try deleting by ObjectId first
            result = get_collection().delete_one({
                "_id": document_id
            })

            if result.deleted_count:
                app.logger.info("delete_member: deleted by ObjectId %s", id)
                return jsonify({"ok": True})

            # Fallback: some records may have string _id values; try deleting by string
            try:
                result2 = get_collection().delete_one({"_id": str(id)})
                if result2.deleted_count:
                    app.logger.info("delete_member: deleted by string _id %s", id)
                    return jsonify({"ok": True})
            except Exception:
                app.logger.exception("delete_member: fallback delete by string failed for %s", id)

            app.logger.info("delete_member: not found %s", id)
            return jsonify({
                "error": "Not found"
            }), 404

    @app.get("/api/transliteration-corrections")
    def list_transliteration_corrections():
        return jsonify(
            {
                "corrections": load_corrections(
                    get_correction_collection()
                )
            }
        )

    @app.get("/api/transliteration-suggestions")
    def list_transliteration_suggestions():
        query = request.args.get(
            "q",
            ""
        ).strip()

        if not query:
            return jsonify({
                "suggestions": []
            })

        corrections = load_corrections(
            get_correction_collection()
        )

        suggestions = []

        corrected_phrase = build_corrected_phrase(
            query,
            corrections
        )

        if corrected_phrase:
            suggestions.append(
                corrected_phrase
            )

        google_suggestions = (
            transliteration_suggestions(
                query
            )
        )

        for item in google_suggestions:
            if item not in suggestions:
                suggestions.append(item)

        return jsonify({
            "suggestions": suggestions[:8]
        })

    def close_mongo():
        client = app.extensions.get("mongo_client")

        if client is not None:
            client.close()
            app.extensions["mongo_client"] = None
            app.extensions["mongo_collection"] = collection
            app.extensions["mongo_correction_collection"] = correction_collection

    def get_collection():
        existing = app.extensions.get("mongo_collection")

        if existing is not None:
            return existing

        _ensure_mongo_collections()
        return app.extensions["mongo_collection"]

    def get_correction_collection():
        existing = app.extensions.get("mongo_correction_collection")

        if existing is not None:
            return existing

        _ensure_mongo_collections()
        return app.extensions["mongo_correction_collection"]

    def get_users_collection():
        database = (
            get_collection()
            .database
        )

        return database["users"]

    def get_public_accounts_collection():
        database = (
            get_collection()
            .database
        )

        return database["public_accounts"]

    def get_public_otp_collection():
        database = (
            get_collection()
            .database
        )

        return database["public_otp"]

    def get_self_registrations_collection():
        database = (
            get_collection()
            .database
        )

        return database["self_registrations"]

    def get_settings_collection():
        database = (
            get_collection()
            .database
        )

        return database["app_settings"]

    def _ensure_mongo_collections():
        (
            client,
            mongo_collection,
            mongo_correction_collection,
        ) = create_collections(app.config)

        app.extensions["mongo_client"] = client

        if app.extensions.get("mongo_collection") is None:
            app.extensions["mongo_collection"] = mongo_collection

        if app.extensions.get("mongo_correction_collection") is None:
            app.extensions["mongo_correction_collection"] = mongo_correction_collection

    app.get_collection = get_collection
    app.get_correction_collection = get_correction_collection
    app.get_users_collection = get_users_collection
    app.get_public_accounts_collection = get_public_accounts_collection
    app.get_public_otp_collection = get_public_otp_collection
    app.get_self_registrations_collection = get_self_registrations_collection
    app.get_settings_collection = get_settings_collection
    app.close_mongo = close_mongo

    return app


def serialize_document(value):
    if isinstance(value, ObjectId):
        return str(value)

    if isinstance(value, datetime):
        return value.isoformat()

    if isinstance(value, list):
        return [serialize_document(item) for item in value]

    if isinstance(value, dict):
        return {
            key: serialize_document(item)
            for key, item in value.items()
        }

    return value


def serialize_registration_document(document):
    serialized = serialize_document(document)

    serialized["familyId"] = (
        serialized.get("familyId")
        or ""
    )
    serialized["familyType"] = (
        serialized.get("familyType")
        or "nuclear"
    )
    serialized["primaryHouseholdId"] = (
        serialized.get("primaryHouseholdId")
        or "household-primary"
    )

    family_members = serialized.get(
        "familyMembers"
    )

    if not isinstance(family_members, list):
        return serialized

    for member in family_members:
        if not isinstance(member, dict):
            continue

        relation = (
            member.get("relationToApplicant")
            or member.get("relation")
            or ""
        )
        person_id = (
            member.get("personId")
            or member.get("memberId")
            or ""
        )

        member["personId"] = person_id
        member["memberId"] = person_id
        member["householdId"] = (
            member.get("householdId")
            or serialized["primaryHouseholdId"]
        )
        member["relationToApplicant"] = relation
        member["relation"] = relation
        member["spouseMemberId"] = (
            member.get("spouseMemberId")
            or ""
        )
        member["relationshipLinks"] = normalize_relationship_links(
            member.get("relationshipLinks"),
            member,
        )

    return serialized


def clamp(value, minimum, maximum):
    return min(max(value, minimum), maximum)


def require_auth():
    return is_staff_session() or is_public_session()

def require_role(*roles):
    return (
        current_role()
        in roles
    )

def current_role():
    if is_public_session():
        if session.get("public_status") == "approved":
            return "viewer"

        return "pending_public"

    return session.get("role")


def is_staff_session():
    return (
        "user_id" in session
        and session.get("auth_type") != "public"
    )


def is_public_session():
    return (
        session.get("auth_type") == "public"
        and "public_account_id" in session
    )


def is_pending_public_session():
    return (
        is_public_session()
        and session.get("public_status") != "approved"
    )


def can_access_directory():
    if not require_auth():
        return False

    if is_pending_public_session():
        return False

    return True


def current_owned_registration_id():
    if not is_public_session():
        return ""

    public_account_id = session.get(
        "public_account_id",
        "",
    )

    if not public_account_id:
        return ""

    account = (
        current_app_registration_database_lookup(
            "public_accounts",
            public_account_id,
        )
    )

    if not account:
        return ""

    approved_registration_id = account.get(
        "approvedRegistrationId",
        "",
    )

    return str(approved_registration_id or "")


def current_app_registration_database_lookup(collection_name, object_id):
    from flask import current_app

    collection_getters = {
        "public_accounts": current_app.get_public_accounts_collection,
    }

    getter = collection_getters.get(collection_name)

    if getter is None:
        return None

    try:
        return getter().find_one({
            "_id": ensure_object_id(object_id)
        })
    except Exception:
        return None


def can_view_registration(document):
    if not document:
        return False

    role = current_role()

    if role in {"admin", "super_admin"}:
        return True

    if role == "operator":
        return document.get("createdBy") == session.get(
            "username",
            "",
        )

    if role == "viewer":
        if is_public_session():
            return str(document.get("_id")) == current_owned_registration_id()

        return document.get("createdBy") == session.get(
            "username",
            "",
        )

    return False


def can_view_family_tree(document):
    if not document:
        return False

    role = current_role()

    if role in {
        "admin",
        "super_admin",
        "operator",
    }:
        return True

    return False


def can_edit_registration(document):
    if not document:
        return False

    role = current_role()

    if role in {"admin", "super_admin"}:
        return True

    if role == "operator":
        return document.get("createdBy") == session.get(
            "username",
            "",
        )

    if role == "viewer":
        if is_public_session():
            return str(document.get("_id")) == current_owned_registration_id()

        return document.get("createdBy") == session.get(
            "username",
            "",
        )

    return False


def build_bilingual_name(value):
    if isinstance(value, dict):
        return clean_text(
            value.get("en")
            or value.get("mr")
            or ""
        )

    return clean_text(value)


def build_registration_full_name(document):
    return " ".join(
        part
        for part in [
            clean_text(
                (document.get("firstName") or {}).get("en")
            ),
            clean_text(
                (document.get("middleName") or {}).get("en")
            ),
            clean_text(
                (document.get("lastName") or {}).get("en")
            ),
        ]
        if part
    ) or "Unnamed applicant"


def canonical_tree_person_id(value):
    person_id = clean_text(value)

    if person_id in {
        "",
        "applicant",
        "applicant-primary",
    }:
        return "applicant"

    return person_id


def infer_generation_offset_from_relation(relation):
    normalized = clean_text(relation).lower()
    normalized = normalized.split("(", 1)[0].strip()

    if normalized in {
        "father",
        "mother",
        "uncle",
        "aunt",
        "wife",
        "husband",
        "father-in-law",
        "mother-in-law",
    }:
        if normalized in {"wife", "husband"}:
            return 0
        return -1

    if normalized in {
        "grandfather",
        "grandmother",
        "great grandfather",
        "great grandmother",
    }:
        return -2

    if normalized in {
        "brother",
        "sister",
        "cousin",
        "self",
    }:
        return 0

    if normalized in {
        "son",
        "daughter",
        "nephew",
        "niece",
    }:
        return 1

    if normalized in {
        "grandson",
        "granddaughter",
        "grand-son",
        "grand-daughter",
    }:
        return 2

    if normalized in {
        "husband",
        "wife",
        "spouse",
    }:
        return 0

    return None


def normalize_relation_label(relation):
    return clean_text(relation).lower().split("(", 1)[0].strip()


def is_spouse_or_inlaw_relation(relation):
    return normalize_relation_label(relation) in {
        "wife",
        "husband",
        "spouse",
        "daughter-in-law",
        "son-in-law",
    }


def relation_name_tokens(full_name):
    return [
        token.lower()
        for token in clean_text(full_name).split()
        if token
    ]


def add_family_tree_edge(
    edges,
    seen_edges,
    source,
    target,
    relation_type,
):
    source_id = canonical_tree_person_id(source)
    target_id = canonical_tree_person_id(target)

    if (
        not source_id
        or not target_id
        or source_id == target_id
    ):
        return

    edge_key = (
        source_id,
        target_id,
        relation_type,
    )

    if edge_key in seen_edges:
        return

    seen_edges.add(edge_key)
    edges.append({
        "id": f"{relation_type}:{source_id}:{target_id}",
        "source": source_id,
        "target": target_id,
        "type": (
            "smoothstep"
            if relation_type == "spouse_of"
            else "straight"
        ),
        "animated": relation_type == "spouse_of",
        "data": {
            "relationType": relation_type
        },
    })


def build_family_tree_graph_data(document):
    serialized = (
        serialize_registration_document(document)
        if document.get("familyMembers") is not None
        else document
    )
    family_members = serialized.get("familyMembers") or []

    nodes = {
        "applicant": {
            "id": "applicant",
            "data": {
                "fullName": build_registration_full_name(
                    serialized
                ),
                "generationOffset": 0,
                "isApplicant": True,
                "isSpouseOnly": False,
            },
        }
    }
    generation_offsets = {
        "applicant": 0
    }
    relation_edges = []
    seen_edges = set()
    member_index = 0
    member_order = {
        "applicant": 0
    }
    members_with_links = set()
    normalized_name_to_ids = {}

    for member in family_members:
        if not isinstance(member, dict):
            continue

        member_index += 1
        person_id = canonical_tree_person_id(
            member.get("personId")
            or member.get("memberId")
            or f"member-{member_index}"
        )
        full_name = build_bilingual_name(
            member.get("name")
        ) or f"Family member {member_index}"

        nodes[person_id] = {
            "id": person_id,
            "data": {
                "fullName": full_name,
                "generationOffset": 0,
                "isApplicant": False,
                "isSpouseOnly": False,
                "relationToApplicant": clean_text(
                    member.get("relationToApplicant")
                    or member.get("relation")
                    or ""
                ),
                "isMarried": bool(
                    member.get("isMarried")
                ),
                "currentCity": clean_text(
                    member.get("currentCity")
                    or ""
                ),
                "spouseName": build_bilingual_name(
                    member.get("spouseName")
                ),
                "householdId": clean_text(
                    member.get("householdId") or ""
                ),
            },
        }
        # Only treat a member as having explicit relationship links when
        # those links contain authoritative relation types we rely on for
        # graph construction. Ignore generic 'other' links for this
        # purpose so we can still use `relationToApplicant` heuristics.
        links_for_member = normalize_relationship_links(
            member.get("relationshipLinks"),
            member,
        )

        authoritative_link_types = {
            "child_of",
            "parent_of",
            "spouse_of",
            "sibling_of",
            "belongs_to_household",
            "guardian_of",
        }

        if any((link.get("type") in authoritative_link_types) for link in links_for_member):
            members_with_links.add(person_id)
        member_order[person_id] = member_index

        # Only infer generation offset from the free-text "relationToApplicant"
        # when explicit `relationshipLinks` are not provided for this member.
        if person_id not in members_with_links:
            inferred_offset = (
                infer_generation_offset_from_relation(
                    member.get("relationToApplicant")
                    or member.get("relation")
                    or ""
                )
            )

            if inferred_offset is not None:
                generation_offsets[person_id] = inferred_offset

    for node_id, node in nodes.items():
        normalized_name = clean_text(
            node["data"].get("fullName")
        ).lower()

        if not normalized_name:
            continue

        normalized_name_to_ids.setdefault(
            normalized_name,
            []
        ).append(node_id)

    explicit_constraints = []
    spouse_pairs = set()
    constrained_nodes = set()
    direct_relation_constraints = []

    for member in family_members:
        if not isinstance(member, dict):
            continue

        source_id = canonical_tree_person_id(
            member.get("personId")
            or member.get("memberId")
        )

        if source_id not in nodes:
            continue

        for link in normalize_relationship_links(
            member.get("relationshipLinks"),
            member,
        ):
            relation_type = clean_text(
                link.get("type")
            ).lower()
            target_id = canonical_tree_person_id(
                link.get("targetPersonId")
            )

            if target_id != "applicant" and target_id not in nodes:
                continue

            explicit_constraints.append({
                "type": relation_type,
                "source": source_id,
                "target": target_id,
            })
            if relation_type == "spouse_of":
                spouse_pairs.add(
                    tuple(
                        sorted(
                            [source_id, target_id]
                        )
                    )
                )
            constrained_nodes.add(source_id)
            constrained_nodes.add(target_id)

        spouse_name = build_bilingual_name(
            member.get("spouseName")
        )
        spouse_member_id = canonical_tree_person_id(
            member.get("spouseMemberId")
        )
        inferred_existing_spouse_id = ""
        source_relation = normalize_relation_label(
            member.get("relationToApplicant")
            or member.get("relation")
            or ""
        )
        source_full_name = build_bilingual_name(
            member.get("name")
        )

        if spouse_name and not spouse_member_id:
            candidate_ids = (
                normalized_name_to_ids.get(
                    clean_text(
                        spouse_name
                    ).lower(),
                    [],
                )
            )

            inferred_existing_spouse_id = next(
                (
                    candidate_id
                    for candidate_id in candidate_ids
                    if candidate_id != source_id
                ),
                "",
            )

        if not inferred_existing_spouse_id and source_id not in members_with_links:
            if source_relation == "son":
                inlaw_candidates = [
                    candidate_id
                    for candidate_id, candidate_node in nodes.items()
                    if candidate_id != source_id
                    and normalize_relation_label(
                        candidate_node["data"].get(
                            "relationToApplicant",
                            ""
                        )
                    ) == "daughter-in-law"
                ]
                source_tokens = set(
                    relation_name_tokens(
                        source_full_name
                    )
                )
                matched_candidates = [
                    candidate_id
                    for candidate_id in inlaw_candidates
                    if source_tokens.intersection(
                        relation_name_tokens(
                            nodes[candidate_id]["data"].get(
                                "fullName",
                                ""
                            )
                        )
                    )
                ]

                if len(matched_candidates) == 1:
                    inferred_existing_spouse_id = (
                        matched_candidates[0]
                    )

            if source_relation == "daughter":
                inlaw_candidates = [
                    candidate_id
                    for candidate_id, candidate_node in nodes.items()
                    if candidate_id != source_id
                    and normalize_relation_label(
                        candidate_node["data"].get(
                            "relationToApplicant",
                            ""
                        )
                    ) == "son-in-law"
                ]
                source_tokens = set(
                    relation_name_tokens(
                        source_full_name
                    )
                )
                matched_candidates = [
                    candidate_id
                    for candidate_id in inlaw_candidates
                    if source_tokens.intersection(
                        relation_name_tokens(
                            nodes[candidate_id]["data"].get(
                                "fullName",
                                ""
                            )
                        )
                    )
                ]

                if len(matched_candidates) == 1:
                    inferred_existing_spouse_id = (
                        matched_candidates[0]
                    )

        if (
            inferred_existing_spouse_id
            and inferred_existing_spouse_id != "applicant"
        ):
            explicit_constraints.append({
                "type": "spouse_of",
                "source": source_id,
                "target": inferred_existing_spouse_id,
            })
            spouse_pairs.add(
                tuple(
                    sorted(
                        [
                            source_id,
                            inferred_existing_spouse_id,
                        ]
                    )
                )
            )
            constrained_nodes.add(source_id)
            constrained_nodes.add(
                inferred_existing_spouse_id
            )
        elif (
            spouse_member_id
            and spouse_member_id != "applicant"
            and spouse_member_id in nodes
        ):
            explicit_constraints.append({
                "type": "spouse_of",
                "source": source_id,
                "target": spouse_member_id,
            })
            spouse_pairs.add(
                tuple(
                    sorted(
                        [source_id, spouse_member_id]
                    )
                )
            )
            constrained_nodes.add(source_id)
            constrained_nodes.add(spouse_member_id)
        elif spouse_name:
            spouse_node_id = f"{source_id}__spouse"
            nodes[spouse_node_id] = {
                "id": spouse_node_id,
                "data": {
                    "fullName": spouse_name,
                    "generationOffset": generation_offsets.get(
                        source_id,
                        0,
                    ),
                    "isApplicant": False,
                    "isSpouseOnly": True,
                    "relationToApplicant": "",
                    "isMarried": True,
                    "currentCity": clean_text(
                        member.get("currentCity")
                        or ""
                    ),
                        "spouseName": "",
                        "householdId": nodes.get(source_id, {}).get("data", {}).get("householdId", ""),
                },
            }
            generation_offsets[spouse_node_id] = generation_offsets.get(
                source_id,
                0,
            )
            member_order[spouse_node_id] = (
                member_order.get(source_id, member_index)
                + 0.1
            )
            explicit_constraints.append({
                "type": "spouse_of",
                "source": source_id,
                "target": spouse_node_id,
            })
            spouse_pairs.add(
                tuple(
                    sorted(
                        [source_id, spouse_node_id]
                    )
                )
            )
            constrained_nodes.add(source_id)
            constrained_nodes.add(spouse_node_id)

    nodes_with_direct_constraints = set()
    source_nodes_with_direct_constraints = set()

    for constraint in explicit_constraints:
        if constraint["type"] in {
            "child_of",
            "parent_of",
        }:
            nodes_with_direct_constraints.add(
                constraint["source"]
            )
            nodes_with_direct_constraints.add(
                constraint["target"]
            )
            source_nodes_with_direct_constraints.add(
                constraint["source"]
            )

    inferred_parent_ids = []

    for node_id, node in nodes.items():
        if node_id == "applicant":
            continue

        relation = normalize_relation_label(
            node["data"].get(
                "relationToApplicant",
                ""
            )
        )

        if (
            relation in {"mother", "father"}
            and node_id not in source_nodes_with_direct_constraints
            and node_id not in members_with_links
        ):
            direct_relation_constraints.append({
                "type": "parent_of",
                "source": node_id,
                "target": "applicant",
            })
            constrained_nodes.add(node_id)
            constrained_nodes.add("applicant")
            inferred_parent_ids.append(node_id)

    sibling_parent_id = (
        inferred_parent_ids[0]
        if inferred_parent_ids
        else None
    )

    if sibling_parent_id:
        for node_id, node in nodes.items():
            if node_id == "applicant":
                continue

            relation = normalize_relation_label(
                node["data"].get(
                    "relationToApplicant",
                    ""
                )
            )

            if (
                relation in {"brother", "sister"}
                and node_id not in source_nodes_with_direct_constraints
                and node_id not in members_with_links
            ):
                direct_relation_constraints.append({
                    "type": "child_of",
                    "source": node_id,
                    "target": sibling_parent_id,
                })
                constrained_nodes.add(node_id)
                constrained_nodes.add(sibling_parent_id)

    for node_id, node in nodes.items():
        if node_id == "applicant":
            continue

        if node_id in source_nodes_with_direct_constraints or node_id in members_with_links:
            continue

        relation = normalize_relation_label(
            node["data"].get(
                "relationToApplicant",
                ""
            )
        )

        if relation in {
            "wife",
            "husband",
            "spouse",
        }:
            direct_relation_constraints.append({
                "type": "spouse_of",
                "source": node_id,
                "target": "applicant",
            })
            spouse_pairs.add(
                tuple(
                    sorted(
                        [node_id, "applicant"]
                    )
                )
            )
            constrained_nodes.add(node_id)
            constrained_nodes.add("applicant")
            continue

        if relation in {
            "son",
            "daughter",
        }:
            direct_relation_constraints.append({
                "type": "child_of",
                "source": node_id,
                "target": "applicant",
            })
            constrained_nodes.add(node_id)
            constrained_nodes.add("applicant")
            continue

        if relation in {
            "grandson",
            "granddaughter",
        }:
            candidate_parent = next(
                (
                    candidate_id
                    for candidate_id, candidate_node in nodes.items()
                    if candidate_id != node_id
                    and normalize_relation_label(
                        candidate_node["data"].get(
                            "relationToApplicant",
                            ""
                        )
                    ) in {"son", "daughter"}
                ),
                None,
            )

            if candidate_parent:
                direct_relation_constraints.append({
                    "type": "child_of",
                    "source": node_id,
                    "target": candidate_parent,
                })
                constrained_nodes.add(node_id)
                constrained_nodes.add(candidate_parent)

    explicit_constraints.extend(
        direct_relation_constraints
    )

    for _ in range(len(nodes) + 2):
        changed = False

        for constraint in explicit_constraints:
            relation_type = constraint["type"]
            source_id = constraint["source"]
            target_id = constraint["target"]
            source_offset = generation_offsets.get(source_id)
            target_offset = generation_offsets.get(target_id)

            if relation_type == "child_of":
                if (
                    target_offset is not None
                    and source_offset is None
                ):
                    generation_offsets[source_id] = (
                        target_offset + 1
                    )
                    changed = True
                elif (
                    source_offset is not None
                    and target_offset is None
                ):
                    generation_offsets[target_id] = (
                        source_offset - 1
                    )
                    changed = True

            if relation_type == "parent_of":
                if (
                    source_offset is not None
                    and target_offset is None
                ):
                    generation_offsets[target_id] = (
                        source_offset + 1
                    )
                    changed = True
                elif (
                    target_offset is not None
                    and source_offset is None
                ):
                    generation_offsets[source_id] = (
                        target_offset - 1
                    )
                    changed = True

            if relation_type == "spouse_of":
                if (
                    source_offset is not None
                    and target_offset is None
                ):
                    generation_offsets[target_id] = source_offset
                    changed = True
                elif (
                    target_offset is not None
                    and source_offset is None
                ):
                    generation_offsets[source_id] = target_offset
                    changed = True

        if not changed:
            break

    for node_id, node in nodes.items():
        if node_id not in generation_offsets:
            generation_offsets[node_id] = 0

        node["data"]["generationOffset"] = (
            generation_offsets[node_id]
        )

    genealogical_nodes = set()

    for constraint in explicit_constraints:
        relation_type = constraint["type"]
        source_id = constraint["source"]
        target_id = constraint["target"]

        if relation_type == "child_of":
            add_family_tree_edge(
                relation_edges,
                seen_edges,
                target_id,
                source_id,
                relation_type,
            )
            genealogical_nodes.add(source_id)
            genealogical_nodes.add(target_id)

        if relation_type == "parent_of":
            add_family_tree_edge(
                relation_edges,
                seen_edges,
                source_id,
                target_id,
                relation_type,
            )
            genealogical_nodes.add(source_id)
            genealogical_nodes.add(target_id)

        if relation_type == "spouse_of":
            add_family_tree_edge(
                relation_edges,
                seen_edges,
                source_id,
                target_id,
                relation_type,
            )
            genealogical_nodes.add(source_id)
            genealogical_nodes.add(target_id)

    for node_id in nodes:
        if node_id == "applicant":
            continue

        if (
            node_id in genealogical_nodes
            or node_id in constrained_nodes
        ):
            continue

        offset = generation_offsets.get(node_id, 0)

        if offset <= 0:
            add_family_tree_edge(
                relation_edges,
                seen_edges,
                node_id,
                "applicant",
                "inferred",
            )
        else:
            add_family_tree_edge(
                relation_edges,
                seen_edges,
                "applicant",
                node_id,
                "inferred",
            )

    spouse_partner = {}

    for left_id, right_id in spouse_pairs:
        spouse_partner[left_id] = right_id
        spouse_partner[right_id] = left_id

    parent_to_children = {}
    child_to_parents = {}

    for constraint in explicit_constraints:
        relation_type = constraint["type"]

        if relation_type == "child_of":
            parent_id = constraint["target"]
            child_id = constraint["source"]
        elif relation_type == "parent_of":
            parent_id = constraint["source"]
            child_id = constraint["target"]
        else:
            continue

        parent_to_children.setdefault(
            parent_id,
            []
        ).append(child_id)
        child_to_parents.setdefault(
            child_id,
            []
        ).append(parent_id)

    # Group nodes by household to help place members living together
    household_groups = {}
    for nid, n in nodes.items():
        hid = n.get("data", {}).get("householdId") or ""
        if hid:
            household_groups.setdefault(hid, []).append(nid)

    # applicant's primary household id (if present on the document)
    primary_household_id = serialized.get("primaryHouseholdId") or ""

    def should_stack_children_vertically(unit):
        """Return True when this unit is a sibling (brother/sister)
        living in the applicant's primary household — in that case
        stack their children vertically beneath them instead of
        arranging children horizontally."""
        for member_id in unit:
            node = nodes.get(member_id)
            if not node:
                continue
            relation = normalize_relation_label(
                node["data"].get("relationToApplicant", "")
            )
            if relation in {"brother", "sister"}:
                if node["data"].get("householdId", "") == primary_household_id:
                    # Only stack vertically when this sibling household has
                    # multiple child-units such that horizontal layout would
                    # become very wide. For small sibling families (1-2
                    # child units) prefer the horizontal layout.
                    try:
                        child_units = unit_children(unit)
                        return len(child_units) > 2
                    except Exception:
                        return False

        return False

    def canonical_unit(node_id):
        partner_id = spouse_partner.get(node_id)

        if not partner_id:
            return (node_id,)

        return tuple(
            sorted([node_id, partner_id])
        )

    def order_unit_members(unit):
        members = list(unit)

        if len(members) == 1:
            return members

        if "applicant" in members:
            return sorted(
                members,
                key=lambda value: (
                    0 if value == "applicant" else 1,
                    member_order.get(value, 9999),
                ),
            )

        return sorted(
            members,
            key=lambda value: (
                1 if is_spouse_or_inlaw_relation(
                    ("" if value in members_with_links else nodes[value]["data"].get("relationToApplicant", ""))
                ) else 0,
                member_order.get(value, 9999),
            ),
        )

    def unique_units(node_ids):
        seen = set()
        ordered = []

        for node_id in sorted(
            node_ids,
            key=lambda value: member_order.get(
                value,
                9999,
            ),
        ):
            unit = canonical_unit(node_id)

            if unit in seen:
                continue

            seen.add(unit)
            ordered.append(unit)

        return ordered

    def unit_children(unit):
        children = []

        for member_id in unit:
            children.extend(
                parent_to_children.get(member_id, [])
            )

        return unique_units(children)

    def unit_parents(unit):
        parents = []

        for member_id in unit:
            parents.extend(
                child_to_parents.get(member_id, [])
            )

        return unique_units(
            [
                parent_id
                for parent_id in parents
                if canonical_unit(parent_id) != unit
            ]
        )

    # Spacing constants for family-tree layout. Increased to improve
    # visual separation and reduce overlapping connectors/nodes.
    partner_gap = 150
    unit_gap = 80
    vertical_gap = 240
    single_span = 220
    pair_span = 420
    descendant_width_cache = {}
    placed_units = set()
    member_positions = {}

    def base_unit_span(unit):
        if len(unit) == 1:
            return single_span
        if len(unit) == 2:
            return pair_span
        # For larger household units, allocate more horizontal span
        return max(pair_span, single_span * len(unit))

    def descendant_width(unit, trail=None):
        trail = trail or set()

        if unit in descendant_width_cache:
            return descendant_width_cache[unit]

        if unit in trail:
            return base_unit_span(unit)

        next_trail = set(trail)
        next_trail.add(unit)
        child_units = unit_children(unit)

        if not child_units:
            width = base_unit_span(unit)
        else:
            # If this unit represents a sibling's household living with the
            # applicant, stack children vertically — width should be the max
            # of the base span and the widest child subtree rather than the
            # sum of child widths.
            if should_stack_children_vertically(unit):
                width = max(
                    base_unit_span(unit),
                    max(
                        (descendant_width(child_unit, next_trail) for child_unit in child_units),
                        default=base_unit_span(unit),
                    ),
                )
            else:
                width = max(
                    base_unit_span(unit),
                    sum(
                        descendant_width(
                            child_unit,
                            next_trail,
                        )
                        for child_unit in child_units
                    )
                    + unit_gap
                    * (len(child_units) - 1),
                )

        descendant_width_cache[unit] = width
        return width

    def place_unit(unit, center_x, depth):
        ordered_members = order_unit_members(unit)
        y = depth * vertical_gap

        n = len(ordered_members)
        if n == 1:
            member_positions[ordered_members[0]] = {"x": center_x, "y": y}
            return

        width = base_unit_span(unit)

        # Place N members evenly across the unit width
        for i, member_id in enumerate(ordered_members):
            x = center_x - (width / 2) + (i + 0.5) * (width / n)
            member_positions[member_id] = {"x": x, "y": y}

    def place_descendants(unit, center_x, depth, trail=None):
        trail = trail or set()

        if unit in trail:
            return

        next_trail = set(trail)
        next_trail.add(unit)
        placed_units.add(unit)
        place_unit(
            unit,
            center_x,
            depth,
        )
        child_units = unit_children(unit)

        if not child_units:
            return

        # If stacking vertically (for sibling households living with
        # applicant), place each child unit directly beneath the parent
        # at the same center x (stacked rows). Otherwise, distribute
        # children horizontally as before.
        if should_stack_children_vertically(unit):
            # When stacking children vertically for sibling households,
            # apply a small horizontal offset per child so their connectors
            # don't overlap exactly on the same x coordinate.
            n = len(child_units)
            for idx, child_unit in enumerate(child_units):
                offset = 0
                if n > 1:
                    offset = (idx - (n - 1) / 2) * 40

                place_descendants(
                    child_unit,
                    center_x + offset,
                    depth + 1 + idx,
                    next_trail,
                )
            return

        total_width = (
            sum(
                descendant_width(
                    child_unit,
                    next_trail,
                )
                for child_unit in child_units
            )
            + unit_gap
            * (len(child_units) - 1)
        )
        cursor = center_x - (total_width / 2)

        for child_unit in child_units:
            width = descendant_width(
                child_unit,
                next_trail,
            )
            child_center = cursor + (width / 2)
            place_descendants(
                child_unit,
                child_center,
                depth + 1,
                next_trail,
            )
            cursor += width + unit_gap

    def collect_top_ancestor_units(unit, trail=None):
        trail = trail or set()

        if unit in trail:
            return [unit]

        next_trail = set(trail)
        next_trail.add(unit)
        parent_units = unit_parents(unit)

        if not parent_units:
            return [unit]

        roots = []

        for parent_unit in parent_units:
            roots.extend(
                collect_top_ancestor_units(
                    parent_unit,
                    next_trail,
                )
            )

        deduped = []
        seen = set()

        for root in roots:
            if root in seen:
                continue

            seen.add(root)
            deduped.append(root)

        return deduped

    root_unit = canonical_unit("applicant")
    root_units = collect_top_ancestor_units(root_unit)

    # Include sibling household units (brother/sister) that live in the
    # applicant's primary household so their families appear alongside
    # the applicant rather than in the fallback area.
    primary_household_nodes = household_groups.get(primary_household_id, [])
    for unit in unique_units(primary_household_nodes):
        # Skip if already included
        if unit in root_units:
            continue

        # If the unit contains a sibling relation, promote it to a root unit
        if any(
            normalize_relation_label(
                nodes.get(member_id, {}).get("data", {}).get("relationToApplicant", "")
            ) in {"brother", "sister"}
            for member_id in unit
        ):
            root_units.append(unit)

    # Ensure applicant unit is present and center it at x=0. Place other
    # root units to the left and right of the applicant to avoid
    # overlapping connectors and improve visual clarity.
    if root_unit not in root_units:
        root_units.insert(0, root_unit)

    applicant_unit = root_unit
    applicant_width = descendant_width(applicant_unit)

    # Place applicant (center)
    place_descendants(applicant_unit, 0, 0)

    # Distribute remaining root units around the applicant.
    # Prefer sibling household units (brother/sister living in the
    # applicant's primary household) so they appear adjacent to the
    # applicant rather than pushed far to the edges.
    def unit_is_sibling(unit):
        for member_id in unit:
            node = nodes.get(member_id)
            if not node:
                continue
            if normalize_relation_label(node.get("data", {}).get("relationToApplicant", "")) in {"brother", "sister"}:
                if node.get("data", {}).get("householdId", "") == primary_household_id:
                    return True
        return False

    other_roots = [r for r in root_units if r != applicant_unit]
    # Sort so sibling units (from primary household) come first and are
    # therefore placed closest to the applicant when we split left/right.
    other_roots.sort(key=lambda unit: (0 if unit_is_sibling(unit) else 1, member_order.get(unit[0], 9999)))
    half = len(other_roots) // 2
    left_roots = other_roots[:half]
    right_roots = other_roots[half:]

    # Place left-side roots (reverse order so closest is first)
    # Add extra margin around the applicant so nearby root units don't
    # sit too close and cause connector overlap.
    root_margin = max(unit_gap * 2, 160)
    cursor_left = - (applicant_width / 2) - root_margin
    def unit_is_linear_chain(unit, max_depth=6):
        """Return True when the subtree under `unit` is essentially a
        single-child chain (each node has at most one child) up to
        `max_depth`. These chains can be nudged horizontally to avoid
        crossing other connectors."""
        seen = set()
        depth = 0
        current = unit

        while depth < max_depth:
            if current in seen:
                return True
            seen.add(current)
            children = unit_children(current)
            if not children:
                return True
            if len(children) > 1:
                return False
            current = children[0]
            depth += 1

        return True

    for unit in reversed(left_roots):
        width = descendant_width(unit)
        center_x = cursor_left - (width / 2)

        # If this root is effectively a deep single-child chain, push it
        # a bit further away from the applicant so its vertical connectors
        # don't collide with nearby branches.
        if unit_is_linear_chain(unit):
            center_x -= 120

        place_descendants(unit, center_x, 0)
        cursor_left = center_x - (width / 2) - unit_gap

    # Place right-side roots
    cursor_right = (applicant_width / 2) + root_margin
    for unit in right_roots:
        width = descendant_width(unit)
        center_x = cursor_right + (width / 2)

        # Mirror the same chain heuristic for right-side roots.
        if unit_is_linear_chain(unit):
            center_x += 120

        place_descendants(unit, center_x, 0)
        cursor_right = center_x + (width / 2) + unit_gap

    fallback_units = unique_units(
        list(nodes.keys())
    )
    fallback_depth = max(
        generation_offsets.values(),
        default=0,
    ) + 2
    fallback_cursor = 0

    for unit in fallback_units:
        if unit in placed_units:
            continue

        width = base_unit_span(unit)
        center_x = fallback_cursor + (width / 2)
        place_unit(
            unit,
            center_x,
            fallback_depth,
        )
        fallback_cursor += width + unit_gap

    positioned_nodes = [
        {
            "id": node_id,
            "position": member_positions.get(
                node_id,
                {
                    "x": 0,
                    "y": 0,
                },
            ),
            "data": node["data"],
            "draggable": False,
            "selectable": True,
        }
        for node_id, node in nodes.items()
    ]

    return {
        "nodes": positioned_nodes,
        "edges": relation_edges,
    }


def now_utc():
    return datetime.now(timezone.utc)


def env_flag(name, default=False):
    value = os.getenv(name)

    if value is None:
        return default

    return value.strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def as_utc_datetime(value):
    if not isinstance(value, datetime):
        return value

    if value.tzinfo is None:
        return value.replace(
            tzinfo=timezone.utc
        )

    return value.astimezone(
        timezone.utc
    )


OTP_SETTINGS_KEY = "otp_settings"
OTP_PROVIDER_TEST = "test"
OTP_PROVIDER_MSG91 = "msg91"
OTP_PROVIDER_META = "meta_whatsapp"
OTP_EXPIRY_MINUTES = 5
OTP_RESEND_SECONDS = 30
OTP_MAX_ATTEMPTS = 5


def default_otp_settings(test_mode=False):
    active_provider = (
        OTP_PROVIDER_TEST
        if test_mode
        else OTP_PROVIDER_MSG91
    )

    return {
        "key": OTP_SETTINGS_KEY,
        "activeProvider": active_provider,
        "msg91": {
            "authKey": "",
            "widgetId": "",
            "retryChannel": "text",
        },
        "metaWhatsApp": {
            "accessToken": "",
            "phoneNumberId": "",
            "templateName": "",
            "templateLanguage": "en_US",
        },
        "updatedAt": None,
        "updatedBy": "",
    }


def normalize_otp_settings(payload=None, existing=None, test_mode=False):
    payload = payload or {}
    existing = existing or default_otp_settings(test_mode)

    active_provider = (
        payload.get("activeProvider")
        or existing.get("activeProvider")
        or (
            OTP_PROVIDER_TEST
            if test_mode
            else OTP_PROVIDER_MSG91
        )
    )

    if active_provider not in {
        OTP_PROVIDER_TEST,
        OTP_PROVIDER_MSG91,
        OTP_PROVIDER_META,
    }:
        active_provider = (
            OTP_PROVIDER_TEST
            if test_mode
            else OTP_PROVIDER_MSG91
        )

    return {
        "key": OTP_SETTINGS_KEY,
        "activeProvider": active_provider,
        "msg91": {
            "authKey": clean_text(
                (payload.get("msg91") or {}).get("authKey")
                or (existing.get("msg91") or {}).get("authKey")
            ),
            "widgetId": clean_text(
                (payload.get("msg91") or {}).get("widgetId")
                or (existing.get("msg91") or {}).get("widgetId")
            ),
            "retryChannel": clean_text(
                (payload.get("msg91") or {}).get("retryChannel")
                or (existing.get("msg91") or {}).get("retryChannel")
                or "text"
            ),
        },
        "metaWhatsApp": {
            "accessToken": clean_text(
                (payload.get("metaWhatsApp") or {}).get("accessToken")
                or (existing.get("metaWhatsApp") or {}).get("accessToken")
            ),
            "phoneNumberId": clean_text(
                (payload.get("metaWhatsApp") or {}).get("phoneNumberId")
                or (existing.get("metaWhatsApp") or {}).get("phoneNumberId")
            ),
            "templateName": clean_text(
                (payload.get("metaWhatsApp") or {}).get("templateName")
                or (existing.get("metaWhatsApp") or {}).get("templateName")
            ),
            "templateLanguage": clean_text(
                (payload.get("metaWhatsApp") or {}).get("templateLanguage")
                or (existing.get("metaWhatsApp") or {}).get("templateLanguage")
                or "en_US"
            ),
        },
        "updatedAt": existing.get("updatedAt"),
        "updatedBy": existing.get("updatedBy", ""),
    }


def serialize_public_account(account):
    serialized = serialize_document(account)
    return {
        "id": serialized.get("_id", ""),
        "mobileNumber": serialized.get("mobileNumber", ""),
        "status": serialized.get("status", "pending"),
        "approvedRegistrationId": serialized.get(
            "approvedRegistrationId",
            "",
        ),
        "latestSubmissionId": serialized.get(
            "latestSubmissionId",
            "",
        ),
        "latestVersion": serialized.get("latestVersion", 0),
    }


def serialize_self_registration(document):
    serialized = serialize_registration_document(document)
    serialized["submissionStatus"] = (
        serialized.get("submissionStatus")
        or "pending"
    )
    serialized["version"] = serialized.get("version", 1)
    serialized["auditTrail"] = serialized.get("auditTrail") or []
    return serialized


def clean_text(value=""):
    return " ".join(str(value or "").strip().split())


def ensure_object_id(value):
    if isinstance(value, ObjectId):
        return value

    return ObjectId(str(value))


def object_id_or_none(value):
    try:
        return ensure_object_id(value)
    except (InvalidId, TypeError, ValueError):
        return None


def generate_otp_code(fixed_code=""):
    if fixed_code:
        return str(fixed_code)

    return "".join(
        secrets.choice("0123456789")
        for _ in range(6)
    )


def append_audit_event(document, event_type, actor, note="", timestamp=None):
    timestamp = timestamp or now_utc()
    trail = list(document.get("auditTrail") or [])
    trail.append(
        {
            "type": event_type,
            "actor": actor,
            "note": note,
            "timestamp": timestamp,
        }
    )
    document["auditTrail"] = trail


def create_pending_submission_for_account(
    public_accounts,
    submissions,
    account,
    normalized_value,
    mobile_number,
    now,
    prior_status="pending",
):
    next_version = int(
        account.get("latestVersion", 0)
    ) + 1
    document = {
        **normalized_value,
        "accountId": account["_id"],
        "mobileNumber": mobile_number,
        "version": next_version,
        "submissionStatus": "pending",
        "createdAt": now,
        "updatedAt": now,
        "reviewedAt": None,
        "reviewedBy": "",
        "reviewNote": "",
        "approvedRegistrationId": "",
    }
    event_type = (
        "resubmitted"
        if prior_status == "approved"
        else "submitted"
    )
    append_audit_event(
        document,
        event_type,
        "self",
        timestamp=now,
    )

    insert_result = submissions.insert_one(
        document
    )
    document["_id"] = insert_result.inserted_id

    public_accounts.update_one(
        {
            "_id": account["_id"]
        },
        {
            "$set": {
                "status": "pending",
                "latestSubmissionId": insert_result.inserted_id,
                "latestVersion": next_version,
                "updatedAt": now,
            }
        }
    )
    account["status"] = "pending"
    account["latestSubmissionId"] = (
        insert_result.inserted_id
    )
    account["latestVersion"] = next_version
    account["updatedAt"] = now

    return document


def build_public_session(account):
    session.clear()
    session.permanent = True
    session["auth_type"] = "public"
    session["public_account_id"] = str(account["_id"])
    session["public_mobile"] = account["mobileNumber"]
    session["public_status"] = account.get("status", "pending")
    session["role"] = (
        "viewer"
        if account.get("status") == "approved"
        else "pending_public"
    )


def send_otp_message(settings, mobile_number, otp_code, app_config):
    active_provider = (
        settings.get("activeProvider")
        or OTP_PROVIDER_TEST
    )

    if (
        app_config.get("OTP_TEST_MODE")
        or active_provider == OTP_PROVIDER_TEST
    ):
        return {
            "provider": OTP_PROVIDER_TEST,
            "providerRef": "test-ref",
        }

    if active_provider == OTP_PROVIDER_MSG91:
        msg91 = settings.get("msg91") or {}

        if not msg91.get("authKey") or not msg91.get("widgetId"):
            raise ValueError("MSG91 settings are incomplete.")

        response = requests.post(
            "https://api.msg91.com/api/v5/widget/sendOtp",
            headers={
                "authkey": msg91["authKey"],
                "content-type": "application/json",
            },
            json={
                "widgetId": msg91["widgetId"],
                "identifier": mobile_number,
            },
            timeout=15,
        )
        response.raise_for_status()
        body = response.json()
        return {
            "provider": OTP_PROVIDER_MSG91,
            "providerRef": (
                body.get("reqId")
                or body.get("request_id")
                or body.get("message")
                or ""
            ),
        }

    if active_provider == OTP_PROVIDER_META:
        meta = settings.get("metaWhatsApp") or {}

        if (
            not meta.get("accessToken")
            or not meta.get("phoneNumberId")
            or not meta.get("templateName")
        ):
            raise ValueError("Meta WhatsApp settings are incomplete.")

        response = requests.post(
            f"https://graph.facebook.com/v23.0/{meta['phoneNumberId']}/messages",
            headers={
                "Authorization": f"Bearer {meta['accessToken']}",
                "Content-Type": "application/json",
            },
            json={
                "messaging_product": "whatsapp",
                "to": mobile_number.replace("+", ""),
                "type": "template",
                "template": {
                    "name": meta["templateName"],
                    "language": {
                        "code": meta.get("templateLanguage") or "en_US"
                    },
                    "components": [
                        {
                            "type": "body",
                            "parameters": [
                                {
                                    "type": "text",
                                    "text": otp_code,
                                }
                            ],
                        }
                    ],
                },
            },
            timeout=15,
        )
        response.raise_for_status()
        body = response.json()
        return {
            "provider": OTP_PROVIDER_META,
            "providerRef": (
                ((body.get("messages") or [{}])[0]).get("id")
                or ""
            ),
        }

    raise ValueError("Unsupported OTP provider.")


ROLE_ASSIGNMENT_RULES = {
    "super_admin": [
        "super_admin",
        "admin",
        "operator",
        "viewer",
    ],
    "admin": [
        "operator",
        "viewer",
    ],
}

ROLE_DELETION_RULES = {
    "super_admin": [
        "super_admin",
        "admin",
        "operator",
        "viewer",
    ],
    "admin": [
        "operator",
        "viewer",
    ],
}


def get_assignable_roles(role):
    return ROLE_ASSIGNMENT_RULES.get(
        role,
        [],
    )


def get_deletable_roles(role):
    return ROLE_DELETION_RULES.get(
        role,
        [],
    )
