#!/bin/sh
# Start the Flask app (Gunicorn) — WhatsApp Web sidecar runs as a separate Fly app.
cd /app
exec gunicorn --workers=1 --threads=8 --timeout=800 --max-requests=800 --max-requests-jitter=25 -b 0.0.0.0:8080 app:app
