import requests
import os

GRAPH_URL = f"https://graph.facebook.com/v24.0/{os.getenv('WA_PHONE_ID')}/messages"
TOKEN = os.getenv("WA_TOKEN")

def send_template_graph(
    to,
    template_name,
    language,
    body_vars,
    header_type=None,
    header_url=None
):
    components = []

    if header_type:
        components.append({
            "type": "header",
            "parameters": [{
                "type": header_type,
                header_type: { "link": header_url }
            }]
        })

    if body_vars:
        components.append({
            "type": "body",
            "parameters": [
                { "type": "text", "text": v } for v in body_vars
            ]
        })

    payload = {
        "messaging_product": "whatsapp",
        "to": to,
        "type": "template",
        "template": {
            "name": template_name,
            "language": { "code": language },
            "components": components
        }
    }

    res = requests.post(
        GRAPH_URL,
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "application/json"
        },
        json=payload,
        timeout=10
    )

    return res.json(), res.status_code
