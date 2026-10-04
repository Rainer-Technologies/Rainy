<p align="center">
  <img src="static/icons/icon-512.png" alt="Rainy" width="120" height="120">
</p>

# Rainy

![Python](https://img.shields.io/badge/Python-3.11%2B-3776AB?logo=python&logoColor=white)
![Flask](https://img.shields.io/badge/Flask-3-000000?logo=flask&logoColor=white)
![MySQL](https://img.shields.io/badge/MySQL-8.4-4479A1?logo=mysql&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)
![PWA](https://img.shields.io/badge/PWA-installable-5A0FC8?logo=pwa&logoColor=white)
![CUDA](https://img.shields.io/badge/CUDA-optional-76B900?logo=nvidia&logoColor=white)
[![License: MIT](https://img.shields.io/badge/License-MIT-green)](LICENSE)

**Your music, your server.**

Rainy brings your library and playlists to a self-hosted web player, with support for multiple users and a music-driven fullscreen light show.

## Setup

### Docker Compose (recommended)

Requires Git and Docker with the Compose plugin. The stack includes Rainy, MySQL, ffmpeg and Deno.

```sh
git clone https://github.com/Ferripro321/Rainy.git
cd Rainy
cp .env.example .env
```

Edit `.env` before starting:

| Setting | Value |
| --- | --- |
| `FLASK_SECRET_KEY` | A random session key of at least 32 characters |
| `MYSQL_PASSWORD` | A strong password for Rainy's database user |
| `MYSQL_ROOT_PASSWORD` | A separate strong password for MySQL root |
| `MUSIC_LIBRARY_PATH` | An absolute path to your music folder, or `./music` for an empty library |

Generate a session key with Docker and paste the output into `FLASK_SECRET_KEY`:

```sh
docker run --rm python:3.12-slim python -c "import secrets; print(secrets.token_hex(32))"
```

**CPU-only hosts:** remove the entire `deploy:` block under `app` in [compose.yaml](compose.yaml) before starting. It requests NVIDIA GPUs by default and prevents startup on hosts without the NVIDIA Container Toolkit. Rainy supports CPU analysis; GPU setup is optional and covered in [docs/GPU.md](docs/GPU.md).

```sh
docker compose up --build -d
```

Open <http://localhost:6969> and complete the setup form to create the administrator account. Enter **`/music`** as the library path: this is the container path mapped to `MUSIC_LIBRARY_PATH` on your host.

Run **Quick Scan** under **Settings → Maintenance** to index existing files. You can also upload music through the player.

### Without Docker (SQLite)

Requires Python 3.11+ and ffmpeg on your `PATH`. YouTube imports also need a JavaScript runtime: Deno, Node.js or Bun.

Clone the repository and enter `Rainy` as above, then create a virtual environment and install the dependencies.

**Linux / macOS:**

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
cp .env.example .env
```

**Windows (Command Prompt):**

```bat
py -m venv .venv
.venv\Scripts\activate
python -m pip install -r requirements.txt
copy .env.example .env
```

In `.env`, uncomment `RAINY_DB=sqlite` and set `FLASK_SECRET_KEY` to the output of:

```sh
python -c "import secrets; print(secrets.token_hex(32))"
```

Explicitly selecting SQLite overrides the `MYSQL_*` values in the example file. Rainy creates `data/rainy.db` on first start; no database server is needed.

Start the player:

```sh
mkdir music
python app.py
```

Open <http://localhost:6969>, create the administrator account and enter the absolute path to your music folder. The folder must already exist. If you created `music` above, use its absolute path. Run **Settings → Maintenance → Quick Scan** to index it.

For an existing MySQL 8 installation, set `RAINY_DB=mysql` and configure `MYSQL_HOST`, `MYSQL_USER`, `MYSQL_PASSWORD` and `MYSQL_DATABASE` instead. The database user needs permission to create and migrate tables in that database; provision it beforehand if the user cannot create databases.

The launchers `./start.sh` (Linux/macOS) and `start.bat` (Windows) handle the virtual environment and dependency installation on subsequent starts. On Linux/macOS, `./start.sh --gunicorn` runs Rainy with Gunicorn for a persistent server.

## Configuration

Start with [.env.example](.env.example). These are the main settings beyond the credentials above:

| Setting | Default | Purpose |
| --- | --- | --- |
| `RAINY_PORT` | `6969` | Host port published by Docker Compose |
| `RAINY_HTTP_PORT` | `6969` | Port when running `python app.py` |
| `RAINY_DB` | MySQL when `MYSQL_*` is configured; otherwise SQLite | Database backend (`mysql` or `sqlite`) |
| `SQLITE_PATH` | `data/rainy.db` | SQLite file path, relative to the project root |
| `RAINY_LIGHTSHOW_DEVICE` | `auto` | Analysis device: `auto`, `cpu`, `cuda` or `cuda:N` |
| `RAINY_LIGHTSHOW_THREADS` | CPU cores, capped at 8 | CPU threads for light show analysis |
| `LASTFM_API_KEY` | Unset | Optional Last.fm metadata enrichment |
| `RAINY_DEV` | Off | Local development mode; enables the debugger and allows a temporary session key |

For local runs, settings are loaded from `.env`. With Docker, Compose only passes the variables listed in `app.environment`; add any extra application settings there. The host `.env` is excluded from the image. Restart Rainy after changing settings; with Compose, run `docker compose up -d` to apply environment changes.

For access from another device on your network, use `http://<server-ip>:6969` (or your configured port). Use HTTPS through a reverse proxy for remote access. Chromecast needs Chrome or another Chromium browser and a secure origin such as HTTPS or `localhost`; the in-app **Chromecast Setup** page has further instructions.

## Running and updating

Run these commands from the repository directory:

```sh
docker compose logs -f app     # Follow application logs
docker compose down           # Stop the stack; keep the database and music
git pull                      # Get updates
docker compose up --build -d   # Rebuild and start
```

MySQL data is stored in the `mysql_data` Docker volume. Music stays in the host folder selected by `MUSIC_LIBRARY_PATH`. For SQLite installs, preserve `data/rainy.db` (or your custom `SQLITE_PATH`). Back up the database, music folder and `.env` before updating. Avoid `docker compose down -v` unless you intend to delete the database volume.

## Features

- **Library:** MP3, FLAC, WAV, OGG, M4A, AAC and WMA; tag and cover extraction, metadata editing and duplicate detection.
- **Playback:** crossfade, equalizer, playback speed, A–B repeat, sleep timer, keyboard shortcuts and media controls.
- **Discovery:** personalised mixes, radio, mood mixes and listening history, using local audio analysis.
- **Imports:** YouTube and YouTube Music downloads, public Spotify playlist imports and scheduled playlist syncs.
- **Sharing and devices:** multiple accounts, friends, shared playlists, Rainy Connect remote control, Chromecast and an installable PWA.
- **Fullscreen player:** synced lyrics and a music-driven light show, with optional GPU acceleration. See [GPU setup](docs/GPU.md).

## Troubleshooting

| Problem | Check |
| --- | --- |
| Startup fails because a secret or password is missing | Set `FLASK_SECRET_KEY` and the database passwords in `.env`; the session key must be at least 32 characters. |
| Compose reports that it cannot select the NVIDIA device driver | Remove `app.deploy` from `compose.yaml` on a CPU-only host. |
| Local startup tries to connect to MySQL | Set `RAINY_DB=sqlite` explicitly if you want SQLite. |
| Setup rejects the music path, or scanning finds nothing | Use `/music` in Docker and an existing absolute path locally. Check the folder contents and permissions. |
| YouTube imports fail | Check ffmpeg and the JS runtime, then use **Settings → Maintenance → Update now** under **YouTube Downloader**. |
| GPU analysis is unavailable | Check the `[lightshow-accel] analysis device:` log message and [GPU troubleshooting](docs/GPU.md#troubleshooting). |

## Development

The backend uses Flask with MySQL or SQLite. The frontend uses vanilla JavaScript modules and custom elements, with no build step. See [AGENTS.md](AGENTS.md) for component conventions.

From an activated virtual environment:

```sh
python -m pip install pytest soundfile
pytest
node --test tests/js/*.test.mjs
```

Backend tests import the application and require a configured session key and database. Run against a separate test database; several tests expect user and song ID `1` to exist. You can select a separate SQLite file with `RAINY_DB=sqlite` and `SQLITE_PATH`.

## License

Rainy uses the [MIT License](LICENSE). Dependency and model licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Only import music you own or have permission to download. Rainy is not affiliated with YouTube, Google, Spotify, Last.fm or MusicBrainz.
