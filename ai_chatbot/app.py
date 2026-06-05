from flask import Flask, render_template
from dotenv import load_dotenv
import os

from backend.routes import bp as chatbot_bp

load_dotenv()

def create_app() -> Flask:
    app = Flask(__name__, template_folder="templates", static_folder="static")
    app.config["SECRET_KEY"] = os.getenv("SECRET_KEY", "dev-secret-key-change-me")
    app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024
    app.register_blueprint(chatbot_bp)
    return app

app = create_app()

@app.route("/")
def home():
    return render_template("index.html")

if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=os.getenv("FLASK_ENV") != "production")
