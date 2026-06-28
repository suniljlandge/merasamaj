"""
WhatsApp Web Integration Module for SAMAJ.

Communicates with the Node.js WhatsApp Web sidecar service to provide:
- OTP-based WhatsApp session login
- Contact/group backup management
- Profile picture retrieval
- Hybrid message routing (Web session vs Cloud API)

The sidecar runs on a configurable port (default 3001) and is authenticated
via a shared API secret.
"""

import os
import requests
from typing import Optional

# Sidecar configuration
WA_WEB_BASE_URL = os.getenv("WA_WEB_SERVICE_URL", "http://localhost:3001")
WA_WEB_API_SECRET = os.getenv("WA_WEB_API_SECRET", "change-this-to-a-random-secret")

# Request timeout for sidecar calls
_TIMEOUT = 15


def _headers():
    """Standard headers for sidecar API calls."""
    return {
        "Content-Type": "application/json",
        "X-API-Secret": WA_WEB_API_SECRET,
    }


def _url(path: str) -> str:
    """Build full URL for a sidecar endpoint."""
    return f"{WA_WEB_BASE_URL}{path}"


# ===========================================================================
# Health Check
# ===========================================================================


def is_service_available() -> bool:
    """Check if the WhatsApp Web sidecar service is running.
    Retries briefly on cold start since the sidecar may still be booting."""
    for attempt in range(3):
        try:
            resp = requests.get(f"{WA_WEB_BASE_URL}/health", timeout=5)
            if resp.ok and resp.json().get("status") in ("ok", "starting"):
                return True
        except (requests.ConnectionError, requests.Timeout):
            pass
        if attempt < 2:
            import time
            time.sleep(2)
    return False


# ===========================================================================
# Session Management
# ===========================================================================


def connect_session(user_id: str, phone_number: str) -> dict:
    """
    Initiate OTP-based WhatsApp login for a user.

    Args:
        user_id: The SAMAJ user ID (MongoDB ObjectId string).
        phone_number: Phone number with country code (e.g., "919876543210").

    Returns:
        dict with keys:
            - pairingCode: 8-character code to enter on phone (or None if already auth'd)
            - status: Connection status string
            - message: Human-readable instructions
    """
    resp = requests.post(
        _url("/api/session/connect"),
        headers=_headers(),
        json={"userId": user_id, "phoneNumber": phone_number},
        timeout=_TIMEOUT,
    )
    resp.raise_for_status()
    return resp.json()


def get_session_status(user_id: str) -> dict:
    """
    Get the current WhatsApp session status for a user.

    Returns:
        dict with keys: userId, status (connected|connecting|reconnecting|disconnected)
    """
    resp = requests.get(
        _url(f"/api/session/status/{user_id}"),
        headers=_headers(),
        timeout=_TIMEOUT,
    )
    resp.raise_for_status()
    return resp.json()


def disconnect_session(user_id: str) -> dict:
    """Disconnect and log out a user's WhatsApp Web session."""
    resp = requests.post(
        _url("/api/session/disconnect"),
        headers=_headers(),
        json={"userId": user_id},
        timeout=_TIMEOUT,
    )
    resp.raise_for_status()
    return resp.json()


# ===========================================================================
# Messaging (Hybrid Routing)
# ===========================================================================


def decide_route(
    user_id: str,
    recipient_phone: str,
    message_type: str = "personal",
    recipient_count: int = 1,
) -> dict:
    """
    Decide whether a message should route via Web session or Cloud API.

    Args:
        user_id: Sender's user ID.
        recipient_phone: Recipient phone (91XXXXXXXXXX format).
        message_type: "personal", "campaign", or "broadcast".
        recipient_count: Number of recipients (>1 forces Cloud API).

    Returns:
        dict with keys:
            - channel: "web" or "cloud_api"
            - reason: Explanation for the routing decision
    """
    resp = requests.post(
        _url("/api/route/decide"),
        headers=_headers(),
        json={
            "userId": user_id,
            "recipientPhone": recipient_phone,
            "messageType": message_type,
            "recipientCount": recipient_count,
        },
        timeout=_TIMEOUT,
    )
    resp.raise_for_status()
    return resp.json()


def send_personal_message(
    user_id: str, recipient_phone: str, text: str
) -> dict:
    """
    Send a personal follow-up message via WhatsApp Web session.

    Falls back to Cloud API if daily limit is reached (indicated by 429 response).

    Args:
        user_id: Sender's user ID.
        recipient_phone: Recipient phone number.
        text: Message text content.

    Returns:
        dict with success status, or error with fallbackToCloudAPI flag.

    Raises:
        requests.HTTPError: On non-429 server errors.
    """
    resp = requests.post(
        _url("/api/message/send"),
        headers=_headers(),
        json={
            "userId": user_id,
            "recipientPhone": recipient_phone,
            "text": text,
        },
        timeout=_TIMEOUT,
    )

    if resp.status_code == 429:
        # Daily limit reached — caller should use Cloud API
        return resp.json()

    resp.raise_for_status()
    return resp.json()


def get_daily_send_stats(user_id: str) -> dict:
    """
    Get today's message send stats (for UI display).

    Returns:
        dict with keys: sent, limit, remaining
    """
    resp = requests.get(
        _url(f"/api/message/daily-stats/{user_id}"),
        headers=_headers(),
        timeout=_TIMEOUT,
    )
    resp.raise_for_status()
    return resp.json()


def send_media_message(
    user_id: str, recipient_phone: str, caption: str,
    media_url: str, media_type: str
) -> dict:
    """
    Send a media message (image/video/document) via WhatsApp Web session.

    Args:
        user_id: Sender's user ID.
        recipient_phone: Recipient phone number.
        caption: Text caption for the media.
        media_url: URL of the media file to send.
        media_type: One of 'image', 'video', 'document'.

    Returns:
        dict with success status.
    """
    resp = requests.post(
        _url("/api/message/send-media"),
        headers=_headers(),
        json={
            "userId": user_id,
            "recipientPhone": recipient_phone,
            "caption": caption,
            "mediaUrl": media_url,
            "mediaType": media_type,
        },
        timeout=30,
    )

    if resp.status_code == 429:
        return resp.json()

    resp.raise_for_status()
    return resp.json()


# ===========================================================================
# Backup Management
# ===========================================================================


def trigger_backup(user_id: str, include_profile_pics: bool = True) -> dict:
    """
    Start a contact + group backup in the background.

    Args:
        user_id: User ID with an active WhatsApp session.
        include_profile_pics: Whether to also backup profile pictures to R2.

    Returns:
        dict with success status and message.
    """
    resp = requests.post(
        _url("/api/backup/run"),
        headers=_headers(),
        json={"userId": user_id, "includeProfilePics": include_profile_pics},
        timeout=_TIMEOUT,
    )
    resp.raise_for_status()
    return resp.json()


def get_backup_status(user_id: str) -> dict:
    """
    Get backup status and stats for a user.

    Returns:
        dict with keys: lastBackup, totalContacts, totalGroups
    """
    resp = requests.get(
        _url(f"/api/backup/status/{user_id}"),
        headers=_headers(),
        timeout=_TIMEOUT,
    )
    resp.raise_for_status()
    return resp.json()


def is_backup_running(user_id: str) -> bool:
    """Check if a backup is currently in progress for a user."""
    try:
        resp = requests.get(
            _url(f"/api/backup/running/{user_id}"),
            headers=_headers(),
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        return resp.json().get("running", False)
    except Exception:
        return False


def export_contacts(user_id: str, format: str = "json"):
    """
    Export backed-up contacts.

    Args:
        user_id: User ID.
        format: "json" or "csv".

    Returns:
        JSON list of contacts, or raw CSV string.
    """
    resp = requests.get(
        _url(f"/api/backup/contacts/{user_id}"),
        headers=_headers(),
        params={"format": format},
        timeout=30,
    )
    resp.raise_for_status()

    if format == "csv":
        return resp.text
    return resp.json()


def get_profile_pic_url(user_id: str, phone: str) -> Optional[str]:
    """
    Get a signed URL for a contact's backed-up profile picture.

    Args:
        user_id: User ID.
        phone: Contact phone number (91XXXXXXXXXX).

    Returns:
        Signed URL string (expires in 1 hour), or None if not available.
    """
    resp = requests.get(
        _url(f"/api/backup/profile-pic/{user_id}/{phone}"),
        headers=_headers(),
        timeout=_TIMEOUT,
    )

    if resp.status_code == 404:
        return None

    resp.raise_for_status()
    return resp.json().get("url")


def get_profile_pic_history(user_id: str, phone: str) -> list:
    """
    Get all historical profile pictures for a contact (newest first).

    Args:
        user_id: User ID.
        phone: Contact phone number (91XXXXXXXXXX).

    Returns:
        List of dicts with 'url' and 'capturedAt' keys.
    """
    resp = requests.get(
        _url(f"/api/backup/profile-pic-history/{user_id}/{phone}"),
        headers=_headers(),
        timeout=_TIMEOUT,
    )
    resp.raise_for_status()
    return resp.json().get("history", [])


def get_profile_pics_batch(user_id: str, phones: list) -> dict:
    """
    Get signed URLs for multiple contacts' profile pictures in one call.

    Args:
        user_id: User ID.
        phones: List of phone numbers.

    Returns:
        Dict mapping phone -> signed URL.
    """
    resp = requests.post(
        _url("/api/backup/profile-pics-batch"),
        headers=_headers(),
        json={"userId": user_id, "phones": phones},
        timeout=_TIMEOUT,
    )
    resp.raise_for_status()
    return resp.json().get("urls", {})
