from datetime import datetime, timezone
import requests

from samaj.db import create_collections

CONFIG = {
    "MONGO_URI": "mongodb://127.0.0.1:27017",
    "MONGO_DB": "samaj",
    "MONGO_COLLECTION": "registrations",
    "MONGO_CORRECTIONS_COLLECTION": "transliteration_corrections",
}

OVERPASS_URL = "https://overpass-api.de/api/interpreter"

QUERY = """
[out:json][timeout:120];

area["name"="Washim District"]->.searchArea;

(
  node(area.searchArea)["name"];
  way(area.searchArea)["name"];
  relation(area.searchArea)["name"];
);

out tags;
"""


def normalize(text):
    return " ".join(str(text).strip().lower().split())


def transliterate(name):
    """
    Uses your existing Google-based transliteration endpoint logic.
    Replace later if you want custom Hindi generation.
    """
    try:
        from samaj.transliterate import transliterate_to_marathi
        return transliterate_to_marathi(name)
    except Exception:
        return name


def main():

    print("Connecting MongoDB...")

    client, _, correction_collection = create_collections(CONFIG)

    print("Downloading OSM data...")

    response = requests.get(
        OVERPASS_URL,
        params={"data": QUERY},
        timeout=180,
    )

    response.raise_for_status()

    data = response.json()

    elements = data.get("elements", [])

    unique_names = set()

    for item in elements:

        tags = item.get("tags", {})

        name = tags.get("name")

        if not name:
            continue

        name = normalize(name)

        if len(name) < 2:
            continue

        unique_names.add(name)

    print(f"Found {len(unique_names)} unique landmarks")

    now = datetime.now(timezone.utc)

    inserted = 0

    for source in sorted(unique_names):

        target = transliterate(source)

        if not target:
            continue

        correction_collection.replace_one(
            {"source": source},
            {
                "source": source,
                "target": target,
                "updatedAt": now,
                "sourceType": "osm_washim",
            },
            upsert=True,
        )

        inserted += 1

        if inserted % 100 == 0:
            print(f"{inserted} imported...")

    print()
    print(f"Imported {inserted} landmarks")

    client.close()


if __name__ == "__main__":
    main()