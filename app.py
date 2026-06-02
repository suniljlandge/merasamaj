import os
from dotenv import load_dotenv
from flask import session, redirect
from flask_session import Session
import bcrypt

load_dotenv()

from samaj.app import create_app

app = create_app()


app.config["SECRET_KEY"] = "change-this-secret"

Session(app)

if __name__ == "__main__":
    debug = os.getenv("FLASK_DEBUG", "0") == "1"
    app.run(host="127.0.0.1", port=int(os.getenv("PORT", "5000")), debug=debug)
