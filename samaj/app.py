import os
from datetime import datetime, timezone

from bson import ObjectId
from flask import Flask, jsonify, render_template, request

from .corrections import (
    collect_transliteration_corrections,
    load_corrections,
    save_corrections,
)
from .db import create_collections
from .registration import validate_registration
from .transliterate import transliteration_suggestions


def create_app(config=None, collection=None, correction_collection=None):
    app = Flask(__name__)

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
        return render_template("index.html")

    @app.route("/directory")
    def directory():
        return render_template(
            "directory.html"
        )

    @app.get("/api/health")
    def health():
        return jsonify({"ok": True})

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
                    "registration": serialize_document(document),
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
                    serialize_document(document)
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
                    serialize_document(doc)
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


def clamp(value, minimum, maximum):
    return min(max(value, minimum), maximum)
