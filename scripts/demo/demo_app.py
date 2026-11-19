# Tiny Flask app for the demo video's Task B check:
#   flask --app scripts/demo/demo_app.py config
# The values below are fake and exist only to show that keys containing SECRET,
# PASSWORD, TOKEN or KEY are printed as "***".
from flask import Flask

app = Flask(__name__)
app.config.update(
    SECRET_KEY="demo-not-a-real-secret",
    DATABASE_PASSWORD="demo-not-a-real-password",
    API_TOKEN="demo-not-a-real-token",
    MAX_ITEMS=50,
    SITE_NAME="Moon demo",
)
