FROM python:3.12-slim

WORKDIR /app

# Fonts + FriBiDi for the rasterized PDF export:
#  - fonts-noto-core    : Noto Sans Devanagari (Marathi glyphs)
#  - fonts-dejavu-core  : DejaVu Sans (Latin; the Devanagari face has no Latin)
#  - libfribidi0        : enables Pillow's bundled raqm/HarfBuzz shaping
# Node.js 20 for the WhatsApp Web sidecar:
#  - curl + ca-certificates for NodeSource setup
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        fonts-noto-core fonts-dejavu-core libfribidi0 \
        curl ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Node.js sidecar dependencies
COPY whatsapp-web/package.json whatsapp-web/package-lock.json* ./whatsapp-web/
RUN cd whatsapp-web && npm ci --omit=dev

# Copy all source
COPY . .

# Create auth-sessions directory for WhatsApp session persistence
RUN mkdir -p /app/whatsapp-web/auth-sessions

# Start script: launches both sidecar and Flask
COPY start.sh .
RUN chmod +x start.sh

CMD ["./start.sh"]