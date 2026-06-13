FROM python:3.12-slim

WORKDIR /app

# Noto Sans Devanagari font + FriBiDi so the rasterized PDF export renders
# Marathi correctly. Pillow's Linux wheel bundles raqm/HarfBuzz, but raqm only
# activates when FriBiDi is present on the system.
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-noto-core libfribidi0 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["python", "app.py"]