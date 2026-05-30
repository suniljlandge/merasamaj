import os
from datetime import datetime, timezone
import bcrypt

from bson import ObjectId
from flask_session import Session

from .migration import (
    transform_old_record,
    find_duplicate,
    regenerate_marathi_fields,
)

from flask import (
    Flask,
    jsonify,
    render_template,
    request,
    session,
    redirect,
)

from .corrections import (
    collect_transliteration_corrections,
    load_corrections,
    save_corrections,
)
from .db import create_collections
from .registration import (
    normalize_relationship_links,
    validate_registration,
)
from .transliterate import transliteration_suggestions


def create_app(config=None, collection=None, correction_collection=None):
    app = Flask(__name__)

    app.config["SECRET_KEY"] = (
        "samaj-secret-key"
    )

    app.config["SESSION_TYPE"] = (
        "filesystem"
    )

    Session(app)

    app.config.update(
        MONGO_URI=os.getenv("MONGO_URI", "mongodb://127.0.0.1:27017"),
        MONGO_DB=os.getenv("MONGO_DB", "samaj"),
        MONGO_COLLECTION=os.getenv("MONGO_COLLECTION", "registrations"),
        MONGO_CORRECTIONS_COLLECTION=os.getenv(
            "MONGO_CORRECTIONS_COLLECTION",
            "transliteration_corrections",
        ),
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

        if not require_auth():
            return redirect("/login")

        return render_template(
            "view-member.html",
            current_role=session.get("role")
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

        if not require_role(
            "admin",
            "super_admin"
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

        return render_template(
            "directory.html",
            current_role=session.get("role")
        )

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


    @app.get("/api/registrations/<id>")
    def get_registration(id):

        document = (
            get_collection()
            .find_one({
                "_id": ObjectId(id)
            })
        )

        if not document:
            return jsonify({
                "error": "Not found"
            }), 404

        return jsonify(
            serialize_registration_document(
                document
            )
        )

    @app.put("/api/registrations/<id>")
    def update_registration(id):

        if not require_role(
            "admin",
            "super_admin"
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

        document = {
            **result["value"],
            "updatedAt":
                datetime.now(
                    timezone.utc
                )
        }

        get_collection().update_one(
            {
                "_id": ObjectId(id)
            },
            {
                "$set": document
            }
        )

        return jsonify({
            "ok": True
        })

    @app.post("/api/registrations")

    def create_registration():
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
            "updatedAt": now,
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
            mongo_query["$or"] = [
                {
                    "firstName.en": {
                        "$regex": query,
                        "$options": "i",
                    }
                },
                {
                    "lastName.en": {
                        "$regex": query,
                        "$options": "i",
                    }
                },
                {
                    "firstName.mr": {
                        "$regex": query,
                        "$options": "i",
                    }
                },
                {
                    "lastName.mr": {
                        "$regex": query,
                        "$options": "i",
                    }
                },
                {
                    "mobileNumber": {
                        "$regex": query,
                        "$options": "i",
                    }
                },
            ]

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

        cursor = (
            get_collection()
            .find(mongo_query)
            .sort("createdAt", -1)
            .limit(200)
        )

        return jsonify(
            {
                "items": [
                    serialize_registration_document(doc)
                    for doc in cursor
                ]
            }
        )

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
        query = request.args.get("q", "").strip()

        if not query:
            return jsonify({"suggestions": []})

        corrections = load_corrections(
            get_correction_collection()
        )

        normalized = query.lower().strip()
        suggestions = []

        if normalized in corrections:
            suggestions.append(corrections[normalized])

        google_suggestions = transliteration_suggestions(query)

        for item in google_suggestions:
            if item not in suggestions:
                suggestions.append(item)

        return jsonify({"suggestions": suggestions[:8]})

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
    return "user_id" in session

def require_role(*roles):
    return (
        session.get("role")
        in roles
    )

def current_role():
    return session.get("role")
