from datetime import datetime, timezone

from .registration import MEMBER_TEXT_FIELDS, TEXT_FIELDS, clean_text

MAX_CORRECTIONS = 10000


def load_corrections(collection, limit=MAX_CORRECTIONS):
    if collection is None:
        return {}

    cursor = collection.find({}, {"source": 1, "target": 1, "_id": 0}).sort("source", 1).limit(limit)
    corrections = {}

    for item in cursor:
        source = normalize_source(item.get("source"))
        target = clean_text(item.get("target"))
        if source and target:
            corrections[source] = target

    return corrections


def collect_transliteration_corrections(payload, current_overrides=None):
    corrections = {}

    for field in TEXT_FIELDS:
        _collect_bilingual_correction(corrections, payload.get(field["key"], {}))

    for member in payload.get("familyMembers") or []:
        for field in MEMBER_TEXT_FIELDS:
            _collect_bilingual_correction(corrections, member.get(field["key"], {}))

    return corrections


def save_corrections(collection, corrections, now=None):
    if collection is None or not corrections:
        return 0

    timestamp = now or datetime.now(timezone.utc)

    for source, target in corrections.items():
        collection.replace_one(
            {"source": source},
            {"source": source, "target": target, "updatedAt": timestamp},
            upsert=True,
        )

    return len(corrections)


def normalize_source(value):
    return " ".join(clean_text(value).lower().split())


def _collect_bilingual_correction(corrections, value):
    if not isinstance(value, dict):
        return

    english = clean_text(value.get("en") or value.get("english") or "")
    marathi = clean_text(value.get("mr") or value.get("marathi") or "")
    source = normalize_source(english)

    if not source or not marathi:
        return

    corrections[source] = marathi