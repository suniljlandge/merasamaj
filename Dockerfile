FROM python:3.12-slim

WORKDIR /app

# Fonts + FriBiDi for the rasterized PDF export:
#  - fonts-noto-core    : Noto Sans Devanagari (Marathi glyphs)
#  - fonts-dejavu-core  : DejaVu Sans (Latin; the Devanagari face has no Latin)
#  - libfribidi0        : enables Pillow's bundled raqm/HarfBuzz shaping
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        fonts-noto-core fonts-dejavu-core libfribidi0 \
    && rm -rf /var/lib/apt/lists/*

# Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy all source
COPY . .

# Start script: launches Flask via Gunicorn
COPY start.sh .
RUN chmod +x start.sh

CMD ["./start.sh"]