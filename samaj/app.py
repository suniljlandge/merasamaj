import os
import re
import csv
import io
import secrets
import functools
from datetime import datetime, timedelta, timezone
import bcrypt
import requests
from pymongo import MongoClient, UpdateOne
from bson import ObjectId
from bson.errors import InvalidId
from flask import (
    Flask,
    render_template,
    request,
    jsonify,
    session,
    redirect,
    url_for,
    current_app,
    Response,
)
from flask_session import Session

from .registration import (
    clean_text,
    normalize_relationship_links,
    normalize_phone,
    normalize_public_mobile,
    validate_registration,
    get_redirect_for_account,
    normalize_account_type,
    DEFAULT_ACCOUNT_TYPE,
    ACCOUNT_TYPE_CAMPAIGNER,
    ACCOUNT_TYPE_REGISTRANT,
)
from . import campaign
from .campaign import (
    get_hof_by_area,
    get_areas_with_counts,
    get_distinct_surname_groups,
    get_ad_templates,
    validate_campaign_status_transition,
    PAYMENT_VERIFIED,
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

from .tn_service import resolve_true_name, resolve_batch

from . import data_tools
from . import pdf_export


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

DATA_TOOLS_EXPORT_KEY = "data_tools_export_columns"

# Catalog of exportable columns. `default` is used until the super admin saves
# a configuration. Sensitive columns (mobile) default to OFF.
DATA_TOOLS_EXPORT_COLUMNS = [
    {"key": "area", "label": "Area", "default": True},
    {"key": "name", "label": "Name (EN)", "default": True},
    {"key": "name_mr", "label": "Name (MR)", "default": True},
    {"key": "mobile", "label": "Mobile Number", "default": False},
    {"key": "address1_clean", "label": "Address 1 (clean)", "default": True},
    {"key": "address2_clean", "label": "Address 2 (clean)", "default": True},
    {"key": "address1_raw", "label": "Address 1 (raw)", "default": False},
    {"key": "address2_raw", "label": "Address 2 (raw)", "default": False},
    {"key": "address1_mr", "label": "Address 1 (MR)", "default": False},
    {"key": "address2_mr", "label": "Address 2 (MR)", "default": False},
    {"key": "district", "label": "District", "default": False},
    {"key": "taluka", "label": "Taluka", "default": False},
    {"key": "surname", "label": "Surname group", "default": False},
    {"key": "members", "label": "Members", "default": True},
    {"key": "createdBy", "label": "Created By", "default": True},
]

# Whitelist of editable bilingual field paths for the inline transliteration fix.
DATA_TOOLS_FIELD_PATTERN = re.compile(
    r"^(firstName|middleName|lastName|familyMembers\.\d+\.(name|spouseName))$"
)


def _export_row_value(area, row, key):
    if key == "area":
        return area
    return row.get(key, "")


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
        # UPI payment config for the Campaign Manager. Loaded from the
        # environment at startup so the campaign module can read them from
        # app config (with an env fallback).
        UPI_ID=os.getenv("UPI_ID", "").strip(),
        UPI_PAYEE_NAME=os.getenv("UPI_PAYEE_NAME", "SAMAJ").strip(),
    )

    if config:
        app.config.update(config)

    app.extensions["mongo_client"] = None
    app.extensions["mongo_collection"] = collection
    app.extensions["mongo_correction_collection"] = correction_collection

    # --- WhatsApp Web integration (hybrid messaging) ---
    from .whatsapp_web_routes import wa_web_bp
    app.register_blueprint(wa_web_bp)

    @app.context_processor
    def inject_nav_capabilities():
        """Expose capability checks to all templates so nav buttons follow the
        super-admin permission matrix instead of hard-coded roles."""
        def can(capability):
            try:
                return role_can(capability)
            except Exception:
                return False

        return {
            "can": can,
            "can_data_tools": (
                can("manage_transliteration") or can("manage_address_areas")
            ),
        }

    @app.route("/")
    def index():

        if not require_auth():
            return redirect("/login")

        # Campaigner sessions land on the campaign manager, not self-register.
        # is_pending_public_session() is True for campaigners (their status is
        # never "approved"), so this check must come first.
        if is_campaigner_session():
            return redirect("/campaign-manager")

        if is_pending_public_session():
            return redirect(
                "/self-register"
            )

        role = current_role()

        if role == "viewer":
            return redirect(
                "/directory"
            )

        # Campaign admin defaults to campaign manager but can still access
        # the staff dashboard via this route when navigating directly.
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

        # Campaigners never use the self-registration form.
        if is_campaigner_session():
            return redirect("/campaign-manager")

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

    @app.route("/campaign-manager")
    def campaign_manager_page():

        # Campaigner public sessions, campaign_admin staff sessions, and
        # staff users with the 'campaigner' role may view the campaign manager.
        if (
            not is_campaigner_session()
            and not is_campaign_admin_session()
            and not (is_staff_session() and session.get("role") == "campaigner")
        ):
            return redirect("/login")

        return render_template(
            "campaign-manager.html",
            current_role=current_role(),
            is_campaign_admin=is_campaign_admin_session(),
        )

    @app.route("/otp-settings")
    def otp_settings_page():

        if not role_can("manage_otp_settings"):
            return redirect("/directory")

        return render_template(
            "otp-settings.html",
            current_role=current_role()
        )

    @app.route("/self-registration-review")
    def self_registration_review_page():

        if not role_can("review_self_registrations"):
            return redirect("/directory")

        return render_template(
            "self-registration-review.html",
            current_role=current_role()
        )

    @app.route("/user-management")
    def user_management_page():

        if not role_can("manage_users"):
            return redirect("/directory")

        return render_template(
            "user-management.html",
            current_role=session.get("role"),
            allowed_roles=get_assignable_roles(
                current_role()
            )
        )

    @app.route("/superadmin")
    def superadmin_dashboard_page():

        if not role_can("manage_role_config"):
            return redirect("/directory")

        return render_template(
            "superadmin.html",
            current_role=current_role(),
        )

    @app.route("/whatsapp-web")
    def whatsapp_web_page():
        """WhatsApp Web connection page — available to users with manage_wa_web."""
        if not role_can("manage_wa_web"):
            return redirect("/directory")
        return render_template(
            "whatsapp-web.html",
            current_role=current_role(),
        )

    @app.route("/wa-routing")
    def wa_routing_page():
        """Routing engine control panel — super admin only."""
        if not role_can("manage_wa_routing"):
            return redirect("/directory")
        return render_template(
            "wa-routing.html",
            current_role=current_role(),
        )

    @app.route("/campaign-payments")
    def campaign_payments_page():
        """Dedicated page for confirming pending UPI campaign payments."""

        if not is_staff_session() or not role_can("confirm_campaign_payments"):
            return redirect("/directory")

        return render_template(
            "campaign-payments.html",
            current_role=current_role(),
        )

    @app.route("/data-tools")
    def data_tools_page():

        can_translit = role_can("manage_transliteration")
        can_address = role_can("manage_address_areas")
        if not (can_translit or can_address):
            return redirect("/directory")

        return render_template(
            "data-tools.html",
            current_role=current_role(),
            can_translit=can_translit,
            can_address=can_address,
            can_export_areas=role_can("export_address_areas"),
            is_super_admin=current_role() == "super_admin",
        )

    def _export_settings_doc():
        return (
            get_settings_collection().find_one({"key": DATA_TOOLS_EXPORT_KEY})
            or {}
        )

    def _column_default_for_role(col, role):
        # Super admin can export everything by default; other roles fall back to
        # the column's own default (sensitive columns like mobile -> off).
        if role == "super_admin":
            return True
        return col.get("default", True)

    def _enabled_columns_for_role(role):
        per_role = _export_settings_doc().get("perRole") or {}
        role_map = per_role.get(role) or {}
        return [
            col for col in DATA_TOOLS_EXPORT_COLUMNS
            if bool(role_map.get(col["key"], _column_default_for_role(col, role)))
        ]

    @app.get("/api/data-tools/export-config")
    def data_tools_export_config_get():

        # The per-role export-column matrix is a super-admin setting.
        if current_role() != "super_admin":
            return jsonify({"error": "Forbidden"}), 403

        per_role = _export_settings_doc().get("perRole") or {}
        matrix = {}
        for role in MANAGED_ROLES:
            role_map = per_role.get(role) or {}
            matrix[role] = {
                col["key"]: bool(role_map.get(
                    col["key"], _column_default_for_role(col, role)))
                for col in DATA_TOOLS_EXPORT_COLUMNS
            }

        return jsonify({
            "columns": [
                {"key": c["key"], "label": c["label"]}
                for c in DATA_TOOLS_EXPORT_COLUMNS
            ],
            "roles": [
                {"key": r, "label": ROLE_LABELS.get(r, r)}
                for r in MANAGED_ROLES
            ],
            "matrix": matrix,
        })

    @app.put("/api/data-tools/export-config")
    def data_tools_export_config_put():

        if current_role() != "super_admin":
            return jsonify({"error": "Forbidden"}), 403

        payload = request.get_json(silent=True) or {}
        incoming = payload.get("matrix") or {}
        valid_cols = {col["key"] for col in DATA_TOOLS_EXPORT_COLUMNS}

        per_role = {}
        for role in MANAGED_ROLES:
            role_in = incoming.get(role) or {}
            per_role[role] = {
                key: bool(role_in.get(key, False))
                for key in valid_cols
            }

        get_settings_collection().update_one(
            {"key": DATA_TOOLS_EXPORT_KEY},
            {"$set": {
                "key": DATA_TOOLS_EXPORT_KEY,
                "perRole": per_role,
                "updatedAt": now_utc(),
                "updatedBy": session.get("username", ""),
            }},
            upsert=True,
        )
        return jsonify({"ok": True})

    @app.get("/api/data-tools/address-areas")
    def data_tools_address_areas():

        if not role_can("manage_address_areas"):
            return jsonify({"error": "Forbidden"}), 403

        documents = list(get_collection().find({}))
        groups, summary = data_tools.address_report(documents)

        area = request.args.get("area", "").strip()
        rows = groups.get(area, []) if area else []

        return jsonify({
            "summary": summary,
            "totalFamilies": sum(s["families"] for s in summary),
            "rows": rows,
        })

    @app.get("/api/data-tools/address-areas/export")
    def data_tools_address_export():

        if not (role_can("manage_address_areas") and role_can("export_address_areas")):
            return jsonify({"error": "Forbidden"}), 403

        columns = _enabled_columns_for_role(current_role())
        if not columns:
            return jsonify({
                "error": "No export columns are enabled for your role. "
                         "Ask a super admin to allow some in the dashboard."
            }), 403

        documents = list(get_collection().find({}))
        groups, summary = data_tools.address_report(documents)

        # "area" becomes the per-section heading, so it is dropped from the
        # table body columns.
        body_columns = [c for c in columns if c["key"] != "area"]
        if not body_columns:
            body_columns = columns

        family_counts = {s["area"]: s["families"] for s in summary}
        areas = []
        for area in sorted(groups):
            rows = [
                [_export_row_value(area, r, c["key"]) for c in body_columns]
                for r in groups[area]
            ]
            areas.append((area, family_counts.get(area, len(rows)), rows))

        generated = now_utc().strftime("%Y-%m-%d %H:%M UTC")
        watermark_path = os.path.join(
            os.path.dirname(__file__), "static", "samajwatermark1000.png"
        )
        pdf_bytes = pdf_export.render_address_pdf(
            headers=[c["label"] for c in body_columns],
            keys=[c["key"] for c in body_columns],
            areas=areas,
            title="SAMAJ — Address Areas Directory",
            subtitle=(
                f"{sum(s['families'] for s in summary)} families across "
                f"{len(summary)} areas · generated {generated}"
            ),
            watermark_path=watermark_path,
            watermark_text="SAMAJ",
        )

        timestamp = now_utc().strftime("%Y%m%d-%H%M%S")
        return Response(
            pdf_bytes,
            mimetype="application/pdf",
            headers={
                "Content-Disposition":
                    f'attachment; filename="samaj-address-areas-{timestamp}.pdf"',
            },
        )

    @app.get("/api/data-tools/translit/suspects")
    def data_tools_translit_suspects():

        if not role_can("manage_transliteration"):
            return jsonify({"error": "Forbidden"}), 403

        overrides = load_corrections(get_correction_collection())
        documents = list(get_collection().find(
            {},
            {
                "firstName": 1, "middleName": 1, "lastName": 1,
                "familyMembers.name": 1, "familyMembers.spouseName": 1,
            },
        ))
        result = data_tools.analyze_names(documents, overrides)
        return jsonify(result)

    @app.get("/api/data-tools/translit/scan")
    def data_tools_translit_scan():

        if not role_can("manage_transliteration"):
            return jsonify({"error": "Forbidden"}), 403

        overrides = load_corrections(get_correction_collection())
        documents = list(get_collection().find(
            {},
            {
                "firstName": 1, "middleName": 1, "lastName": 1,
                "familyMembers.name": 1, "familyMembers.spouseName": 1,
            },
        ))

        def generate():
            import json as _json
            from concurrent.futures import ThreadPoolExecutor, as_completed

            stats, unaligned = data_tools.collect_stats(documents)
            todo = data_tools.words_needing_lookup(stats, unaligned, overrides)
            total = len(todo)
            yield _json.dumps({
                "phase": "fetch", "processed": 0, "total": total,
                "records": len(documents),
            }) + "\n"

            done = 0
            if todo:
                with ThreadPoolExecutor(max_workers=16) as pool:
                    futures = {pool.submit(data_tools.fetch_one, w): w for w in todo}
                    for _fut in as_completed(futures):
                        done += 1
                        if done % 5 == 0 or done == total:
                            yield _json.dumps({
                                "phase": "fetch",
                                "processed": done, "total": total,
                            }) + "\n"

            suspects, ok_count = data_tools.finalize_suspects(stats, overrides)
            for item in unaligned:
                item["suggestion"] = data_tools.phrase_suggestion(
                    item["en"], overrides)

            yield _json.dumps({
                "done": True,
                "result": {
                    "suspects": suspects,
                    "distinctWords": len(stats),
                    "okWords": ok_count,
                    "unaligned": unaligned,
                },
            }) + "\n"

        return Response(
            generate(),
            mimetype="application/x-ndjson",
            headers={"Cache-Control": "no-store"},
        )

    @app.post("/api/data-tools/translit/resolve")
    def data_tools_translit_resolve():

        if not role_can("manage_transliteration"):
            return jsonify({"error": "Forbidden"}), 403

        payload = request.get_json(silent=True) or {}
        picks = payload.get("picks") or {}

        corrections = {}
        for word, marathi in picks.items():
            source = data_tools.clean_text(word).lower()
            target = data_tools.clean_text(marathi)
            if source and target:
                corrections[source] = target

        saved = save_corrections(get_correction_collection(), corrections)
        return jsonify({"ok": True, "saved": saved})

    @app.post("/api/data-tools/translit/fix-record")
    def data_tools_translit_fix_record():

        if not role_can("manage_transliteration"):
            return jsonify({"error": "Forbidden"}), 403

        payload = request.get_json(silent=True) or {}
        record_id = object_id_or_none(payload.get("id"))
        field = data_tools.clean_text(payload.get("field"))
        marathi = data_tools.clean_text(payload.get("mr"))
        english = data_tools.clean_text(payload.get("en"))

        if not record_id or not DATA_TOOLS_FIELD_PATTERN.match(field) or not marathi:
            return jsonify({"error": "Invalid request"}), 400

        result = get_collection().update_one(
            {"_id": record_id},
            {"$set": {f"{field}.mr": marathi, "updatedAt": now_utc()}},
        )

        # Remember the whole-phrase correction so identical phrases auto-fix later.
        if english:
            save_corrections(
                get_correction_collection(),
                {english.lower(): marathi},
            )

        return jsonify({"ok": True, "matched": result.matched_count})

    @app.post("/api/data-tools/translit/apply")
    def data_tools_translit_apply():

        if not role_can("manage_transliteration"):
            return jsonify({"error": "Forbidden"}), 403

        overrides = load_corrections(get_correction_collection())
        collection = get_collection()

        projection = {
            "firstName": 1, "middleName": 1, "lastName": 1, "familyMembers": 1,
        }

        def generate():
            import json as _json
            total = collection.count_documents({})
            yield _json.dumps({"total": total}) + "\n"

            processed = 0
            updated = 0
            ops = []
            for document in collection.find({}, projection):
                processed += 1
                changes = data_tools.apply_overrides_to_doc(document, overrides)
                if changes:
                    changes["updatedAt"] = now_utc()
                    ops.append(UpdateOne(
                        {"_id": document["_id"]},
                        {"$set": changes},
                    ))
                    updated += 1
                if len(ops) >= 200:
                    collection.bulk_write(ops, ordered=False)
                    ops = []
                if processed % 25 == 0 or processed == total:
                    yield _json.dumps({
                        "processed": processed,
                        "updated": updated,
                        "total": total,
                    }) + "\n"
            if ops:
                collection.bulk_write(ops, ordered=False)
            yield _json.dumps({
                "done": True, "processed": processed, "updated": updated,
            }) + "\n"

        return Response(generate(), mimetype="application/x-ndjson")

    @app.get("/api/data-tools/translit/auto-suggest")
    def data_tools_translit_auto_suggest():

        # Preview only: returns the best spelling for each flagged word WITHOUT
        # saving or modifying any record. The UI pre-selects these in the cards
        # so the admin can review, adjust, then Save picks + Apply.
        if not role_can("manage_transliteration"):
            return jsonify({"error": "Forbidden"}), 403

        overrides = load_corrections(get_correction_collection())
        documents = list(get_collection().find(
            {},
            {
                "firstName": 1, "middleName": 1, "lastName": 1,
                "familyMembers.name": 1, "familyMembers.spouseName": 1,
            },
        ))
        stats, _unaligned = data_tools.collect_stats(documents)
        suggestions = data_tools.compute_auto_canonical(stats, overrides)
        return jsonify({
            "suggestions": suggestions,
            "words": len(suggestions),
        })

    @app.get("/api/data-tools/translit/inspect")
    def data_tools_translit_inspect():

        if not role_can("manage_transliteration"):
            return jsonify({"error": "Forbidden"}), 403

        q = data_tools.clean_text(request.args.get("q")).lower()
        if not q:
            return jsonify({"results": []})

        rx = {"$regex": re.escape(q), "$options": "i"}
        query = {"$or": [
            {"firstName.en": rx},
            {"middleName.en": rx},
            {"lastName.en": rx},
            {"familyMembers.name.en": rx},
        ]}
        overrides = load_corrections(get_correction_collection())
        docs = list(get_collection().find(
            query,
            {"firstName": 1, "middleName": 1, "lastName": 1, "familyMembers": 1},
        ).limit(25))
        return jsonify({
            "results": data_tools.inspect_documents(docs, overrides),
        })

    @app.get("/api/role-config")
    def get_role_config():

        if not role_can("manage_role_config"):
            return jsonify({
                "error": "Forbidden"
            }), 403

        return jsonify({
            "config": serialize_document(effective_role_config()),
            "roles": [
                {
                    "key": role,
                    "label": ROLE_LABELS.get(role, role),
                }
                for role in MANAGED_ROLES
            ],
            "capabilities": ROLE_CAPABILITIES,
            "limits": ROLE_LIMITS,
            "lockedCapabilities": {
                "super_admin": sorted(SUPER_ADMIN_LOCKED_CAPABILITIES),
            },
        })

    @app.get("/api/public-accounts")
    def list_public_accounts():
        """List public (OTP-login) accounts for super-admin management.

        Returns id, mobile number, account type, and status so the super-admin
        dashboard can toggle an account between "registrant" and "campaigner".
        """
        if not role_can("manage_role_config"):
            return jsonify({"error": "Forbidden"}), 403

        accounts = list(
            get_public_accounts_collection()
            .find({})
            .sort("updatedAt", -1)
        )

        return jsonify({
            "accounts": [
                serialize_public_account(account)
                for account in accounts
            ]
        })

    @app.put("/api/public-accounts/<account_id>/account-type")
    def set_public_account_type(account_id):
        """Set a public account's accountType (campaigner | registrant).

        Super-admin only. This is how a member's account is promoted to a
        campaigner so they are routed to /campaign-manager on next login.
        """
        if not role_can("manage_role_config"):
            return jsonify({"error": "Forbidden"}), 403

        payload = request.get_json(silent=True) or {}
        requested = clean_text(payload.get("accountType")).lower()

        if requested not in (
            ACCOUNT_TYPE_CAMPAIGNER,
            ACCOUNT_TYPE_REGISTRANT,
        ):
            return jsonify({
                "error": (
                    "accountType must be 'campaigner' or 'registrant'."
                )
            }), 400

        account_object_id = object_id_or_none(account_id)
        if account_object_id is None:
            return jsonify({"error": "Invalid account id."}), 400

        public_accounts = get_public_accounts_collection()
        account = public_accounts.find_one({"_id": account_object_id})

        if not account:
            return jsonify({"error": "Account not found."}), 404

        account_type = normalize_account_type(requested)
        public_accounts.update_one(
            {"_id": account_object_id},
            {
                "$set": {
                    "accountType": account_type,
                    "updatedAt": now_utc(),
                }
            },
        )
        account["accountType"] = account_type

        return jsonify({
            "ok": True,
            "account": serialize_public_account(account),
        })

    @app.get("/api/public-signup-settings")
    def get_public_signup_settings():
        """Return the global default account type for new mobile signups."""
        if not role_can("manage_role_config"):
            return jsonify({"error": "Forbidden"}), 403

        return jsonify({
            "defaultAccountType": read_default_account_type(
                get_settings_collection()
            )
        })

    @app.put("/api/public-signup-settings")
    def update_public_signup_settings():
        """Set the global default account type applied to all future first-time
        mobile logins (super-admin only). When set to "campaigner", every new
        OTP signup becomes a campaigner; when "registrant", a self-registration
        user."""
        if not role_can("manage_role_config"):
            return jsonify({"error": "Forbidden"}), 403

        payload = request.get_json(silent=True) or {}
        requested = clean_text(payload.get("defaultAccountType")).lower()

        if requested not in (
            ACCOUNT_TYPE_CAMPAIGNER,
            ACCOUNT_TYPE_REGISTRANT,
        ):
            return jsonify({
                "error": (
                    "defaultAccountType must be 'campaigner' or 'registrant'."
                )
            }), 400

        account_type = normalize_account_type(requested)
        settings_collection = get_settings_collection()
        existing = settings_collection.find_one(
            {"key": PUBLIC_SIGNUP_SETTINGS_KEY}
        )
        doc = {
            "key": PUBLIC_SIGNUP_SETTINGS_KEY,
            "defaultAccountType": account_type,
            "updatedAt": now_utc(),
            "updatedBy": session.get("username", ""),
        }
        if existing:
            settings_collection.update_one(
                {"key": PUBLIC_SIGNUP_SETTINGS_KEY},
                {"$set": doc},
            )
        else:
            settings_collection.insert_one(doc)

        return jsonify({"ok": True, "defaultAccountType": account_type})

    @app.put("/api/role-config")
    def update_role_config():

        if not role_can("manage_role_config"):
            return jsonify({
                "error": "Forbidden"
            }), 403

        payload = request.get_json(silent=True) or {}

        settings_collection = get_settings_collection()
        existing = settings_collection.find_one({
            "key": ROLE_CONFIG_KEY
        })

        config = normalize_role_config(
            payload,
            existing=existing,
        )
        config["updatedAt"] = now_utc()
        config["updatedBy"] = session.get("username", "")

        if existing:
            settings_collection.update_one(
                {"key": ROLE_CONFIG_KEY},
                {"$set": config},
            )
        else:
            settings_collection.insert_one(config)

        return jsonify({
            "ok": True,
            "config": serialize_document(config),
        })

    @app.post("/api/bulk-import")
    def bulk_import_endpoint():

        if not role_can("bulk_import"):
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

        # Campaigners get read-only directory access, so don't bounce them to
        # self-register. Other pending public sessions still go there.
        if is_pending_public_session() and not is_campaigner_session():
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

        if not role_can("view_leaderboard"):
            return redirect("/directory")

        return render_template(
            "operator-leaderboard.html",
            current_role=current_role()
        )

    @app.get("/api/operator-performance")
    def operator_performance():

        if not role_can("view_leaderboard"):
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


    @app.get("/api/export/filters")
    def export_filters():

        if not role_can("export_directory"):
            return jsonify({
                "error": "Forbidden"
            }), 403

        collection = get_collection()

        def distinct_values(field):
            try:
                values = collection.distinct(field)
            except Exception:
                values = []
            return sorted(
                str(value)
                for value in values
                if value not in (None, "")
            )

        return jsonify({
            "states": distinct_values("state"),
            "districts": distinct_values("district"),
            "talukas": distinct_values("taluka"),
            "surnameGroups": distinct_values("surnameGroup"),
            "createdBy": distinct_values("createdBy"),
            "relations": export_relation_options(),
            "sortOptions": [
                {"key": "recent", "label": "Newest first"},
                {"key": "address", "label": "Address (A-Z)"},
                {"key": "location", "label": "District / Taluka"},
                {"key": "surname", "label": "Surname group"},
                {"key": "name", "label": "Applicant name"},
            ],
        })

    @app.get("/api/export")
    def export():

        if not role_can("export_directory"):
            return jsonify({
                "error": "Forbidden"
            }), 403

        mode = (
            request.args.get("mode", "detailed")
            .strip()
            .lower()
        )
        if mode not in {"detailed", "summary"}:
            mode = "detailed"

        query = request.args.get("q", "").strip()
        state = request.args.get("state", "").strip()
        district = request.args.get("district", "").strip()
        taluka = request.args.get("taluka", "").strip()
        surname = request.args.get("surname", "").strip()
        created_by = request.args.get("createdBy", "").strip()
        sort_key = request.args.get("sort", "recent").strip().lower()

        # Relation filter: comma-separated relation keys. Empty -> include all.
        relations_raw = request.args.get("relations", "").strip()
        selected_relation_keys = None
        if relations_raw:
            valid_keys = {
                option["key"]
                for option in export_relation_options()
            }
            requested = {
                _relation_filter_key(token) if "(" in token else token.strip().lower()
                for token in relations_raw.split(",")
                if token.strip()
            }
            selected_relation_keys = {
                key for key in requested if key in valid_keys
            }
            # If nothing valid was selected, fall back to including everything.
            if not selected_relation_keys:
                selected_relation_keys = None

        mongo_query = {}
        conditions = []

        if query:
            query_tokens = [
                token.strip()
                for token in re.split(r"\s+", query)
                if token.strip()
            ]
            search_fields = [
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
            for token in query_tokens:
                if token.startswith("#"):
                    username = token[1:]
                    if username:
                        conditions.append({
                            "createdBy": {
                                "$regex": f"^{re.escape(username)}$",
                                "$options": "i",
                            }
                        })
                else:
                    conditions.append({
                        "$or": [
                            {
                                field: {
                                    "$regex": re.escape(token),
                                    "$options": "i",
                                }
                            }
                            for field in search_fields
                        ]
                    })

        if state:
            mongo_query["state"] = state
        if district:
            mongo_query["district"] = district
        if taluka:
            mongo_query["taluka"] = taluka
        if surname:
            mongo_query["surnameGroup"] = surname.lower()
        if created_by:
            mongo_query["createdBy"] = created_by

        if conditions:
            mongo_query["$and"] = conditions

        # Operators / viewers may only export records they created.
        if not role_can("view_all_registrations"):
            mongo_query["createdBy"] = session.get("username", "")

        max_records = get_role_limit("exportMaxRecords")

        sort_specs = {
            "recent": [("createdAt", -1)],
            "address": [("address1.en", 1), ("createdAt", -1)],
            "location": [("district", 1), ("taluka", 1), ("address1.en", 1)],
            "surname": [("surnameGroup", 1), ("lastName.en", 1)],
            "name": [("firstName.en", 1), ("lastName.en", 1)],
        }
        sort_spec = sort_specs.get(sort_key, sort_specs["recent"])

        cursor = (
            get_collection()
            .find(mongo_query)
            .sort(sort_spec)
            .limit(max_records)
        )

        headers = (
            DIRECTORY_EXPORT_SUMMARY_HEADERS
            if mode == "summary"
            else DIRECTORY_EXPORT_DETAILED_HEADERS
        )

        def generate_csv():
            buffer = io.StringIO()
            writer = csv.writer(buffer)

            # UTF-8 BOM so Excel reads Marathi/Unicode correctly.
            buffer.write("\ufeff")
            writer.writerow(headers)
            yield buffer.getvalue()
            buffer.seek(0)
            buffer.truncate(0)

            for document in cursor:
                for row in build_directory_export_rows(
                    document,
                    mode,
                    selected_relation_keys=selected_relation_keys,
                ):
                    writer.writerow(row)
                yield buffer.getvalue()
                buffer.seek(0)
                buffer.truncate(0)

        timestamp = now_utc().strftime("%Y%m%d-%H%M%S")
        filename = f"samaj-directory-{mode}-{timestamp}.csv"

        return Response(
            generate_csv(),
            mimetype="text/csv",
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
            },
        )

    @app.route(
        "/login",
        methods=["GET", "POST"]
    )
    def login():

        if request.method == "GET":
            if require_auth():
                if is_campaigner_session():
                    return redirect("/campaign-manager")

                if is_campaign_admin_session():
                    return redirect("/campaign-manager")

                if current_role() == "campaigner":
                    return redirect("/campaign-manager")

                if is_pending_public_session():
                    return redirect("/self-register")

                if current_role() == "viewer":
                    return redirect("/directory")

                return redirect("/")

            return render_template(
                "login.html",
                mobile_login_enabled=is_mobile_login_enabled(
                    get_settings_collection().find_one({
                        "key": OTP_SETTINGS_KEY
                    }),
                    test_mode=app.config.get("OTP_TEST_MODE", False),
                ),
                whatsapp_login_enabled=is_whatsapp_login_enabled(
                    get_settings_collection().find_one({
                        "key": OTP_SETTINGS_KEY
                    }),
                    test_mode=app.config.get("OTP_TEST_MODE", False),
                ),
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
        mobile_number = normalize_public_mobile(
            payload.get("mobileNumber")
        )

        if not mobile_number:
            return jsonify({
                "error": "Mobile number required"
            }), 400

        # Server-side rate limiting: block back-to-back OTP requests for the
        # same number until the previous challenge's resend window elapses.
        otp_collection = get_public_otp_collection()
        existing_challenge = otp_collection.find_one({
            "mobileNumber": mobile_number
        })
        now = now_utc()
        if existing_challenge and not existing_challenge.get("verifiedAt"):
            resend_available_at = as_utc_datetime(
                existing_challenge.get("resendAvailableAt")
            )
            if resend_available_at and now < resend_available_at:
                retry_after = max(
                    1,
                    int((resend_available_at - now).total_seconds()) + 1,
                )
                return jsonify({
                    "error": (
                        "Please wait " + str(retry_after)
                        + " seconds before requesting another OTP."
                    ),
                    "retryAfterSeconds": retry_after,
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
        active_provider = (
            settings.get("activeProvider")
            or OTP_PROVIDER_TEST
        )

        if active_provider == OTP_PROVIDER_DISABLED:
            return jsonify({
                "error": "Mobile login is currently disabled."
            }), 403

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
            "resendAvailableInSeconds": OTP_RESEND_SECONDS,
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
        mobile_number = normalize_public_mobile(
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
            retry_after = max(
                1,
                int((resend_available_at - now).total_seconds()) + 1,
            )
            return jsonify({
                "error": (
                    "Please wait " + str(retry_after)
                    + " seconds before resending OTP."
                ),
                "retryAfterSeconds": retry_after,
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

        if settings.get("activeProvider") == OTP_PROVIDER_DISABLED:
            return jsonify({
                "error": "Mobile login is currently disabled."
            }), 403

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
            "ok": True,
            "resendAvailableInSeconds": OTP_RESEND_SECONDS,
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
        mobile_number = normalize_public_mobile(
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
        account = find_public_account_by_mobile(
            public_accounts,
            mobile_number,
        )

        if not account:
            account = {
                "mobileNumber": mobile_number,
                "accountType": read_default_account_type(
                    get_settings_collection()
                ),
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
            "redirectTo": get_redirect_for_account(account),
        })

    # =======================================================================
    # WhatsApp Login (QR + Pairing Code)
    # =======================================================================

    @app.post("/api/public/whatsapp-login/start")
    def start_whatsapp_login():
        """Start a WhatsApp login session. Returns a pairing code and session ID.
        The user links their WhatsApp to verify ownership of the phone number."""
        from . import whatsapp_web as wa

        # Check if WhatsApp login is enabled
        settings_collection = get_settings_collection()
        existing_settings = settings_collection.find_one({
            "key": OTP_SETTINGS_KEY
        })
        if not is_whatsapp_login_enabled(
            existing_settings,
            test_mode=app.config.get("OTP_TEST_MODE", False),
        ):
            return jsonify({
                "error": "WhatsApp login is not enabled."
            }), 403

        # Check if the sidecar service is available
        if not wa.is_service_available():
            return jsonify({
                "error": "WhatsApp service is temporarily unavailable."
            }), 503

        payload = request.get_json(silent=True) or {}
        mobile_number = normalize_public_mobile(
            payload.get("mobileNumber")
        )

        if not mobile_number:
            return jsonify({
                "error": "Mobile number required"
            }), 400

        # Generate a temporary login session ID
        import uuid
        login_session_id = uuid.uuid4().hex

        # Normalize phone: add country code if needed
        phone_clean = mobile_number
        if len(phone_clean) == 10 and phone_clean[0] in "6789":
            phone_clean = "91" + phone_clean

        # Use phone-based sidecar userId so backup data is tied to the phone
        sidecar_user_id = f"login_{phone_clean}"

        try:
            result = wa.connect_session(
                sidecar_user_id,
                phone_clean,
            )
        except Exception as e:
            return jsonify({
                "error": str(e) or "Could not connect to WhatsApp. Please try again."
            }), 500

        # Store the login session mapping in a temporary collection
        wa_login_collection = get_collection().database["wa_login_sessions"]
        now = now_utc()
        wa_login_collection.update_one(
            {"sessionId": login_session_id},
            {"$set": {
                "sessionId": login_session_id,
                "mobileNumber": mobile_number,
                "phoneWithCode": phone_clean,
                "sidecarUserId": sidecar_user_id,
                "pairingCode": result.get("pairingCode"),
                "status": result.get("status", "connecting"),
                "createdAt": now,
                "expiresAt": now + timedelta(minutes=5),
                "verifiedAt": None,
            }},
            upsert=True,
        )

        return jsonify({
            "ok": True,
            "sessionId": login_session_id,
            "pairingCode": result.get("pairingCode"),
            "status": result.get("status", "connecting"),
            "message": result.get("message", ""),
        })

    @app.post("/api/public/whatsapp-login/start-qr")
    def start_whatsapp_login_qr():
        """Start a WhatsApp QR-code login session."""
        from . import whatsapp_web as wa

        # Check if WhatsApp login is enabled
        settings_collection = get_settings_collection()
        existing_settings = settings_collection.find_one({
            "key": OTP_SETTINGS_KEY
        })
        if not is_whatsapp_login_enabled(
            existing_settings,
            test_mode=app.config.get("OTP_TEST_MODE", False),
        ):
            return jsonify({
                "error": "WhatsApp login is not enabled."
            }), 403

        if not wa.is_service_available():
            return jsonify({
                "error": "WhatsApp service is temporarily unavailable."
            }), 503

        payload = request.get_json(silent=True) or {}
        mobile_number = normalize_public_mobile(
            payload.get("mobileNumber")
        )

        if not mobile_number:
            return jsonify({
                "error": "Mobile number required"
            }), 400

        import uuid
        login_session_id = uuid.uuid4().hex

        phone_clean = mobile_number
        if len(phone_clean) == 10 and phone_clean[0] in "6789":
            phone_clean = "91" + phone_clean

        # Use phone-based sidecar userId so backup data is tied to the phone
        sidecar_user_id = f"login_{phone_clean}"

        try:
            import requests as http_requests
            resp = http_requests.post(
                wa._url("/api/session/connect-qr"),
                headers=wa._headers(),
                json={"userId": sidecar_user_id},
                timeout=30,
            )
            resp.raise_for_status()
            result = resp.json()
        except Exception as e:
            return jsonify({
                "error": f"Failed to start WhatsApp QR session: {str(e)}"
            }), 500

        # Store the login session
        wa_login_collection = get_collection().database["wa_login_sessions"]
        now = now_utc()
        wa_login_collection.update_one(
            {"sessionId": login_session_id},
            {"$set": {
                "sessionId": login_session_id,
                "mobileNumber": mobile_number,
                "phoneWithCode": phone_clean,
                "sidecarUserId": sidecar_user_id,
                "pairingCode": None,
                "qr": result.get("qr"),
                "status": result.get("status", "waiting_qr"),
                "createdAt": now,
                "expiresAt": now + timedelta(minutes=5),
                "verifiedAt": None,
            }},
            upsert=True,
        )

        return jsonify({
            "ok": True,
            "sessionId": login_session_id,
            "qr": result.get("qr"),
            "status": result.get("status", "waiting_qr"),
            "message": result.get("message", ""),
        })

    @app.get("/api/public/whatsapp-login/status/<session_id>")
    def whatsapp_login_status(session_id):
        """Poll the status of a WhatsApp login session.
        When status is 'connected', the login is verified.
        Also reports backup progress so the frontend knows when disconnect is safe."""
        from . import whatsapp_web as wa

        wa_login_collection = get_collection().database["wa_login_sessions"]
        login_session = wa_login_collection.find_one({
            "sessionId": session_id
        })

        if not login_session:
            return jsonify({
                "error": "Session not found"
            }), 404

        sidecar_user_id = login_session.get(
            "sidecarUserId",
            f"login_{session_id}",
        )

        # Check expiry (only before verification)
        now = now_utc()
        if not login_session.get("verifiedAt"):
            expires_at = as_utc_datetime(
                login_session.get("expiresAt")
            )
            if expires_at and now > expires_at:
                return jsonify({
                    "status": "expired",
                    "error": "Session expired"
                }), 400

        # If already verified, report status (no sidecar call needed)
        if login_session.get("verifiedAt"):
            return jsonify({
                "status": "verified",
                "ok": True,
            })

        # Check the sidecar for the real-time status
        try:
            result = wa.get_session_status(sidecar_user_id)
            current_status = result.get("status", "connecting")
        except Exception:
            current_status = login_session.get("status", "connecting")

        # Also poll for QR updates if QR mode
        qr = None
        if current_status == "waiting_qr":
            try:
                import requests as http_requests
                resp = http_requests.get(
                    wa._url(f"/api/session/qr/{sidecar_user_id}"),
                    headers=wa._headers(),
                    timeout=10,
                )
                if resp.ok:
                    qr = resp.json().get("qr")
            except Exception:
                pass

        # If connected, user is verified — complete the login
        if current_status == "connected":
            mobile_number = login_session.get("mobileNumber")
            wa_login_collection.update_one(
                {"sessionId": session_id},
                {"$set": {
                    "status": "connected",
                    "verifiedAt": now,
                }}
            )

            # Create or update public account (same as OTP verify)
            public_accounts = get_public_accounts_collection()
            account = find_public_account_by_mobile(
                public_accounts,
                mobile_number,
            )

            if not account:
                account = {
                    "mobileNumber": mobile_number,
                    "accountType": read_default_account_type(
                        get_settings_collection()
                    ),
                    "status": "pending",
                    "approvedRegistrationId": "",
                    "latestSubmissionId": "",
                    "latestVersion": 0,
                    "createdAt": now,
                    "updatedAt": now,
                    "lastWhatsAppVerifiedAt": now,
                }
                result_insert = public_accounts.insert_one(account)
                account["_id"] = result_insert.inserted_id
            else:
                public_accounts.update_one(
                    {"_id": account["_id"]},
                    {"$set": {
                        "updatedAt": now,
                        "lastWhatsAppVerifiedAt": now,
                    }}
                )
                account["updatedAt"] = now
                account["lastWhatsAppVerifiedAt"] = now

            build_public_session(account)

            # Store the sidecar userId in the Flask session so status checks work
            session["wa_sidecar_user_id"] = sidecar_user_id

            return jsonify({
                "status": "verified",
                "ok": True,
                "role": current_role(),
                "account": serialize_public_account(account),
                "redirectTo": get_redirect_for_account(account),
            })

        # Update stored status
        wa_login_collection.update_one(
            {"sessionId": session_id},
            {"$set": {"status": current_status}}
        )

        response_data = {
            "status": current_status,
            "ok": False,
        }
        if qr:
            response_data["qr"] = qr

        return jsonify(response_data)

    @app.post("/api/public/whatsapp-login/disconnect/<session_id>")
    def whatsapp_login_disconnect(session_id):
        """Disconnect the WhatsApp login session after backup is done."""
        from . import whatsapp_web as wa

        wa_login_collection = get_collection().database["wa_login_sessions"]
        login_session = wa_login_collection.find_one({
            "sessionId": session_id
        })

        if not login_session:
            return jsonify({"error": "Session not found"}), 404

        sidecar_user_id = login_session.get(
            "sidecarUserId",
            f"login_{session_id}",
        )

        # Check if backup is still running
        if wa.is_backup_running(sidecar_user_id):
            return jsonify({
                "error": "Backup still in progress",
                "backupRunning": True,
            }), 409

        # Safe to disconnect
        try:
            wa.disconnect_session(sidecar_user_id)
        except Exception:
            pass

        wa_login_collection.update_one(
            {"sessionId": session_id},
            {"$set": {"status": "disconnected"}}
        )

        return jsonify({"ok": True, "status": "disconnected"})

    @app.get("/api/otp-settings")
    def get_otp_settings():

        if not role_can("manage_otp_settings"):
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

        if not role_can("manage_otp_settings"):
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

        if not role_can("manage_users"):
            return jsonify({
                "error": "Forbidden"
            }), 403

        filters = {}

        role = current_role()
        if role == "super_admin":
            pass  # sees all users
        elif role == "campaign_admin":
            # campaign_admin can only manage campaigner users
            filters["role"] = {"$in": get_assignable_roles(role)}
        else:
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

        if not role_can("manage_users"):
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

        # Check for existing username
        existing = users_collection.find_one({
            "username": username
        })

        if existing:
            return jsonify({
                "error": "Username already exists"
            }), 400

        # Hash the password
        password_hash = (
            bcrypt.hashpw(
                password.encode(),
                bcrypt.gensalt(),
            )
            .decode()
        )

        document = {
            "username": username,
            "passwordHash": password_hash,
            "role": role,
            "createdAt": datetime.utcnow(),
            "createdBy": session.get("username", ""),
        }

        result = users_collection.insert_one(document)

        document["_id"] = result.inserted_id
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
    @app.put("/api/users/<username>/password")
    def change_user_password(username):

        if not role_can("manage_users"):
            return jsonify({"error": "Forbidden"}), 403

        target_username = username.strip()
        if not target_username:
            return jsonify({"error": "Username required"}), 400

        payload = request.get_json(silent=True) or {}
        new_password = payload.get("password", "")

        if len(new_password) < 6:
            return jsonify({
                "error": "Password must be at least 6 characters"
            }), 400

        users_collection = get_users_collection()
        user = users_collection.find_one({"username": target_username})

        if not user:
            return jsonify({"error": "User not found"}), 404

        # Only allow changing password for roles the caller can manage
        allowed_roles = get_assignable_roles(current_role())
        if user.get("role") not in allowed_roles:
            return jsonify({"error": "Forbidden"}), 403

        password_hash = (
            bcrypt.hashpw(new_password.encode(), bcrypt.gensalt()).decode()
        )

        users_collection.update_one(
            {"username": target_username},
            {"$set": {
                "passwordHash": password_hash,
                "passwordChangedAt": now_utc(),
                "passwordChangedBy": session.get("username", ""),
            }},
        )

        return jsonify({"ok": True})

    @app.delete("/api/users/<username>")
    def delete_user(username):

        if not role_can("manage_users"):
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

        # Registrant-only endpoint: campaigner sessions are denied
        # (Requirements 1.7, 11.3).
        if is_campaigner_session():
            return jsonify({
                "error": "Campaigners cannot access self-registrations."
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

        # Self-registration submission is a registrant-only endpoint. A
        # campaigner session must not be able to submit registrations
        # (Requirements 1.7, 11.3).
        if is_campaigner_session():
            return jsonify({
                "error": "Campaigners cannot submit self-registrations."
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
            max_family_members=get_role_limit("maxFamilyMembers"),
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

        if not role_can("review_self_registrations"):
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

        if not role_can("review_self_registrations"):
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

        if not role_can("review_self_registrations"):
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
                "invitationName": serialized.get("invitationName", ""),
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
                max_family_members=get_role_limit("maxFamilyMembers"),
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

        # Preserve invitationName if not explicitly provided in payload
        if not payload.get("invitationName"):
            document["invitationName"] = (
                existing_document.get("invitationName", "")
            )

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

    @app.put("/api/registrations/<id>/invitation-name")
    def update_invitation_name(id):
        if not role_can("update_invitation_name"):
            return jsonify({
                "error": "Forbidden"
            }), 403

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

        payload = (
            request.get_json(
                silent=True
            ) or {}
        )

        invitation_name = (
            payload.get("invitationName", "")
            .strip()
        )

        get_collection().update_one(
            {
                "_id": document_id
            },
            {
                "$set": {
                    "invitationName": invitation_name,
                    "updatedAt": datetime.now(
                        timezone.utc
                    ),
                    "updatedBy": session.get(
                        "username",
                        ""
                    ),
                }
            }
        )

        return jsonify({
            "ok": True,
            "invitationName": invitation_name,
        })

    @app.delete("/api/registrations/<id>")
    def delete_registration(id):

        if not role_can("delete_registrations"):
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

        if not role_can("delete_registrations"):
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
        if not role_can("create_registrations"):
            return jsonify({
                "error": "Forbidden"
            }), 403

        payload = request.get_json(silent=True) or {}

        correction_store = get_correction_collection()
        corrections = load_corrections(correction_store)
        result = validate_registration(
            payload,
            corrections,
            max_family_members=get_role_limit("maxFamilyMembers"),
        )

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
        if not role_can("create_registrations"):
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
                    "familyMembers.currentCity",
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

            if not role_can("delete_registrations"):
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

    # ---- Campaign Manager API routes ----

    @app.get("/api/campaigns/audience-preview")
    @require_campaigner
    def campaign_audience_preview():
        """Return HOF recipients matching cascading area filters for Step 1 of
        the campaign wizard. Accepts comma-separated district, taluka,
        surnameGroup, and area query params; area is applied as a post-query
        filter inside get_hof_by_area (Requirements 3.1, 3.5, 3.6, 3.7)."""

        def parse_csv_param(*names):
            for name in names:
                raw = request.args.get(name)
                if raw:
                    values = [part.strip() for part in raw.split(",")]
                    values = [value for value in values if value]
                    if values:
                        return values
            return None

        filters = {
            "districts": parse_csv_param("district", "districts"),
            "talukas": parse_csv_param("taluka", "talukas"),
            "surnameGroups": parse_csv_param("surnameGroup", "surnameGroups"),
            "areas": parse_csv_param("area", "areas"),
        }

        recipients = get_hof_by_area(filters, get_collection())

        # Privacy hardening: never send full mobile numbers to the browser.
        # The wizard selects recipients by registrationId and the server
        # re-resolves the full numbers at campaign-creation time. Only a masked
        # number (last 4 digits) is exposed for display.
        safe_recipients = [
            {
                "_id": recipient.get("_id", ""),
                "registrationId": recipient.get("_id", ""),
                "name": recipient.get("name", ""),
                "mobileMasked": campaign.mask_mobile(
                    recipient.get("mobileNumber", "")
                ),
                "district": recipient.get("district", ""),
                "taluka": recipient.get("taluka", ""),
                "surnameGroup": recipient.get("surnameGroup", ""),
                "area": recipient.get("area", ""),
                "membersCount": recipient.get("membersCount", 1),
            }
            for recipient in recipients
        ]

        return jsonify({
            "recipients": safe_recipients,
            "count": len(safe_recipients),
        })

    @app.get("/api/campaigns/areas")
    @require_campaigner
    def campaign_areas():
        """Return available area names with family counts for the Area filter
        dropdown in Step 1 of the campaign wizard. Accepts comma-separated
        district and taluka query params (singular or plural names); areas are
        computed on-the-fly via classify_area inside get_areas_with_counts
        (Requirements 3.3, 3.4)."""

        def parse_csv_param(*names):
            for name in names:
                raw = request.args.get(name)
                if raw:
                    values = [part.strip() for part in raw.split(",")]
                    values = [value for value in values if value]
                    if values:
                        return values
            return None

        filters = {
            "districts": parse_csv_param("district", "districts"),
            "talukas": parse_csv_param("taluka", "talukas"),
        }

        areas = get_areas_with_counts(filters, get_collection())

        return jsonify({
            "areas": areas,
        })

    @app.get("/api/campaigns/surname-groups")
    @require_campaigner
    def campaign_surname_groups():
        """Return distinct surname group values for the Surname Group filter
        dropdown in Step 1 of the campaign wizard. Accepts comma-separated
        district and taluka query params (singular or plural names); values are
        title-cased and sorted inside get_distinct_surname_groups
        (Requirement 3.1)."""

        def parse_csv_param(*names):
            for name in names:
                raw = request.args.get(name)
                if raw:
                    values = [part.strip() for part in raw.split(",")]
                    values = [value for value in values if value]
                    if values:
                        return values
            return None

        filters = {
            "districts": parse_csv_param("district", "districts"),
            "talukas": parse_csv_param("taluka", "talukas"),
        }

        surname_groups = get_distinct_surname_groups(filters, get_collection())

        return jsonify({
            "surnameGroups": surname_groups,
        })

    @app.get("/api/campaigns/templates")
    @require_campaigner
    def campaign_templates():
        """Return the list of available WhatsApp ad templates for Step 2 of the
        campaign wizard. Each template exposes its name, language, and a body
        text preview with placeholder indicators like {name}
        (Requirements 4.1, 4.2)."""

        return jsonify({
            "templates": get_ad_templates(),
        })

    @app.post("/api/campaigns/reveal-contact")
    @require_campaigner
    def campaign_reveal_contact():
        """Reveal the full (unmasked) mobile number for a single registration.

        The campaigner may view up to 10 full contact numbers at a time. The
        server tracks which registration ids are currently revealed in the
        session. When a new reveal would exceed the limit of 10, the oldest
        revealed id is evicted (its number would need re-revealing).

        Privacy: the full number is returned one at a time so the client never
        holds a bulk contact list. The session-based window cap of 10 ensures
        minimal exposure at any point.

        Request JSON: {"registrationId": "<id>"}
        Response JSON: {"mobile": "<full number>", "registrationId": "<id>",
                        "evictedId": "<id or null>"}
        """
        MAX_REVEALED = 10

        payload = request.get_json(silent=True) or {}
        registration_id = str(payload.get("registrationId") or "").strip()

        if not registration_id:
            return jsonify({"error": "registrationId is required."}), 400

        # Session-based sliding window of revealed ids (list, oldest first).
        revealed = session.get("revealed_contacts") or []
        if not isinstance(revealed, list):
            revealed = []

        # If already revealed, move to end (refresh) and return the number.
        evicted_id = None
        if registration_id not in revealed:
            if len(revealed) >= MAX_REVEALED:
                evicted_id = revealed.pop(0)
            revealed.append(registration_id)
        else:
            # Move to end to keep it "fresh"
            revealed.remove(registration_id)
            revealed.append(registration_id)

        session["revealed_contacts"] = revealed

        # Resolve the full mobile from the registrations collection.
        try:
            doc_id = ObjectId(registration_id)
        except Exception:
            doc_id = registration_id

        doc = get_collection().find_one({"_id": doc_id})
        if not doc:
            return jsonify({"error": "Registration not found."}), 404

        full_mobile = doc.get("mobileNumber") or ""

        return jsonify({
            "mobile": full_mobile,
            "registrationId": registration_id,
            "evictedId": evicted_id,
        })

    @app.post("/api/campaigns/create-with-payment")
    @require_campaigner
    def create_campaign_with_payment_route():
        """Create a campaign and generate its UPI payment link for Step 3 of
        the campaign wizard.

        Parses the selected recipient registration ids, template selection,
        body variable template, and the audience filters used during selection
        from the JSON body, then delegates to
        campaign.create_campaign_with_upi() using the authenticated
        campaigner's account id from the session.

        Privacy hardening: the browser sends only registration ids
        ("registrationIds"). The full mobile numbers are re-resolved here,
        server-side, from the registrations collection so they never need to
        leave the server. A legacy "recipients" array is still accepted (ids
        are extracted from it) for backward compatibility.

        On success returns {campaignId, upiLink, amount, transactionNote}.
        An empty recipients list yields a 400. A configuration failure
        (no UPI_ID) yields a 503.
        """
        payload = request.get_json(silent=True) or {}

        registration_ids = payload.get("registrationIds")
        if not registration_ids:
            # Backward compatibility: derive ids from a legacy recipients array.
            legacy_recipients = payload.get("recipients") or []
            registration_ids = [
                (item.get("registrationId") or item.get("_id"))
                for item in legacy_recipients
                if isinstance(item, dict)
                and (item.get("registrationId") or item.get("_id"))
            ]

        template_name = payload.get("templateName")
        template_language = payload.get("templateLanguage")
        body_vars_template = payload.get("bodyVarsTemplate") or []
        audience_filters = payload.get("audienceFilters") or {}

        # Per-family salutation toggle answers (registrationId -> "shri-sau" /
        # "sah-parivaar"), resolved into the {salutation} template variable at
        # send time.
        salutations = payload.get("salutations")
        if not isinstance(salutations, dict):
            salutations = {}

        # Re-resolve full recipient records (incl. mobile numbers) server-side
        # from the selected registration ids.
        recipients = campaign.resolve_recipients_by_ids(
            registration_ids, get_collection(), salutations=salutations
        )

        account_id = session.get("public_account_id", "") or session.get("user_id", "")

        # --- Check if user wants to send via WhatsApp Web (free, no payment) ---
        send_via_web = payload.get("sendViaWeb", False)
        if send_via_web:
            from . import whatsapp_web as wa_web
            # Use sidecar userId if available (from WhatsApp login), else fall back to account_id
            wa_user_id = session.get("wa_sidecar_user_id") or str(account_id)
            try:
                # Check if session is connected
                status = wa_web.get_session_status(wa_user_id)
                if status.get("status") != "connected":
                    return jsonify({
                        "error": "WhatsApp Web is not connected. Connect first or use Cloud API."
                    }), 400

                # Get template body text for variable substitution
                template_body = payload.get("templateBody") or ""
                if not template_body and template_name:
                    # Look up body from AD_TEMPLATES or custom templates
                    for t in campaign.get_ad_templates():
                        if t["name"] == template_name:
                            template_body = t.get("bodyText", "")
                            break
                    # Also check custom templates in DB
                    if not template_body:
                        custom_t = get_collection().database["wa_custom_templates"].find_one(
                            {"name": template_name, "status": "approved"}
                        )
                        if custom_t:
                            template_body = custom_t.get("bodyText", "")

                # Media attachment (optional)
                media_url = payload.get("mediaUrl") or ""
                media_type = payload.get("mediaType") or ""  # image, video, document

                # Send messages via web session (no payment required)
                # First check daily limit
                try:
                    daily_stats = wa_web.get_daily_send_stats(wa_user_id)
                    remaining = daily_stats.get("remaining", 20)
                    if len(recipients) > remaining:
                        return jsonify({
                            "error": f"Daily limit: you can send {remaining} more messages today "
                                     f"(requested {len(recipients)}). Either reduce recipients or "
                                     f"use Cloud API for the full batch.",
                            "dailyRemaining": remaining,
                            "requested": len(recipients),
                        }), 400
                except Exception:
                    pass  # If we can't check, proceed anyway

                sent = 0
                failed = 0
                errors = []
                for recipient in recipients:
                    phone = recipient.get("mobileNumber", "").replace("+", "")
                    if not phone:
                        failed += 1
                        continue

                    # Resolve the full message body with substituted variables
                    message_text = template_body
                    if message_text:
                        name = recipient.get("name", "")
                        salutation = campaign.salutation_text(
                            recipient.get("salutation")
                        )
                        mobile = campaign.normalize_wa_number(
                            recipient.get("mobileNumber", "")
                        ) or ""
                        message_text = message_text.replace("{name}", name)
                        message_text = message_text.replace("{salutation}", salutation)
                        message_text = message_text.replace("{mobile}", mobile)
                    else:
                        # Fallback: join resolved vars
                        body_vars = campaign.resolve_body_vars(
                            body_vars_template, recipient
                        )
                        message_text = " ".join(str(v) for v in body_vars if v)

                    if not message_text:
                        message_text = f"Hello {recipient.get('name', '')}"

                    try:
                        # Send with or without media
                        if media_url and media_type:
                            result = wa_web.send_media_message(
                                wa_user_id, phone, message_text,
                                media_url, media_type
                            )
                        else:
                            result = wa_web.send_personal_message(
                                wa_user_id, phone, message_text
                            )

                        if result.get("fallbackToCloudAPI"):
                            errors.append(f"{phone}: Daily limit reached")
                            failed += 1
                        else:
                            sent += 1
                    except Exception as send_err:
                        errors.append(f"{phone}: {str(send_err)[:100]}")
                        failed += 1

                    # Small delay between messages to avoid detection
                    import time
                    time.sleep(3)

                # Save campaign record for "My Campaigns" history
                from datetime import datetime, timezone as tz
                from bson import ObjectId as OId
                now = datetime.now(tz.utc)
                try:
                    account_oid = OId(str(account_id))
                except Exception:
                    account_oid = account_id

                campaign_id = OId()
                web_campaign = {
                    "_id": campaign_id,
                    "name": f"WhatsApp Web Campaign {now.strftime('%d %b %Y %H:%M')}",
                    "accountId": account_oid,
                    "templateName": template_name or "custom",
                    "templateLanguage": payload.get("templateLanguage", ""),
                    "recipientCount": len(recipients),
                    "status": "sent",
                    "channel": "web",
                    "stats": {
                        "totalRecipients": len(recipients),
                        "sent": sent,
                        "failed": failed,
                        "pending": 0,
                    },
                    "createdAt": now,
                    "updatedAt": now,
                    "sentAt": now,
                }
                get_collection().database["campaigns"].insert_one(web_campaign)

                # Save individual message records for the delivery report
                msg_records = []
                sent_idx = 0
                failed_idx = 0
                for recipient in recipients:
                    phone = recipient.get("mobileNumber", "").replace("+", "")
                    name = recipient.get("name", "")
                    # Determine if this recipient was sent or failed
                    # (We track them in order — first N are sent, rest failed)
                    msg_status = "sent" if sent_idx < sent else "failed"
                    if msg_status == "sent":
                        sent_idx += 1
                    else:
                        failed_idx += 1

                    msg_records.append({
                        "campaignId": campaign_id,
                        "recipientName": name,
                        "recipientMobile": phone,
                        "status": msg_status,
                        "channel": "web",
                        "sentAt": now if msg_status == "sent" else None,
                        "error": None,
                    })

                if msg_records:
                    get_collection().database["campaign_messages"].insert_many(msg_records)

                return jsonify({
                    "success": True,
                    "channel": "web",
                    "sent": sent,
                    "failed": failed,
                    "total": len(recipients),
                    "errors": errors[:10],
                    "campaignId": str(web_campaign["_id"]),
                    "message": f"Sent {sent}/{len(recipients)} messages via WhatsApp Web (free)"
                })
            except Exception as exc:
                return jsonify({"error": f"Web send failed: {str(exc)}"}), 500

        # --- Standard Cloud API flow (with payment) ---

        # Clear, actionable error when UPI ID is not configured.
        if not campaign.upi_is_configured():
            current_app.logger.error(
                "UPI_ID is not configured for campaign payments."
            )
            return jsonify({
                "error": (
                    "Payments are not configured on the server. Please set the "
                    "UPI_ID in the environment and try again."
                )
            }), 503

        try:
            result = campaign.create_campaign_with_upi(
                account_id=account_id,
                recipients=recipients,
                template_name=template_name,
                template_language=template_language,
                body_vars_template=body_vars_template,
                audience_filters=audience_filters,
            )
        except ValueError as exc:
            # Validation failure, e.g. empty recipients list.
            return jsonify({"error": str(exc)}), 400
        except Exception:
            current_app.logger.exception(
                "create_campaign_with_upi failed for account %s", account_id
            )
            return jsonify({
                "error": "Unable to create campaign. Please try again."
            }), 500

        return jsonify(result)

    @app.get("/api/campaigns")
    @require_campaigner
    def list_campaigns():
        """Return all campaigns belonging to the authenticated campaigner.

        Campaigns are filtered by accountId matching the campaigner's
        public_account_id stored in the session. accountId is persisted as an
        ObjectId, so the session id is coerced via ensure_object_id
        (Requirement 8.4).

        Campaign admin staff see all campaigns across all accounts."""

        # Campaign admins see all campaigns for oversight.
        if is_campaign_admin_session():
            campaigns = list(
                get_campaigns_collection()
                .find({})
                .sort("createdAt", -1)
                .limit(200)
            )
        else:
            account_object_id = ensure_object_id(
                session.get("public_account_id", "")
            )

            campaigns = list(
                get_campaigns_collection()
                .find({"accountId": account_object_id})
                .sort("createdAt", -1)
            )

        return jsonify({
            "campaigns": [serialize_document(campaign) for campaign in campaigns],
        })

    @app.get("/api/campaigns/<campaign_id>")
    @require_campaigner
    def get_campaign(campaign_id):
        """Return a single campaign's details (status, stats, recipients) for the
        authenticated campaigner. Responds 404 if the campaign does not exist or
        does not belong to the current campaigner (Requirement 8.4).

        Campaign admin staff can view any campaign."""

        campaign_object_id = object_id_or_none(campaign_id)
        if campaign_object_id is None:
            return jsonify({"error": "Campaign not found."}), 404

        # Campaign admins can view any campaign.
        if is_campaign_admin_session():
            campaign = get_campaigns_collection().find_one({
                "_id": campaign_object_id,
            })
        else:
            account_object_id = ensure_object_id(
                session.get("public_account_id", "")
            )

            campaign = get_campaigns_collection().find_one({
                "_id": campaign_object_id,
                "accountId": account_object_id,
            })

        if campaign is None:
            return jsonify({"error": "Campaign not found."}), 404

        return jsonify({
            "campaign": serialize_document(campaign),
        })

    @app.post("/api/campaigns/<campaign_id>/submit-upi-ref")
    @require_campaigner
    def submit_upi_ref(campaign_id):
        """Record the UPI transaction reference submitted by the campaigner.

        After paying via UPI, the user enters their UTR / UPI reference
        number. This stores it on the payment record. The campaign stays
        in pending_payment until an admin confirms.
        """

        account_object_id = ensure_object_id(
            session.get("public_account_id", "") or session.get("user_id", "")
        )

        campaign_object_id = object_id_or_none(campaign_id)
        if campaign_object_id is None:
            return jsonify({"error": "Campaign not found."}), 404

        campaigns = get_campaigns_collection()
        camp = campaigns.find_one({
            "_id": campaign_object_id,
            "accountId": account_object_id,
        })

        if camp is None:
            return jsonify({"error": "Campaign not found."}), 404

        payload = request.get_json(silent=True) or {}
        upi_ref = (payload.get("upiTransactionRef") or "").strip()

        result = campaign.submit_upi_reference(campaign_id, upi_ref)

        if not result.get("ok"):
            return jsonify({"error": result.get("error")}), 400

        return jsonify({"ok": True, "message": "UPI reference submitted. Awaiting admin confirmation."})

    @app.get("/api/campaigns/pending-payments")
    def pending_payments():
        """Return campaigns with pending UPI payments awaiting admin confirmation.

        Restricted to staff with the confirm_campaign_payments capability.
        """
        if not is_staff_session() or not role_can("confirm_campaign_payments"):
            return jsonify({"error": "Access denied."}), 403

        payments = get_campaign_payments_collection()
        pending = list(payments.find({"status": "submitted"}).sort("updatedAt", -1))

        # Enrich with campaign name for display.
        campaigns_col = get_campaigns_collection()
        results = []
        for p in pending:
            camp = campaigns_col.find_one({"_id": p.get("campaignId")})
            results.append({
                "campaignId": str(p.get("campaignId")),
                "campaignName": camp.get("name") if camp else "Unknown",
                "amount": p.get("amountRupees", p.get("amount", 0)),
                "transactionNote": p.get("transactionNote", ""),
                "upiTransactionRef": p.get("upiTransactionRef", ""),
                "recipientCount": p.get("recipientCount", 0),
                "createdAt": str(p.get("createdAt", "")),
            })

        return jsonify({"payments": results})

    @app.post("/api/campaigns/<campaign_id>/confirm-payment")
    def confirm_payment(campaign_id):
        """Admin endpoint: confirm a UPI payment and trigger campaign sending.

        Restricted to staff with the confirm_campaign_payments capability.
        """
        if not is_staff_session() or not role_can("confirm_campaign_payments"):
            return jsonify({"error": "Access denied."}), 403

        result = campaign.confirm_upi_payment(campaign_id)

        if not result.get("ok"):
            return jsonify({"error": result.get("error")}), 400

        return jsonify({"ok": True, "reason": result.get("reason")})

    @app.post("/api/campaigns/<campaign_id>/reject-payment")
    def reject_payment(campaign_id):
        """Admin endpoint: reject a UPI payment with a reason.

        Restricted to staff with the confirm_campaign_payments capability.
        Marks the campaign as rejected so messages are never sent.
        """
        if not is_staff_session() or not role_can("confirm_campaign_payments"):
            return jsonify({"error": "Access denied."}), 403

        payload = request.get_json(silent=True) or {}
        reason = (payload.get("reason") or "").strip()

        result = campaign.reject_upi_payment(campaign_id, reason)

        if not result.get("ok"):
            return jsonify({"error": result.get("error")}), 400

        return jsonify({"ok": True, "reason": result.get("reason")})

    @app.get("/api/campaigns/<campaign_id>/report")
    @require_campaigner
    def campaign_report(campaign_id):
        """Return the delivery report for a campaign (Step 5 of the wizard).

        Aggregates the campaign_message records into summary statistics
        (total, sent, failed, pending) and a per-recipient status list with
        masked mobile numbers (last 4 digits only) and UTC delivery-attempt
        timestamps.

        The campaign must belong to the authenticated campaigner: the lookup is
        scoped by accountId so a campaigner can never view another campaigner's
        report. Campaign admin staff can view any campaign's report.

        Responds 404 if the campaign does not exist or is not owned by
        the current campaigner (Requirements 8.1, 8.2, 8.4).
        """

        campaign_object_id = object_id_or_none(campaign_id)
        if campaign_object_id is None:
            return jsonify({"error": "Campaign not found."}), 404

        # Campaign admins can view any campaign's report.
        if is_campaign_admin_session():
            campaign_doc = get_campaigns_collection().find_one({
                "_id": campaign_object_id,
            })
        else:
            account_object_id = ensure_object_id(
                session.get("public_account_id", "")
            )

            campaign_doc = get_campaigns_collection().find_one({
                "_id": campaign_object_id,
                "accountId": account_object_id,
            })

        if campaign_doc is None:
            return jsonify({"error": "Campaign not found."}), 404

        report = campaign.build_campaign_report(
            campaign_doc, campaign.get_campaign_messages_collection()
        )

        return jsonify({
            "campaignId": str(campaign_object_id),
            "status": campaign_doc.get("status"),
            "stats": report["stats"],
            "recipients": report["recipients"],
        })

    # --- True Name lookup via UPI VPA ---

    def _tn_lookup_cached(mobile):
        """Lookup with cache: returns (name, error, from_cache)."""
        cache = get_tn_cache_collection()
        cached = cache.find_one({"mobile": mobile})
        if cached and cached.get("name"):
            return cached["name"], None, True

        name, err = resolve_true_name(mobile)

        if name:
            cache.update_one(
                {"mobile": mobile},
                {"$set": {
                    "mobile": mobile,
                    "name": name,
                    "resolvedAt": now_utc(),
                    "resolvedBy": session.get("username", ""),
                }},
                upsert=True,
            )
        return name, err, False

    @app.get("/api/tn/lookup")
    def tn_lookup():
        """Resolve the verified account name for a mobile number via UPI VPA.

        Query param: mobile (10-digit Indian mobile number)
        Returns: {"name": "...", "mobile": "...", "cached": bool} or error.
        """
        if not require_auth():
            return jsonify({"error": "Unauthorized"}), 401

        if not role_can("manage_role_config"):
            return jsonify({"error": "Forbidden"}), 403

        mobile = request.args.get("mobile", "").strip()

        # Basic validation: 10-digit Indian mobile
        if not re.fullmatch(r"[6-9]\d{9}", mobile):
            return jsonify({"error": "Invalid mobile number. Must be 10 digits starting with 6-9."}), 400

        name, err, from_cache = _tn_lookup_cached(mobile)

        if err:
            return jsonify({"error": err, "name": None, "cached": False}), 502

        return jsonify({"name": name, "mobile": mobile, "cached": from_cache})

    @app.post("/api/tn/batch-lookup")
    def tn_batch_lookup():
        """Batch resolve verified account names for multiple mobile numbers.

        Body JSON: {"mobiles": ["9876543210", "9123456789", ...]}
        Returns: {"results": [{"mobile": "...", "name": "..." or null, "error": "..." or null, "cached": bool}, ...]}
        Max 20 numbers per request to avoid abuse.
        """
        if not require_auth():
            return jsonify({"error": "Unauthorized"}), 401

        if not role_can("manage_role_config"):
            return jsonify({"error": "Forbidden"}), 403

        payload = request.get_json(silent=True) or {}
        mobiles = payload.get("mobiles", [])

        if not isinstance(mobiles, list):
            return jsonify({"error": "mobiles must be a list"}), 400

        if len(mobiles) > 50:
            return jsonify({"error": "Maximum 50 numbers per batch request"}), 400

        # Validate and split into cached vs uncached
        valid_mobiles = []
        results = []
        for mobile in mobiles:
            mobile = str(mobile).strip()
            if not re.fullmatch(r"[6-9]\d{9}", mobile):
                results.append({"mobile": mobile, "name": None, "error": "invalid_format", "cached": False})
                continue
            valid_mobiles.append(mobile)

        # Serve cached ones immediately, collect uncached for parallel resolution
        cache = get_tn_cache_collection()
        cached_docs = {
            doc["mobile"]: doc["name"]
            for doc in cache.find({"mobile": {"$in": valid_mobiles}}, {"mobile": 1, "name": 1, "_id": 0})
            if doc.get("name")
        }

        need_lookup = []
        for mobile in valid_mobiles:
            if mobile in cached_docs:
                results.append({"mobile": mobile, "name": cached_docs[mobile], "error": None, "cached": True})
            else:
                need_lookup.append(mobile)

        # Resolve uncached numbers in parallel (one pipeline token, many VPA calls)
        if need_lookup:
            batch_results = resolve_batch(need_lookup)
            # Persist resolved names to cache in bulk
            updates = [
                UpdateOne(
                    {"mobile": r["mobile"]},
                    {"$set": {
                        "mobile": r["mobile"],
                        "name": r["name"],
                        "resolvedAt": now_utc(),
                        "resolvedBy": session.get("username", ""),
                    }},
                    upsert=True,
                )
                for r in batch_results if r["name"]
            ]
            if updates:
                cache.bulk_write(updates, ordered=False)

            for r in batch_results:
                results.append({"mobile": r["mobile"], "name": r["name"], "error": r["error"], "cached": False})

        return jsonify({"results": results})

    @app.get("/api/tn/cache")
    def tn_cache_list():
        """Return all cached TN results so the UI can display them without extra lookups."""
        if not require_auth():
            return jsonify({"error": "Unauthorized"}), 401

        if not role_can("manage_role_config"):
            return jsonify({"error": "Forbidden"}), 403

        # Return a phone->name map for fast client-side lookup
        cache = get_tn_cache_collection()
        docs = cache.find({}, {"mobile": 1, "name": 1, "_id": 0})
        mapping = {doc["mobile"]: doc["name"] for doc in docs if doc.get("name")}
        return jsonify({"cache": mapping})

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

    def get_campaigns_collection():
        database = (
            get_collection()
            .database
        )

        return database["campaigns"]

    def get_campaign_payments_collection():
        database = (
            get_collection()
            .database
        )

        return database["campaign_payments"]

    def get_tn_cache_collection():
        database = (
            get_collection()
            .database
        )

        return database["tn_cache"]

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
    app.get_campaigns_collection = get_campaigns_collection
    app.get_campaign_payments_collection = get_campaign_payments_collection
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
    serialized["invitationName"] = (
        serialized.get("invitationName")
        or ""
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


def _bilingual_en(value):
    if isinstance(value, dict):
        return value.get("en", "") or ""
    return str(value or "")


def _bilingual_mr(value):
    if isinstance(value, dict):
        return value.get("mr", "") or ""
    return ""


def _applicant_full_name(document, language="en"):
    parts = [
        _bilingual_en(document.get(field)) if language == "en"
        else _bilingual_mr(document.get(field))
        for field in ("firstName", "middleName", "lastName")
    ]
    return " ".join(part for part in parts if part).strip()


def _format_relationship_type(rel_type):
    return str(rel_type or "").replace("_", " ").strip()


def _build_person_name_map(document):
    """Map personId -> display name for resolving relationship links."""
    name_map = {}

    applicant_name = _applicant_full_name(document, "en")
    for applicant_key in ("applicant", document.get("primaryHouseholdId")):
        if applicant_key:
            name_map[str(applicant_key)] = applicant_name or "Applicant"

    for member in document.get("familyMembers") or []:
        if not isinstance(member, dict):
            continue
        person_id = member.get("personId") or member.get("memberId")
        if person_id:
            name_map[str(person_id)] = (
                _bilingual_en(member.get("name"))
                or _bilingual_mr(member.get("name"))
                or str(person_id)
            )

    return name_map


def _resolve_relationship_links(member, name_map):
    links = member.get("relationshipLinks") or []
    resolved = []

    for link in links:
        if not isinstance(link, dict):
            continue
        rel_type = _format_relationship_type(link.get("type"))
        target_id = str(link.get("targetPersonId") or "")
        target_name = name_map.get(target_id, target_id)
        if rel_type and target_name:
            resolved.append(f"{rel_type}: {target_name}")
        elif target_name:
            resolved.append(target_name)

    return "; ".join(resolved)


# Relation labels available as export filters. The applicant is treated as a
# pseudo-relation so it can be ticked/unticked like family members.
APPLICANT_RELATION_KEY = "applicant"

EXPORT_RELATION_LABELS = [
    "Father(pita)",
    "Mother(mata)",
    "Wife(patni)",
    "Husband(pati)",
    "Son(beta)",
    "Daughter(beti)",
    "Daughter-in-law(bahu)",
    "Brother(bhai)",
    "Sister(behen)",
    "Grandson(pota)",
    "Granddaughter(poti)",
    "Grandfather(dada)",
    "Grandmother(dadi)",
    "Uncle",
    "Aunt",
    "Cousin",
    "Nephew",
    "Niece",
    "Father-in-law",
    "Mother-in-law",
    "Other",
]


def _relation_filter_key(text):
    """Normalise a relation label into a comparable key (e.g. 'Son(beta)' -> 'son')."""
    raw = str(text or "")
    base = raw.split("(")[0]
    return re.sub(r"[^a-z]", "", base.lower())


def export_relation_options():
    options = [{
        "key": APPLICANT_RELATION_KEY,
        "label": "Applicant",
    }]
    for label in EXPORT_RELATION_LABELS:
        options.append({
            "key": _relation_filter_key(label),
            "label": label,
        })
    return options


DIRECTORY_EXPORT_DETAILED_HEADERS = [
    "Record ID",
    "Family ID",
    "Family Type",
    "Person Type",
    "Person Name (EN)",
    "Person Name (MR)",
    "Relation to Applicant",
    "Mobile / Contact",
    "Married",
    "Spouse Name (EN)",
    "Current City",
    "Related Members",
    "Applicant Name (EN)",
    "Applicant Mobile",
    "Address 1",
    "Address 2",
    "State",
    "District",
    "Taluka",
    "Surname Group",
    "Members Count",
    "Created By",
    "Created At",
]

DIRECTORY_EXPORT_SUMMARY_HEADERS = [
    "Record ID",
    "Family ID",
    "Family Type",
    "Applicant Name (EN)",
    "Applicant Name (MR)",
    "Applicant Mobile",
    "Address 1",
    "Address 2",
    "State",
    "District",
    "Taluka",
    "Surname Group",
    "Members Count",
    "Family Member Names",
    "Family Member Mobiles",
    "Created By",
    "Created At",
]


def _format_created_at(value):
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value or "")


def _summary_member_name_with_relation(member):
    """Format a family member name with its relation, e.g. 'Tejas (Son(beta))'."""
    name = (
        _bilingual_en(member.get("name"))
        or _bilingual_mr(member.get("name"))
    )
    relation = (
        member.get("relationToApplicant", "")
        or member.get("relation", "")
    )
    if relation:
        return f"{name} ({relation})"
    return name


def build_directory_export_rows(
    document,
    mode="detailed",
    selected_relation_keys=None,
):
    """Return a list of CSV rows for one registration document.

    ``selected_relation_keys`` is an optional set of normalised relation keys.
    When provided, only people whose relation is in the set are exported
    (the applicant uses the key ``applicant``). When ``None`` everything is
    included.
    """
    record_id = str(document.get("_id", ""))
    family_id = document.get("familyId", "") or ""
    family_type = document.get("familyType", "") or ""
    applicant_name_en = _applicant_full_name(document, "en")
    applicant_name_mr = _applicant_full_name(document, "mr")
    applicant_mobile = document.get("mobileNumber", "") or ""
    address1 = _bilingual_en(document.get("address1"))
    address2 = _bilingual_en(document.get("address2"))
    state = document.get("state", "") or ""
    district = document.get("district", "") or ""
    taluka = document.get("taluka", "") or ""
    surname_group = document.get("surnameGroup", "") or ""
    members_count = document.get("membersCount", "")
    created_by = document.get("createdBy", "") or ""
    created_at = _format_created_at(document.get("createdAt"))

    all_members = [
        member
        for member in (document.get("familyMembers") or [])
        if isinstance(member, dict)
    ]

    include_applicant = (
        selected_relation_keys is None
        or APPLICANT_RELATION_KEY in selected_relation_keys
    )

    if selected_relation_keys is None:
        family_members = all_members
    else:
        family_members = [
            member
            for member in all_members
            if _relation_filter_key(
                member.get("relationToApplicant") or member.get("relation") or ""
            ) in selected_relation_keys
        ]

    if mode == "summary":
        # Summary is one row per applicant; relation filters only affect which
        # family members are listed in the aggregated columns. Member names
        # include their relation to the applicant in parentheses.
        member_names = "; ".join(
            _summary_member_name_with_relation(member)
            for member in family_members
            if _bilingual_en(member.get("name")) or _bilingual_mr(member.get("name"))
        )
        member_mobiles = "; ".join(
            member.get("contactNumber", "")
            for member in family_members
            if member.get("contactNumber")
        )
        return [[
            record_id,
            family_id,
            family_type,
            applicant_name_en,
            applicant_name_mr,
            applicant_mobile,
            address1,
            address2,
            state,
            district,
            taluka,
            surname_group,
            members_count,
            member_names,
            member_mobiles,
            created_by,
            created_at,
        ]]

    name_map = _build_person_name_map(document)
    rows = []

    if include_applicant:
        rows.append([
            record_id,
            family_id,
            family_type,
            "Applicant",
            applicant_name_en,
            applicant_name_mr,
            "Self",
            applicant_mobile,
            "",
            "",
            "",
            "",
            applicant_name_en,
            applicant_mobile,
            address1,
            address2,
            state,
            district,
            taluka,
            surname_group,
            members_count,
            created_by,
            created_at,
        ])

    for member in family_members:
        rows.append([
            record_id,
            family_id,
            family_type,
            "Family Member",
            _bilingual_en(member.get("name")),
            _bilingual_mr(member.get("name")),
            member.get("relationToApplicant", "") or member.get("relation", ""),
            member.get("contactNumber", "") or "",
            "Yes" if member.get("isMarried") else "No",
            _bilingual_en(member.get("spouseName")),
            member.get("currentCity", "") or "",
            _resolve_relationship_links(member, name_map),
            applicant_name_en,
            applicant_mobile,
            address1,
            address2,
            state,
            district,
            taluka,
            surname_group,
            members_count,
            created_by,
            created_at,
        ])

    return rows


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


def is_campaigner_session():
    """Return True when the current session is a public session whose stored
    accountType is "campaigner". Account type is read from the session value
    set at login time (Requirement 11.4)."""
    return (
        is_public_session()
        and session.get("accountType") == ACCOUNT_TYPE_CAMPAIGNER
    )


def is_campaign_admin_session():
    """Return True when the current session is a staff user with the
    campaign_admin role. Campaign admins land on the campaign manager page
    and can approve/reject templates and confirm payments."""
    return (
        is_staff_session()
        and session.get("role") == "campaign_admin"
    )


def require_campaigner(view):
    """Decorator that restricts a view to campaigner sessions or campaign_admin
    staff sessions, or staff users with the 'campaigner' role.
    Any other session (unauthenticated, non-campaign staff, or
    registrant) receives a 403 JSON error (Requirements 1.6, 11.1, 11.2)."""
    @functools.wraps(view)
    def wrapper(*args, **kwargs):
        if (
            not is_campaigner_session()
            and not is_campaign_admin_session()
            and not (is_staff_session() and session.get("role") == "campaigner")
        ):
            return jsonify({
                "error": "Campaigner access required."
            }), 403
        return view(*args, **kwargs)

    return wrapper


def can_access_directory():
    if not require_auth():
        return False

    # Campaigners get read-only access to the Member Directory tab of the
    # campaign manager, even though their account status is not "approved"
    # (Requirements 2.2, 11.1).
    if is_campaigner_session():
        return True

    if is_pending_public_session():
        return False

    return role_can("access_directory")


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

    if role_can("view_all_registrations", role):
        return True

    if is_public_session():
        return str(document.get("_id")) == current_owned_registration_id()

    if is_staff_session():
        return document.get("createdBy") == session.get(
            "username",
            "",
        )

    return False


def can_view_family_tree(document):
    if not document:
        return False

    # Campaigners get read-only access to the family tree visualisation
    # via the campaign manager directory tab (mirrors can_access_directory).
    if is_campaigner_session():
        return True

    return role_can("access_family_tree")


def can_edit_registration(document):
    if not document:
        return False

    role = current_role()

    if role_can("edit_all_registrations", role):
        return True

    if is_public_session():
        return str(document.get("_id")) == current_owned_registration_id()

    if is_staff_session():
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

    # Position normalization (TEMP DISABLED): The frontend `fitView` was
    # working with the original (unnormalized) coordinates, so we keep
    # them as-is. If you re-enable this, also retest the family-tree
    # centering on multiple documents.
    # if positioned_nodes:
    #     xs = [n["position"].get("x", 0) for n in positioned_nodes]
    #     ys = [n["position"].get("y", 0) for n in positioned_nodes]
    #     center_x = (min(xs) + max(xs)) / 2
    #     top_y = min(ys)
    #     for n in positioned_nodes:
    #         n["position"] = {
    #             "x": n["position"].get("x", 0) - center_x,
    #             "y": n["position"].get("y", 0) - top_y,
    #         }

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
OTP_PROVIDER_DISABLED = "disabled"
OTP_EXPIRY_MINUTES = 5
OTP_RESEND_SECONDS = 30
OTP_MAX_ATTEMPTS = 5

# Settings key + default for the global "new mobile account" type. When a user
# logs in via OTP for the first time (no existing public_account), the new
# account is created with this account type. A super admin can toggle it
# between "registrant" (self-registration) and "campaigner".
PUBLIC_SIGNUP_SETTINGS_KEY = "public_signup_settings"


def read_default_account_type(settings_collection):
    """Return the configured default account type for new mobile signups.

    Reads the PUBLIC_SIGNUP_SETTINGS_KEY document and normalizes the stored
    value, defaulting to "registrant" when unset or unrecognized.
    """
    try:
        doc = (
            settings_collection.find_one({"key": PUBLIC_SIGNUP_SETTINGS_KEY})
            or {}
        )
    except Exception:
        doc = {}
    return normalize_account_type(doc.get("defaultAccountType"))


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
        "whatsappLoginEnabled": False,
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
        OTP_PROVIDER_DISABLED,
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
        "whatsappLoginEnabled": bool(
            payload.get("whatsappLoginEnabled")
            if "whatsappLoginEnabled" in payload
            else existing.get("whatsappLoginEnabled", False)
        ),
        "updatedAt": existing.get("updatedAt"),
        "updatedBy": existing.get("updatedBy", ""),
    }


def is_mobile_login_enabled(existing_settings, test_mode=False):
    """Mobile (OTP) login is available unless the active provider is disabled."""
    settings = normalize_otp_settings(
        existing=existing_settings,
        test_mode=test_mode,
    )
    return settings.get("activeProvider") != OTP_PROVIDER_DISABLED


def is_whatsapp_login_enabled(existing_settings, test_mode=False):
    """WhatsApp login is available when the toggle is enabled in OTP settings."""
    settings = normalize_otp_settings(
        existing=existing_settings,
        test_mode=test_mode,
    )
    return bool(settings.get("whatsappLoginEnabled", False))


def find_public_account_by_mobile(public_accounts, mobile_10):
    """Look up a public_account by its 10-digit mobile, tolerating legacy formats.

    Older accounts may have been stored with a "+91" / "91" / "0091" / leading
    "0" prefixed mobile number. We try the canonical 10-digit form first, then
    fall back to known legacy variants. When a match is found under a legacy
    format, the stored mobileNumber is rewritten to the 10-digit form so future
    lookups (and campaigner routing) are stable.

    Returns the account document (with its mobileNumber normalized to 10 digits)
    or None.
    """
    if not mobile_10:
        return None

    account = public_accounts.find_one({"mobileNumber": mobile_10})
    if account:
        return account

    legacy_candidates = [
        f"+91{mobile_10}",
        f"91{mobile_10}",
        f"0091{mobile_10}",
        f"0{mobile_10}",
    ]
    account = public_accounts.find_one(
        {"mobileNumber": {"$in": legacy_candidates}}
    )
    if account:
        public_accounts.update_one(
            {"_id": account["_id"]},
            {"$set": {"mobileNumber": mobile_10}},
        )
        account["mobileNumber"] = mobile_10

    return account


def serialize_public_account(account):
    serialized = serialize_document(account)
    return {
        "id": serialized.get("_id", ""),
        "mobileNumber": serialized.get("mobileNumber", ""),
        "accountType": serialized.get(
            "accountType",
            DEFAULT_ACCOUNT_TYPE,
        ),
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
    session["accountType"] = (
        account.get("accountType") or DEFAULT_ACCOUNT_TYPE
    )
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

        access_token = (
            meta.get("accessToken")
            or os.environ.get("WA_TOKEN", "")
        )
        phone_number_id = (
            meta.get("phoneNumberId")
            or os.environ.get("WA_PHONE_ID", "")
        )
        template_name = meta.get("templateName") or ""
        template_language = (
            meta.get("templateLanguage") or "en_US"
        )

        if (
            not access_token
            or not phone_number_id
            or not template_name
        ):
            raise ValueError("Meta WhatsApp settings are incomplete.")

        components = []
        if otp_code:
            components.append({
                "type": "body",
                "parameters": [
                    {"type": "text", "text": otp_code}
                ],
            })
            components.append({
                "type": "button",
                "sub_type": "url",
                "index": "0",
                "parameters": [
                    {"type": "text", "text": otp_code}
                ],
            })

        payload = {
            "messaging_product": "whatsapp",
            "to": mobile_number.replace("+", ""),
            "type": "template",
            "template": {
                "name": template_name,
                "language": {"code": template_language},
                "components": components,
            },
        }

        response = requests.post(
            f"https://graph.facebook.com/v24.0/{phone_number_id}/messages",
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=15,
        )

        if not response.ok:
            try:
                error_body = response.json()
                error_detail = (
                    error_body.get("error", {}).get("message")
                    or error_body.get("error", {}).get("error_user_msg")
                    or str(error_body)
                )
            except Exception:
                error_detail = response.text or response.reason
            raise ValueError(
                f"WhatsApp API error ({response.status_code}): {error_detail}"
            )

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
        "campaign_admin",
        "campaigner",
        "operator",
        "viewer",
    ],
    "admin": [
        "campaign_admin",
        "campaigner",
        "operator",
        "viewer",
    ],
    "campaign_admin": [
        "campaigner",
    ],
}

ROLE_DELETION_RULES = {
    "super_admin": [
        "super_admin",
        "admin",
        "campaign_admin",
        "campaigner",
        "operator",
        "viewer",
    ],
    "admin": [
        "campaign_admin",
        "campaigner",
        "operator",
        "viewer",
    ],
    "campaign_admin": [
        "campaigner",
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


# ---------------------------------------------------------------------------
# Super admin configurable role permissions & limits
# ---------------------------------------------------------------------------

ROLE_CONFIG_KEY = "role_config"

MANAGED_ROLES = [
    "super_admin",
    "admin",
    "campaign_admin",
    "campaigner",
    "operator",
    "viewer",
]

ROLE_LABELS = {
    "super_admin": "Super Admin",
    "admin": "Admin",
    "campaign_admin": "Campaign Admin",
    "campaigner": "Campaigner",
    "operator": "Operator",
    "viewer": "Viewer",
}

# Capabilities that can be toggled per role from the super admin dashboard.
ROLE_CAPABILITIES = [
    {
        "key": "access_directory",
        "label": "Access member directory",
        "description": "View and search the member directory.",
    },
    {
        "key": "create_registrations",
        "label": "Create / edit member records",
        "description": "Register new members and manage records they created.",
    },
    {
        "key": "view_all_registrations",
        "label": "View all member records",
        "description": "See every record, not just records they created.",
    },
    {
        "key": "edit_all_registrations",
        "label": "Edit all member records",
        "description": "Edit any record regardless of who created it.",
    },
    {
        "key": "delete_registrations",
        "label": "Delete member records",
        "description": "Delete member records and family members.",
    },
    {
        "key": "update_invitation_name",
        "label": "Update invitation name",
        "description": "Edit the invitation name shown for a member record.",
    },
    {
        "key": "access_family_tree",
        "label": "Access family tree",
        "description": "Open the family tree visualisation.",
    },
    {
        "key": "manage_users",
        "label": "Manage staff users",
        "description": "Create and remove staff accounts.",
    },
    {
        "key": "review_self_registrations",
        "label": "Review self registrations",
        "description": "Approve or reject public self registrations.",
    },
    {
        "key": "view_leaderboard",
        "label": "View operator leaderboard",
        "description": "Access operator performance reports.",
    },
    {
        "key": "bulk_import",
        "label": "Bulk import records",
        "description": "Import member records in bulk.",
    },
    {
        "key": "export_directory",
        "label": "Export member directory",
        "description": "Export member and family data to CSV.",
    },
    {
        "key": "manage_otp_settings",
        "label": "Manage OTP settings",
        "description": "Configure OTP / WhatsApp delivery providers.",
    },
    {
        "key": "manage_role_config",
        "label": "Manage roles & permissions",
        "description": "Access this super admin dashboard.",
    },
    {
        "key": "manage_transliteration",
        "label": "Use transliteration fixer",
        "description": "Fix Marathi name transliterations across records.",
    },
    {
        "key": "manage_address_areas",
        "label": "Use address area tool",
        "description": "Bifurcate the directory by locality and export it.",
    },
    {
        "key": "export_address_areas",
        "label": "Export address-area CSV",
        "description": "Download the grouped address CSV from the address area tool.",
    },
    {
        "key": "confirm_campaign_payments",
        "label": "Confirm campaign payments",
        "description": "View pending UPI payments and confirm them to trigger campaign delivery.",
    },
    {
        "key": "manage_wa_web",
        "label": "Manage WhatsApp Web",
        "description": "Connect WhatsApp, view backups, manage contacts, and control message routing.",
    },
    {
        "key": "manage_wa_routing",
        "label": "Control message routing",
        "description": "Configure the hybrid routing engine (Web session vs Cloud API rules).",
    },
]

ROLE_LIMITS = [
    {
        "key": "maxFamilyMembers",
        "label": "Max family members per registration",
        "default": 50,
        "min": 1,
        "max": 200,
    },
    {
        "key": "directorySearchPageSize",
        "label": "Default directory results per page",
        "default": 15,
        "min": 1,
        "max": 200,
    },
    {
        "key": "exportMaxRecords",
        "label": "Max records per export",
        "default": 100000,
        "min": 1,
        "max": 1000000,
    },
]

# Default permission matrix - mirrors the behaviour hardcoded throughout the
# app so that an empty configuration keeps the app working exactly as before.
DEFAULT_ROLE_PERMISSIONS = {
    "super_admin": {
        capability["key"]: True
        for capability in ROLE_CAPABILITIES
    },
    "admin": {
        "access_directory": True,
        "create_registrations": True,
        "view_all_registrations": True,
        "edit_all_registrations": True,
        "delete_registrations": True,
        "update_invitation_name": True,
        "access_family_tree": True,
        "manage_users": True,
        "review_self_registrations": True,
        "view_leaderboard": True,
        "bulk_import": True,
        "export_directory": True,
        "manage_otp_settings": False,
        "manage_role_config": False,
        "manage_transliteration": True,
        "manage_address_areas": True,
        "export_address_areas": True,
        "confirm_campaign_payments": True,
        "manage_wa_web": False,
        "manage_wa_routing": False,
    },
    "campaign_admin": {
        "access_directory": True,
        "create_registrations": True,
        "view_all_registrations": False,
        "edit_all_registrations": False,
        "delete_registrations": False,
        "update_invitation_name": False,
        "access_family_tree": True,
        "manage_users": True,
        "review_self_registrations": False,
        "view_leaderboard": False,
        "bulk_import": False,
        "export_directory": False,
        "manage_otp_settings": False,
        "manage_role_config": False,
        "manage_transliteration": False,
        "manage_address_areas": False,
        "export_address_areas": False,
        "confirm_campaign_payments": True,
        "manage_wa_web": True,
        "manage_wa_routing": False,
    },
    "campaigner": {
        "access_directory": False,
        "create_registrations": False,
        "view_all_registrations": False,
        "edit_all_registrations": False,
        "delete_registrations": False,
        "update_invitation_name": False,
        "access_family_tree": False,
        "manage_users": False,
        "review_self_registrations": False,
        "view_leaderboard": False,
        "bulk_import": False,
        "export_directory": False,
        "manage_otp_settings": False,
        "manage_role_config": False,
        "manage_transliteration": False,
        "manage_address_areas": False,
        "export_address_areas": False,
        "confirm_campaign_payments": False,
        "manage_wa_web": False,
        "manage_wa_routing": False,
    },
    "operator": {
        "access_directory": True,
        "create_registrations": True,
        "view_all_registrations": False,
        "edit_all_registrations": False,
        "delete_registrations": False,
        "update_invitation_name": False,
        "access_family_tree": True,
        "manage_users": False,
        "review_self_registrations": False,
        "view_leaderboard": False,
        "bulk_import": False,
        "export_directory": False,
        "manage_otp_settings": False,
        "manage_role_config": False,
        "manage_transliteration": False,
        "manage_address_areas": False,
        "export_address_areas": False,
        "confirm_campaign_payments": False,
        "manage_wa_web": False,
        "manage_wa_routing": False,
    },
    "viewer": {
        "access_directory": True,
        "create_registrations": False,
        "view_all_registrations": False,
        "edit_all_registrations": False,
        "delete_registrations": False,
        "update_invitation_name": False,
        "access_family_tree": False,
        "manage_users": False,
        "review_self_registrations": False,
        "view_leaderboard": False,
        "bulk_import": False,
        "export_directory": False,
        "manage_otp_settings": False,
        "manage_role_config": False,
        "manage_transliteration": False,
        "manage_address_areas": False,
        "export_address_areas": False,
        "confirm_campaign_payments": False,
        "manage_wa_web": False,
        "manage_wa_routing": False,
    },
}

# Capabilities that super_admin must always retain so the dashboard cannot
# lock everyone out of administration.
SUPER_ADMIN_LOCKED_CAPABILITIES = {
    "access_directory",
    "manage_role_config",
    "manage_users",
}


def default_role_config():
    permissions = {
        role: dict(DEFAULT_ROLE_PERMISSIONS.get(role, {}))
        for role in MANAGED_ROLES
    }

    limits = {
        limit["key"]: limit["default"]
        for limit in ROLE_LIMITS
    }

    return {
        "key": ROLE_CONFIG_KEY,
        "permissions": permissions,
        "limits": limits,
        "updatedAt": None,
        "updatedBy": "",
    }


def normalize_role_config(payload=None, existing=None):
    payload = payload or {}
    base = default_role_config()
    existing = existing or {}

    stored_permissions = existing.get("permissions") or {}
    incoming_permissions = payload.get("permissions") or {}

    permissions = {}
    for role in MANAGED_ROLES:
        role_defaults = base["permissions"][role]
        role_stored = stored_permissions.get(role) or {}
        role_incoming = incoming_permissions.get(role) or {}

        merged = {}
        for capability in ROLE_CAPABILITIES:
            cap_key = capability["key"]
            if cap_key in role_incoming:
                merged[cap_key] = bool(role_incoming[cap_key])
            elif cap_key in role_stored:
                merged[cap_key] = bool(role_stored[cap_key])
            else:
                merged[cap_key] = bool(role_defaults.get(cap_key, False))

        permissions[role] = merged

    # Super admin can never be locked out of core administration.
    for cap_key in SUPER_ADMIN_LOCKED_CAPABILITIES:
        permissions["super_admin"][cap_key] = True

    stored_limits = existing.get("limits") or {}
    incoming_limits = payload.get("limits") or {}

    limits = {}
    for limit in ROLE_LIMITS:
        key = limit["key"]
        raw = incoming_limits.get(
            key,
            stored_limits.get(key, limit["default"]),
        )
        try:
            value = int(raw)
        except (TypeError, ValueError):
            value = limit["default"]

        value = max(limit["min"], min(limit["max"], value))
        limits[key] = value

    return {
        "key": ROLE_CONFIG_KEY,
        "permissions": permissions,
        "limits": limits,
        "updatedAt": existing.get("updatedAt"),
        "updatedBy": existing.get("updatedBy", ""),
    }


def effective_role_config():
    """Return the stored role config merged over defaults."""
    try:
        stored = (
            current_app.get_settings_collection()
            .find_one({"key": ROLE_CONFIG_KEY})
        )
    except Exception:
        stored = None

    return normalize_role_config(existing=stored)


def role_can(capability, role=None):
    """Check whether a role has a capability per the configurable matrix."""
    if role is None:
        role = current_role()

    # Super admin always retains locked core capabilities as a failsafe.
    if role == "super_admin" and capability in SUPER_ADMIN_LOCKED_CAPABILITIES:
        return True

    config = effective_role_config()
    role_permissions = config["permissions"].get(role)

    if role_permissions is None:
        return False

    return bool(role_permissions.get(capability, False))


def get_role_limit(key):
    config = effective_role_config()
    default = next(
        (
            limit["default"]
            for limit in ROLE_LIMITS
            if limit["key"] == key
        ),
        0,
    )
    return config["limits"].get(key, default)
