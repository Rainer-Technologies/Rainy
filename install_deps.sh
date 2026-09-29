#!/bin/bash
cd /opt/data/Rainy
uv pip install --python .venv/bin/python flask flask-cors gunicorn python-dotenv mysql-connector-python bcrypt mutagen requests ytmusicapi "yt-dlp[default]"
echo "INSTALL_DONE exit=$?"
