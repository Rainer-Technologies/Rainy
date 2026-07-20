# Rainy

## Run with Docker

1. Create the Compose environment file and replace its placeholder secrets:

   ```sh
   cp .env.example .env
   ```

2. Optionally set `MUSIC_LIBRARY_PATH` in `.env` to the absolute path of an existing music library. The default, `./music`, creates a library directory beside this file.

3. Start Rainy:

   ```sh
   docker compose up --build -d
   ```

   Open `http://localhost:6969`, complete the initial setup, and enter `/music` as the music-library path. This is the path inside the container; it maps to `MUSIC_LIBRARY_PATH` on the host.

The MySQL database is retained in the named `mysql_data` Docker volume. The music directory is mounted from the host, so uploads, downloads, cover art, and scanned files persist across container rebuilds.

Use `docker compose logs -f`, `docker compose down`, and `docker compose down -v` to inspect logs, stop the stack, and stop it while deleting the database volume, respectively. The last command does not delete the host music directory.
