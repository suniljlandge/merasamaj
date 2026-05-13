from flask import Flask, jsonify, request
import requests

app = Flask(__name__)
app.json.ensure_ascii = False

LANG_MAP = {
    "mr": "mr-t-i0-und",
    "hi": "hi-t-i0-und",
    "ta": "ta-t-i0-und",
    "te": "te-t-i0-und",
}

@app.get("/health")
def health():
    return jsonify({"ok": True})

@app.get("/suggest")
def suggest():
    text = request.args.get("q", "").strip()
    lang = request.args.get("lang", "mr")

    if not text:
        return jsonify({"suggestions": []})

    itc = LANG_MAP.get(lang, "mr-t-i0-und")

    url = "https://inputtools.google.com/request"

    response = requests.get(url, params={
        "text": text,
        "itc": itc,
        "num": 5
    }, timeout=10)

    data = response.json()

    suggestions = []

    if data[0] == "SUCCESS":
        suggestions = data[1][0][1]

    return jsonify({"suggestions": suggestions})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=10000)