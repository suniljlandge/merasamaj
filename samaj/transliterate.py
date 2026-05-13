import re
import requests

GOOGLE_INPUT_URL = "https://inputtools.google.com/request"

LANG_MAP = {
    "mr": "mr-t-i0-und",
    "hi": "hi-t-i0-und",
}


def clean_text(value=""):
    return re.sub(r"\s+", " ", str(value or "").strip())


def transliteration_suggestions(text, lang="mr", limit=5):
    text = clean_text(text)

    if not text:
        return []

    try:
        response = requests.get(
            GOOGLE_INPUT_URL,
            params={
                "text": text,
                "itc": LANG_MAP.get(lang, "mr-t-i0-und"),
                "num": limit,
            },
            timeout=10,
        )

        data = response.json()

        if (
            isinstance(data, list)
            and len(data) > 1
            and data[0] == "SUCCESS"
        ):
            return data[1][0][1]

    except Exception as e:
        print("Transliteration error:", e)

    return []


def transliterate_to_marathi(text, overrides=None):
    text = clean_text(text)

    if not text:
        return ""

    normalized = text.lower()

    if overrides and normalized in overrides:
        return overrides[normalized]

    suggestions = transliteration_suggestions(text)

    if suggestions:
        return suggestions[0]

    return text