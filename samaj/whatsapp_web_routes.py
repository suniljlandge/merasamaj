"""
Flask routes for WhatsApp Web integration.

Registers Blueprint routes under /api/wa-web/* that the frontend calls.
These proxy requests to the Node.js sidecar service via the whatsapp_web module.
"""

from flask import Blueprint, request, jsonify, session
import requests as http_requests
from . import whatsapp_web as wa

wa_web_bp = Blueprint("wa_web", __name__, url_prefix="/api/wa-web")


def _get_user_id():
    """Extract current user ID from session (public account or staff).
    For WhatsApp status checks, prefer the sidecar userId if available."""
    # If user logged in via WhatsApp, use the sidecar userId directly
    sidecar_id = session.get("wa_sidecar_user_id")
    if sidecar_id:
        return sidecar_id
    # Public account (campaigner) — stored as public_account_id string
    pub_id = session.get("public_account_id")
    if pub_id:
        return str(pub_id)
    # Staff user — stored as username or user_id
    if session.get("auth_type") == "staff":
        return session.get("user_id") or session.get("username")
    return None


def _require_auth(f):
    """Decorator to require login."""
    from functools import wraps

    @wraps(f)
    def decorated(*args, **kwargs):
        if not _get_user_id():
            return jsonify({"error": "Login required"}), 401
        return f(*args, **kwargs)

    return decorated


# ===========================================================================
# Service Health
# ===========================================================================


@wa_web_bp.route("/health", methods=["GET"])
@_require_auth
def health():
    """Check if WhatsApp Web sidecar is available."""
    available = wa.is_service_available()
    return jsonify({"available": available})


# ===========================================================================
# Session / Connection
# ===========================================================================


@wa_web_bp.route("/connect", methods=["POST"])
@_require_auth
def connect():
    """Start OTP-based WhatsApp login."""
    user_id = _get_user_id()
    data = request.get_json(force=True)
    phone_number = data.get("phoneNumber")

    if not phone_number:
        return jsonify({"error": "phoneNumber is required"}), 400

    # Normalize phone: ensure it's digits only with country code
    phone_clean = phone_number.replace("+", "").replace(" ", "").replace("-", "")
    if len(phone_clean) == 10 and phone_clean[0] in "6789":
        phone_clean = "91" + phone_clean

    try:
        result = wa.connect_session(user_id, phone_clean)
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@wa_web_bp.route("/connect-qr", methods=["POST"])
@_require_auth
def connect_qr():
    """Start QR-code-based WhatsApp login."""
    user_id = _get_user_id()
    try:
        resp = http_requests.post(
            wa._url("/api/session/connect-qr"),
            headers=wa._headers(),
            json={"userId": user_id},
            timeout=15,
        )
        resp.raise_for_status()
        return jsonify(resp.json())
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@wa_web_bp.route("/qr", methods=["GET"])
@_require_auth
def get_qr():
    """Poll for latest QR code."""
    user_id = _get_user_id()
    try:
        resp = http_requests.get(
            wa._url(f"/api/session/qr/{user_id}"),
            headers=wa._headers(),
            timeout=10,
        )
        resp.raise_for_status()
        return jsonify(resp.json())
    except Exception as e:
        return jsonify({"error": str(e), "qr": None, "status": "unavailable"}), 200


@wa_web_bp.route("/status", methods=["GET"])
@_require_auth
def status():
    """Get current session status."""
    user_id = _get_user_id()
    try:
        result = wa.get_session_status(user_id)
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e), "status": "unavailable"}), 200


@wa_web_bp.route("/backup/running", methods=["GET"])
@_require_auth
def backup_running():
    """Check if backup is currently in progress for the current user."""
    user_id = _get_user_id()
    try:
        running = wa.is_backup_running(user_id)
        return jsonify({"backupRunning": running})
    except Exception:
        return jsonify({"backupRunning": False})


@wa_web_bp.route("/disconnect", methods=["POST"])
@_require_auth
def disconnect():
    """Disconnect WhatsApp session."""
    user_id = _get_user_id()
    try:
        result = wa.disconnect_session(user_id)
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ===========================================================================
# Media Upload
# ===========================================================================

MAX_MEDIA_SIZE = 32 * 1024 * 1024  # 32 MB


@wa_web_bp.route("/upload-media", methods=["POST"])
@_require_auth
def upload_media():
    """Upload a media file for campaign messages. Max 32 MB.
    Stores file on disk (or R2 if configured) and returns the URL."""
    import os
    import uuid
    from flask import current_app

    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400

    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "Empty filename"}), 400

    # Check file size from content-length header
    content_length = request.content_length or 0
    if content_length > MAX_MEDIA_SIZE:
        return jsonify({"error": f"File too large. Max size is 32 MB."}), 413

    # Read file and check actual size
    file_data = file.read()
    if len(file_data) > MAX_MEDIA_SIZE:
        return jsonify({"error": f"File too large ({len(file_data) // (1024*1024)} MB). Max is 32 MB."}), 413

    # Determine media type from extension
    filename = file.filename
    ext = os.path.splitext(filename)[1].lower()
    if ext in (".jpg", ".jpeg", ".png", ".gif", ".webp"):
        media_type = "image"
    elif ext in (".mp4", ".mov", ".avi", ".mkv", ".webm"):
        media_type = "video"
    else:
        media_type = "document"

    # Save to uploads directory
    upload_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "uploads")
    os.makedirs(upload_dir, exist_ok=True)

    # Generate unique filename
    unique_name = f"{uuid.uuid4().hex[:12]}_{filename}"
    file_path = os.path.join(upload_dir, unique_name)

    with open(file_path, "wb") as f:
        f.write(file_data)

    # Generate URL (served by Flask or external)
    from flask import url_for
    media_url = url_for("wa_web.serve_upload", filename=unique_name, _external=True)

    return jsonify({
        "success": True,
        "url": media_url,
        "mediaType": media_type,
        "filename": filename,
        "size": len(file_data),
    })


@wa_web_bp.route("/uploads/<filename>", methods=["GET"])
def serve_upload(filename):
    """Serve uploaded media files."""
    import os
    from flask import send_from_directory
    upload_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "uploads")
    return send_from_directory(upload_dir, filename)


# ===========================================================================
# Messaging
# ===========================================================================


@wa_web_bp.route("/send", methods=["POST"])
@_require_auth
def send_message():
    """
    Send a personal message via WhatsApp Web session.
    Falls back to Cloud API if limit reached.
    """
    user_id = _get_user_id()
    data = request.get_json(force=True)
    recipient = data.get("recipientPhone")
    text = data.get("text")

    if not recipient or not text:
        return jsonify({"error": "recipientPhone and text are required"}), 400

    try:
        # First check routing decision
        route = wa.decide_route(user_id, recipient, "personal", 1)

        if route.get("channel") == "cloud_api":
            return jsonify({
                "channel": "cloud_api",
                "reason": route.get("reason"),
                "message": "This message should be sent via Cloud API",
            })

        # Send via Web session
        result = wa.send_personal_message(user_id, recipient, text)

        if result.get("fallbackToCloudAPI"):
            return jsonify({
                "channel": "cloud_api",
                "reason": result.get("error"),
                "message": "Daily limit reached, use Cloud API",
            }), 200

        return jsonify({"channel": "web", "success": True, **result})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@wa_web_bp.route("/send-stats", methods=["GET"])
@_require_auth
def send_stats():
    """Get today's send statistics."""
    user_id = _get_user_id()
    try:
        result = wa.get_daily_send_stats(user_id)
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ===========================================================================
# Backup (Super Admin only)
# ===========================================================================


def _require_super_admin(f):
    """Decorator to require manage_wa_web capability (super admin)."""
    from functools import wraps

    @wraps(f)
    def decorated(*args, **kwargs):
        if not _get_user_id():
            return jsonify({"error": "Login required"}), 401
        from samaj.app import role_can
        if not role_can("manage_wa_web"):
            return jsonify({"error": "Forbidden"}), 403
        return f(*args, **kwargs)

    return decorated


@wa_web_bp.route("/backup/start", methods=["POST"])
@_require_super_admin
def start_backup():
    """Trigger a contact + group + profile pic backup (super admin only)."""
    user_id = _get_user_id()
    data = request.get_json(silent=True) or {}
    include_pics = data.get("includeProfilePics", True)
    # Allow super admin to specify a target user
    target_user = data.get("targetUserId") or user_id

    try:
        result = wa.trigger_backup(target_user, include_pics)
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@wa_web_bp.route("/backup/status", methods=["GET"])
@_require_super_admin
def backup_status():
    """Get backup stats and last backup info (super admin only)."""
    user_id = request.args.get("userId") or _get_user_id()
    try:
        result = wa.get_backup_status(user_id)
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@wa_web_bp.route("/backup/export", methods=["GET"])
@_require_super_admin
def export_contacts():
    """Export contacts as JSON or CSV (super admin only)."""
    user_id = request.args.get("userId") or _get_user_id()
    fmt = request.args.get("format", "json")

    try:
        result = wa.export_contacts(user_id, fmt)
        if fmt == "csv":
            from flask import Response

            return Response(
                result,
                mimetype="text/csv",
                headers={
                    "Content-Disposition": f"attachment; filename=contacts_{user_id}.csv"
                },
            )
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@wa_web_bp.route("/backup/profile-pic/<phone>", methods=["GET"])
@_require_super_admin
def profile_pic(phone):
    """Get a signed URL for a contact's profile picture (super admin only)."""
    user_id = request.args.get("userId") or _get_user_id()
    try:
        url = wa.get_profile_pic_url(user_id, phone)
        if not url:
            return jsonify({"error": "No profile picture"}), 404
        return jsonify({"url": url, "expiresIn": 3600})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@wa_web_bp.route("/backup/profile-pic-history/<phone>", methods=["GET"])
@_require_super_admin
def profile_pic_history(phone):
    """Get all historical profile pictures for a contact (super admin only)."""
    user_id = request.args.get("userId") or _get_user_id()
    try:
        history = wa.get_profile_pic_history(user_id, phone)
        return jsonify({"history": history})
    except Exception as e:
        return jsonify({"error": str(e), "history": []}), 200


@wa_web_bp.route("/backup/profile-pics-batch", methods=["POST"])
@_require_super_admin
def profile_pics_batch():
    """Get signed URLs for multiple contacts in one request (super admin only)."""
    data = request.get_json() or {}
    user_id = data.get("userId") or request.args.get("userId") or _get_user_id()
    phones = data.get("phones", [])
    try:
        urls = wa.get_profile_pics_batch(user_id, phones)
        return jsonify({"urls": urls})
    except Exception as e:
        return jsonify({"error": str(e), "urls": {}}), 200


@wa_web_bp.route("/messages/<phone>", methods=["GET"])
@_require_super_admin
def get_messages(phone):
    """Get chat messages for a contact (super admin only)."""
    user_id = request.args.get("userId") or _get_user_id()
    limit = request.args.get("limit", "100")
    try:
        resp = http_requests.get(
            wa._url(f"/api/messages/{user_id}/{phone}"),
            headers=wa._headers(),
            params={"limit": limit},
            timeout=15,
        )
        resp.raise_for_status()
        return jsonify(resp.json())
    except Exception as e:
        return jsonify({"error": str(e), "messages": []}), 200


@wa_web_bp.route("/messages/fetch-history", methods=["POST"])
@_require_super_admin
def fetch_message_history():
    """Request older messages from WhatsApp for a contact (super admin only)."""
    data = request.get_json(force=True)
    user_id = data.get("userId") or _get_user_id()
    phone = data.get("phone", "")
    try:
        resp = http_requests.post(
            wa._url("/api/messages/fetch-history"),
            headers=wa._headers(),
            json={"userId": user_id, "phone": phone},
            timeout=15,
        )
        resp.raise_for_status()
        return jsonify(resp.json())
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@wa_web_bp.route("/messages/download-media", methods=["POST"])
@_require_super_admin
def download_media():
    """Download media for a message on-demand (super admin only)."""
    data = request.get_json(force=True)
    user_id = data.get("userId") or _get_user_id()
    phone = data.get("phone", "")
    message_id = data.get("messageId", "")

    try:
        resp = http_requests.post(
            wa._url("/api/messages/download-media"),
            headers=wa._headers(),
            json={"userId": user_id, "phone": phone, "messageId": message_id},
            timeout=30,
        )
        resp.raise_for_status()
        return jsonify(resp.json())
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ===========================================================================
# Custom Templates (with admin approval)
# ===========================================================================

_TEMPLATES_COLLECTION = "wa_custom_templates"


@wa_web_bp.route("/templates", methods=["GET"])
@_require_auth
def list_custom_templates():
    """List custom templates. Users see only their own + approved ones."""
    from flask import current_app
    from samaj.app import role_can
    collection = current_app.extensions.get("mongo_collection")
    db = collection.database
    col = db[_TEMPLATES_COLLECTION]

    user_id = _get_user_id()
    is_admin = role_can("manage_wa_web")

    if is_admin:
        # Admin sees all templates
        templates = list(col.find({}).sort("createdAt", -1))
    else:
        # Users see their own (any status) + all approved
        templates = list(col.find({
            "$or": [
                {"createdBy": user_id},
                {"status": "approved"},
            ]
        }).sort("createdAt", -1))

    for t in templates:
        t["_id"] = str(t["_id"])

    return jsonify({"templates": templates})


@wa_web_bp.route("/templates", methods=["POST"])
@_require_auth
def create_custom_template():
    """Create a custom template (pending approval)."""
    from flask import current_app
    from datetime import datetime, timezone
    collection = current_app.extensions.get("mongo_collection")
    db = collection.database
    col = db[_TEMPLATES_COLLECTION]

    data = request.get_json(force=True)
    name = (data.get("name") or "").strip()
    body_text = (data.get("bodyText") or "").strip()
    language = (data.get("language") or "hi").strip()
    media_url = (data.get("mediaUrl") or "").strip()
    media_type = (data.get("mediaType") or "").strip()

    if not name or not body_text:
        return jsonify({"error": "name and bodyText are required"}), 400

    user_id = _get_user_id()

    template = {
        "name": name,
        "bodyText": body_text,
        "language": language,
        "mediaUrl": media_url,
        "mediaType": media_type,
        "status": "pending",  # pending, approved, rejected
        "createdBy": user_id,
        "createdAt": datetime.now(timezone.utc),
        "reviewedBy": None,
        "reviewedAt": None,
        "rejectionReason": None,
    }

    result = col.insert_one(template)
    template["_id"] = str(result.inserted_id)

    return jsonify({"success": True, "template": template})


@wa_web_bp.route("/templates/<template_id>/approve", methods=["POST"])
@_require_auth
def approve_template(template_id):
    """Approve a custom template (super admin/admin only)."""
    from flask import current_app
    from samaj.app import role_can
    from datetime import datetime, timezone
    from bson import ObjectId

    if not role_can("manage_wa_web"):
        return jsonify({"error": "Forbidden"}), 403

    collection = current_app.extensions.get("mongo_collection")
    db = collection.database
    col = db[_TEMPLATES_COLLECTION]

    try:
        oid = ObjectId(template_id)
    except Exception:
        return jsonify({"error": "Invalid template ID"}), 400

    result = col.update_one(
        {"_id": oid, "status": "pending"},
        {"$set": {
            "status": "approved",
            "reviewedBy": _get_user_id(),
            "reviewedAt": datetime.now(timezone.utc),
        }}
    )

    if result.matched_count == 0:
        return jsonify({"error": "Template not found or already reviewed"}), 404

    return jsonify({"success": True})


@wa_web_bp.route("/templates/<template_id>/reject", methods=["POST"])
@_require_auth
def reject_template(template_id):
    """Reject a custom template (super admin/admin only)."""
    from flask import current_app
    from samaj.app import role_can
    from datetime import datetime, timezone
    from bson import ObjectId

    if not role_can("manage_wa_web"):
        return jsonify({"error": "Forbidden"}), 403

    data = request.get_json(silent=True) or {}
    reason = (data.get("reason") or "").strip()

    collection = current_app.extensions.get("mongo_collection")
    db = collection.database
    col = db[_TEMPLATES_COLLECTION]

    try:
        oid = ObjectId(template_id)
    except Exception:
        return jsonify({"error": "Invalid template ID"}), 400

    result = col.update_one(
        {"_id": oid, "status": "pending"},
        {"$set": {
            "status": "rejected",
            "reviewedBy": _get_user_id(),
            "reviewedAt": datetime.now(timezone.utc),
            "rejectionReason": reason or "No reason provided",
        }}
    )

    if result.matched_count == 0:
        return jsonify({"error": "Template not found or already reviewed"}), 404

    return jsonify({"success": True})


@wa_web_bp.route("/templates/<template_id>", methods=["DELETE"])
@_require_auth
def delete_template(template_id):
    """Delete a custom template. Users can delete their own, admins can delete any."""
    from flask import current_app
    from samaj.app import role_can
    from bson import ObjectId

    collection = current_app.extensions.get("mongo_collection")
    db = collection.database
    col = db[_TEMPLATES_COLLECTION]

    try:
        oid = ObjectId(template_id)
    except Exception:
        return jsonify({"error": "Invalid template ID"}), 400

    template = col.find_one({"_id": oid})
    if not template:
        return jsonify({"error": "Template not found"}), 404

    user_id = _get_user_id()
    is_admin = role_can("manage_wa_web")

    # Users can only delete their own templates, admins can delete any
    if not is_admin and template.get("createdBy") != user_id:
        return jsonify({"error": "You can only delete your own templates"}), 403

    col.delete_one({"_id": oid})
    return jsonify({"success": True})


# ===========================================================================
# Routing Config (Super Admin)
# ===========================================================================

_ROUTING_SETTINGS_KEY = "wa_routing_config"


def _get_settings_col():
    """Get the app_settings collection."""
    from flask import current_app
    collection = current_app.extensions.get("mongo_collection")
    return collection.database["app_settings"]


def _default_routing_config():
    """Default routing engine configuration."""
    return {
        "key": _ROUTING_SETTINGS_KEY,
        "enabled": True,
        "maxDailyWebSends": 20,
        "profilePicFetchDelayMs": 2500,
        "autoBackupOnConnect": True,
        "autoBackupSchedule": "daily",
        "rules": {
            "forceCloudApiForFirstContact": True,
            "forceCloudApiForMultiRecipient": True,
            "forceCloudApiForCampaign": True,
            "allowWebForPersonalFollowup": True,
        },
        "cooldown": {
            "enabled": True,
            "hoursAfterWarning": 72,
        },
    }


@wa_web_bp.route("/routing-config", methods=["GET"])
@_require_auth
def get_routing_config():
    """Get the current routing engine configuration (super admin only)."""
    from samaj.app import role_can
    if not role_can("manage_wa_routing"):
        return jsonify({"error": "Forbidden"}), 403

    col = _get_settings_col()
    config = col.find_one({"key": _ROUTING_SETTINGS_KEY})
    if not config:
        config = _default_routing_config()

    config.pop("_id", None)
    return jsonify(config)


@wa_web_bp.route("/routing-config", methods=["PUT"])
@_require_auth
def save_routing_config():
    """Save routing engine configuration (super admin only)."""
    from samaj.app import role_can
    if not role_can("manage_wa_routing"):
        return jsonify({"error": "Forbidden"}), 403

    data = request.get_json(force=True)
    col = _get_settings_col()

    # Merge with defaults to ensure all fields exist
    defaults = _default_routing_config()
    updated = {
        "key": _ROUTING_SETTINGS_KEY,
        "enabled": data.get("enabled", defaults["enabled"]),
        "maxDailyWebSends": int(data.get("maxDailyWebSends", defaults["maxDailyWebSends"])),
        "profilePicFetchDelayMs": int(data.get("profilePicFetchDelayMs", defaults["profilePicFetchDelayMs"])),
        "autoBackupOnConnect": data.get("autoBackupOnConnect", defaults["autoBackupOnConnect"]),
        "autoBackupSchedule": data.get("autoBackupSchedule", defaults["autoBackupSchedule"]),
        "rules": {
            "forceCloudApiForFirstContact": data.get("rules", {}).get(
                "forceCloudApiForFirstContact", defaults["rules"]["forceCloudApiForFirstContact"]
            ),
            "forceCloudApiForMultiRecipient": data.get("rules", {}).get(
                "forceCloudApiForMultiRecipient", defaults["rules"]["forceCloudApiForMultiRecipient"]
            ),
            "forceCloudApiForCampaign": data.get("rules", {}).get(
                "forceCloudApiForCampaign", defaults["rules"]["forceCloudApiForCampaign"]
            ),
            "allowWebForPersonalFollowup": data.get("rules", {}).get(
                "allowWebForPersonalFollowup", defaults["rules"]["allowWebForPersonalFollowup"]
            ),
        },
        "cooldown": {
            "enabled": data.get("cooldown", {}).get("enabled", defaults["cooldown"]["enabled"]),
            "hoursAfterWarning": int(data.get("cooldown", {}).get(
                "hoursAfterWarning", defaults["cooldown"]["hoursAfterWarning"]
            )),
        },
    }

    col.update_one(
        {"key": _ROUTING_SETTINGS_KEY},
        {"$set": updated},
        upsert=True,
    )

    updated.pop("_id", None)
    return jsonify({"success": True, "config": updated})


# ===========================================================================
# All Sessions Overview (Super Admin)
# ===========================================================================

@wa_web_bp.route("/sessions", methods=["GET"])
@_require_auth
def all_sessions():
    """Get all WA web sessions with backup stats (super admin view)."""
    from samaj.app import role_can
    if not role_can("manage_wa_web"):
        return jsonify({"error": "Forbidden"}), 403

    from flask import current_app
    collection = current_app.extensions.get("mongo_collection")
    db = collection.database
    sessions = list(
        db["wa_web_sessions"].find(
            {},
            {"_id": 0, "userId": 1, "phoneNumber": 1, "status": 1, "connectedAt": 1, "lastActiveAt": 1}
        )
    )

    # Enrich with backup stats per session
    for s in sessions:
        uid = s.get("userId")
        s["backupStats"] = {
            "contacts": db["wa_contact_backups"].count_documents({"userId": uid}),
            "groups": db["wa_group_backups"].count_documents({"userId": uid}),
        }
        last_log = db["wa_backup_log"].find_one(
            {"userId": uid}, sort=[("createdAt", -1)]
        )
        if last_log:
            s["backupStats"]["lastBackup"] = last_log.get("createdAt")
            s["backupStats"]["lastResults"] = last_log.get("results")
        else:
            s["backupStats"]["lastBackup"] = None

    return jsonify({"sessions": sessions, "total": len(sessions)})


# ===========================================================================
# Sidecar Status & Reconnect (Super Admin)
# The sidecar now runs as a separate Fly app (samaj-wa-web). No local
# process management needed — just proxy status/reconnect calls.
# ===========================================================================


@wa_web_bp.route("/sidecar/status", methods=["GET"])
@_require_super_admin
def sidecar_status():
    """Get sidecar health + live per-session status."""
    try:
        resp = http_requests.get(
            wa._url("/api/sidecar/status"),
            headers=wa._headers(),
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        return jsonify(data)
    except Exception as e:
        return jsonify({
            "health": "unavailable",
            "error": str(e),
            "activeSessions": 0,
            "sessions": [],
        }), 200


@wa_web_bp.route("/sidecar/reconnect/<user_id>", methods=["POST"])
@_require_super_admin
def sidecar_reconnect(user_id):
    """Reconnect a specific WhatsApp session using stored auth state."""
    try:
        resp = http_requests.post(
            wa._url(f"/api/sidecar/reconnect/{user_id}"),
            headers=wa._headers(),
            timeout=10,
        )
        resp.raise_for_status()
        return jsonify(resp.json())
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@wa_web_bp.route("/sidecar/reconnect-all", methods=["POST"])
@_require_super_admin
def sidecar_reconnect_all():
    """Reconnect all WhatsApp sessions using stored auth state."""
    try:
        resp = http_requests.post(
            wa._url("/api/sidecar/reconnect-all"),
            headers=wa._headers(),
            timeout=10,
        )
        resp.raise_for_status()
        return jsonify(resp.json())
    except Exception as e:
        return jsonify({"error": str(e)}), 500
