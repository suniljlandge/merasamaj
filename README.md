# SAMAJ Registration

Flask + MongoDB web app for bilingual family registration records. English entries auto-fill Marathi fields, and every Marathi field can be manually edited before saving.

## Run

```powershell
python -m pip install -r requirements.txt
python run.py
```

The app defaults to:

- URL: `http://127.0.0.1:5000`
- MongoDB URI: `mongodb://127.0.0.1:27017`
- Database: `samaj`
- Collection: `registrations`
- Correction collection: `transliteration_corrections`

Override with `MONGO_URI`, `MONGO_DB`, `MONGO_COLLECTION`, `MONGO_CORRECTIONS_COLLECTION`, or `PORT`.

## AI4Bharat IndicXlit Suggestions

The Marathi suggestion dropdown works without extra packages, then uses the Adhikari-Ashutosh IndicXlit fork automatically when installed:

```powershell
python -m pip install "setuptools<81" wheel
python -m pip install --no-build-isolation -r requirements-ai4bharat.txt
```

If IndicXlit is unavailable, the app falls back to built-in rules and learned corrections.
This repo uses the fork because its package metadata removes the `fairseq` inference dependency from the official PyPI package.

## Deploy on Render

This repo includes `render.yaml` for a Render Web Service.

1. Push the repo to GitHub.
2. In Render, create a new Blueprint or Web Service from the repo.
3. Set `MONGO_URI` as a secret environment variable. MongoDB Atlas is the easiest hosted MongoDB option.
4. Deploy.

Render will use:

- Python version: `.python-version`
- Build command: `pip install -r requirements.txt`
- Start command: `gunicorn run:app`

Keep `requirements-ai4bharat.txt` out of the main Render build unless you want to install the model package directly in the web app. The deployed app still works without it and falls back to learned corrections plus built-in suggestions.

## Deploy IndicXlit on Render

The repo also includes a Dockerized IndicXlit service under `services/indicxlit`.

`render.yaml` defines two services:

- `samaj-webapp`: main Flask registration app
- `samaj-indicxlit`: Docker service running the Adhikari-Ashutosh IndicXlit fork

The web app calls the model service through `INDICXLIT_URL`. If your Render service URL differs from `https://samaj-indicxlit.onrender.com`, update that env var in Render.

Local Docker build command:

```powershell
docker build -f services/indicxlit/Dockerfile -t samaj-indicxlit:local .
docker run --rm -p 10000:10000 samaj-indicxlit:local
```

Test it:

```powershell
Invoke-WebRequest "http://127.0.0.1:10000/suggest?q=washim&lang=mr&topk=5" -UseBasicParsing
```

The IndicXlit image installs the fork directly from GitHub at a pinned commit and does not install `fairseq`.

## Marathi Corrections

The app starts with a few built-in common spellings, then learns from manual edits. If a user types an English value and changes the Marathi value before saving, the correction is stored in MongoDB and reused for future auto-fill.

## Verify

```powershell
python -m unittest discover -s tests
python -m compileall -q samaj tests run.py
```
