"""Backfill song fingerprints (sha256 + chromaprint) for songs that lack them.

One-time / re-runnable: processes every song row without a fingerprint entry,
using a small process pool (fpcalc is a subprocess, CPU-light per core).
Prints progress every N songs.

Usage:
    .venv/bin/python scripts/backfill_fingerprints.py [--workers 4] [--limit N]
"""
import argparse
import hashlib
import json
import os
import shutil
import sys
import subprocess

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from models.database import Database  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FPCALC = os.path.join(ROOT, 'bin', 'fpcalc')
if not os.path.isfile(FPCALC):
    FPCALC = shutil.which('fpcalc') or FPCALC
CHUNK = 25


def _sha256(path):
    try:
        h = hashlib.sha256()
        with open(path, 'rb') as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b''):
                h.update(chunk)
        return h.hexdigest()
    except Exception:
        return None


def _fingerprint(path):
    if not os.path.isfile(FPCALC):
        return None, None
    try:
        out = subprocess.run(
            [FPCALC, '-json', '-raw', path],
            capture_output=True, text=True, timeout=120)
        if out.returncode != 0 or not out.stdout:
            return None, None
        d = json.loads(out.stdout)
        fp = d.get('fingerprint')
        if isinstance(fp, str):
            fp = [int(x) for x in fp.split()]
        return (' '.join(str(int(v)) for v in fp),
                float(d.get('duration') or 0.0))
    except Exception:
        return None, None


def process_one(song_id, rel_path, music):
    """Worker: pure file work, no DB (forked processes must not touch the
    inherited MySQL pool)."""
    full = os.path.normpath(os.path.join(music, rel_path))
    if not os.path.isfile(full):
        return song_id, None, None, None
    sha = _sha256(full)
    fp, dur = _fingerprint(full)
    return song_id, sha, fp, dur


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--workers', type=int, default=4)
    ap.add_argument('--limit', type=int, default=0, help='0 = all')
    args = ap.parse_args()

    from multiprocessing import Pool
    from models.settings import SettingsModel
    music = SettingsModel.get_music_path()
    if not music:
        print("[backfill] no music path configured")
        return
    rows = Database.execute_query(
        "SELECT s.id, s.file_path FROM songs s "
        "LEFT JOIN song_fingerprints sf ON sf.song_id = s.id "
        "WHERE sf.song_id IS NULL ORDER BY s.id", fetch_all=True) or []
    if args.limit > 0:
        rows = rows[:args.limit]
    total = len(rows)
    print(f"[backfill] {total} songs missing fingerprints", flush=True)
    if not total:
        return

    done = 0
    with Pool(args.workers) as pool:
        for song_id, sha, fp, dur in pool.starmap(
                process_one,
                [(r['id'], r['file_path'], music) for r in rows],
                chunksize=CHUNK):
            if sha or fp:
                try:
                    Database.execute_query("""
                        INSERT INTO song_fingerprints
                            (song_id, sha256, fingerprint, fp_duration)
                        VALUES (%s, %s, %s, %s)
                        ON DUPLICATE KEY UPDATE
                            sha256 = COALESCE(VALUES(sha256), sha256),
                            fingerprint = COALESCE(VALUES(fingerprint), fingerprint),
                            fp_duration = COALESCE(VALUES(fp_duration), fp_duration)
                    """, (song_id, sha, fp, dur))
                except Exception as e:  # noqa: BLE001
                    print(f"[backfill] store failed song {song_id}: {e}")
            done += 1
            if done % 50 == 0 or done == total:
                print(f"[backfill] {done}/{total}", flush=True)
    print("[backfill] done", flush=True)


if __name__ == '__main__':
    main()