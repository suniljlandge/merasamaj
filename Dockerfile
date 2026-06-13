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

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["python", "app.py"]