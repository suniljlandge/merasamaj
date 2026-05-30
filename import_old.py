import json
import requests


def load_json_records(path):

    with open(
        path,
        "r",
        encoding="utf-8"
    ) as file:

        content = file.read().strip()

    # CASE 1:
    # Proper JSON array

    if content.startswith("["):
        return json.loads(content)

    # CASE 2:
    # JSON lines / NDJSON

    records = []

    for line in content.splitlines():

        line = line.strip()

        if not line:
            continue

        try:
            records.append(
                json.loads(line)
            )

        except Exception as error:

            print(
                "Skipping invalid line:"
            )

            print(line[:120])

            print(error)

    return records


data = load_json_records(
    "old_data.json"
)

print(
    f"Loaded {len(data)} records"
)

response = requests.post(
    "http://localhost:5000/api/bulk-import",
    json=data,
)

print()
print("STATUS:", response.status_code)

try:
    print(
        json.dumps(
            response.json(),
            indent=2,
            ensure_ascii=False
        )
    )

except Exception:
    print(response.text)