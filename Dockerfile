FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# ffmpeg is required by yt-dlp for downloading and processing audio.
# fpcalc (Chromaprint) powers acoustic-fingerprint duplicate detection.
RUN apt-get update -qq >/dev/null \
    && apt-get install --no-install-recommends -y -qq ffmpeg libchromaprint-tools >/dev/null \
    && rm -rf /var/lib/apt/lists/*

# Deno: the JavaScript runtime yt-dlp uses to solve YouTube's player
# challenges. Without one, most formats fail with HTTP 403.
COPY --from=denoland/deno:bin /deno /usr/local/bin/deno

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . ./
RUN chmod +x /app/docker-entrypoint.sh

EXPOSE 6969

ENTRYPOINT ["/app/docker-entrypoint.sh"]
# Threads: every Rainy Connect device holds one request open (its command
# stream), on top of the audio streams, so a handful per worker is not enough.
CMD ["gunicorn", "--bind", "0.0.0.0:6969", "--workers", "2", "--threads", "16", "--timeout", "120", "app:app"]
