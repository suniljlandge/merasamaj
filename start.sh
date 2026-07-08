#!/bin/sh
# Start the WhatsApp Web sidecar in the background, detached from Gunicorn's
# process group so Gunicorn worker restarts (--max-requests) don't kill it.
# setsid runs the process in a new session, fully detaching it.
setsid node /app/whatsapp-web/src/index.js >> /tmp/sidecar.log 2>&1 &
SIDECAR_PID=$!
echo "Sidecar started (PID $SIDECAR_PID)"

# Wait for the sidecar to be fully ready (MongoDB connected) before starting Flask.
# Atlas DNS resolution + TLS handshake can take 5-15s on cold start.
echo "Waiting for sidecar to be ready..."
MAX_WAIT=60
WAITED=0
while [ $WAITED -lt $MAX_WAIT ]; do
  STATUS=$(node -e "
    require('http').get('http://localhost:3001/health', function(r) {
      var d = '';
      r.on('data', function(c) { d += c; });
      r.on('end', function() {
        try { var j = JSON.parse(d); process.stdout.write(j.status || 'unknown'); } catch(e) { process.stdout.write('unknown'); }
        process.exit(0);
      });
    }).on('error', function() { process.stdout.write('down'); process.exit(0); });
  " 2>/dev/null)
  if [ "$STATUS" = "ok" ]; then
    echo "Sidecar ready (status: ok)"
    break
  fi
  echo "Sidecar status: ${STATUS:-down}, waiting..."
  sleep 3
  WAITED=$((WAITED + 3))
done

if [ $WAITED -ge $MAX_WAIT ]; then
  echo "Warning: sidecar did not reach 'ok' within ${MAX_WAIT}s, starting Flask anyway"
fi

# Start the Flask app (Gunicorn) in the foreground
cd /app
exec gunicorn --workers=1 --threads=8 --timeout=800 --max-requests=800 --max-requests-jitter=25 -b 0.0.0.0:8080 app:app
