#!/bin/sh
# Start the WhatsApp Web sidecar in the background
cd /app/whatsapp-web
node src/index.js &
SIDECAR_PID=$!

# Give the sidecar a moment to start
sleep 2

# Start the Flask app (Gunicorn) in the foreground
cd /app
exec gunicorn --workers=1 --threads=8 --timeout=800 --max-requests=800 --max-requests-jitter=25 -b 0.0.0.0:8080 app:app
