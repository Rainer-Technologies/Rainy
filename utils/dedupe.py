"""Dupe detection for newly downloaded/uploaded audio files.

Two layers, checked in order:

1. SHA-256 of the file bytes — catches byte-identical copies (same source
   re-download, renamed copies of the same file).
2. Chromaprint acoustic fingerprint (fpcalc binary in bin/) — catches the
   same song from a DIFFERENT source/encode (lyric video vs official video,
   bitrate/sample-rate changes). Calibrated Aug 2026: same track re-encoded
   scores hamming ~0.005-0.01, unrelated tracks ~0.50. Merge threshold 0.22
   with a duration gate of +-15 s leaves an enormous margin.
"""
import hashlib
import json
import os
import shutil
import subprocess

import numpy as np

from models.database import Database

_BUNDLED_FPCALC = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'bin', 'fpcalc')
# bin/fpcalc wins; otherwise a system install (e.g. the Docker image's
# libchromaprint-tools package) on PATH.
FPCALC = (_BUNDLED_FPCALC if os.path.isfile(_BUNDLED_FPCALC)
          else shutil.which('fpcalc') or _BUNDLED_FPCALC)
FP_THRESHOLD = 0.22
DURATION_TOLERANCE = 15.0


def sha256_of(path):
    """Byte hash of a file (64-char hex) or None."""
    try:
        h = hashlib.sha256()
        with open(path, 'rb') as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b''):
                h.update(chunk)
        return h.hexdigest()
    except Exception as e:  # noqa: BLE001
        print(f"[dedupe] sha256 failed for {path}: {e}")
        return None


def fingerprint_of(path):
    """(fingerprint_ints: np.uint32 array, duration_s: float) or (None, None).

    Runs the bundled static fpcalc binary (chromaprint 1.6.1) with -raw.
    """
    if not os.path.isfile(FPCALC):
        print("[dedupe] fpcalc missing at " + FPCALC + " — audio-fingerprint "
              "layer disabled (sha256 still works). Install once:\n"
              "  curl -L https://github.com/acoustid/chromaprint/releases/"
              "download/v1.6.1/chromaprint-fpcalc-1.6.1-linux-x86_64.tar.gz "
              "-o /tmp/fpcalc.tgz && tar xzf /tmp/fpcalc.tgz -C /tmp && "
              "find /tmp -name fpcalc -type f -exec cp {} bin/ \\; && "
              "chmod +x bin/fpcalc")
        return None, None
    try:
        out = subprocess.run(
            [FPCALC, '-json', '-raw', path],
            capture_output=True, text=True, timeout=90)
        if out.returncode != 0 or not out.stdout:
            print(f"[dedupe] fpcalc failed ({out.returncode}) for {path}: "
                  f"{out.stderr[:200]}")
            return None, None
        d = json.loads(out.stdout)
        fp = d.get('fingerprint')
        if isinstance(fp, str):
            fp = [int(x) for x in fp.split()]
        return (np.array(fp, dtype=np.uint32),
                float(d.get('duration') or 0.0))
    except Exception as e:  # noqa: BLE001
        print(f"[dedupe] fpcalc error for {path}: {e}")
        return None, None


def _hamming_ratio(a, b):
    n = min(len(a), len(b))
    if n == 0:
        return 1.0
    x = a[:n] ^ b[:n]
    bits = np.unpackbits(x.view(np.uint8))
    return float(bits.sum()) / (n * 32)


def store(song_id, sha=None, fingerprint=None, duration=None):
    """Persist a song's hash + fingerprint. Idempotent upsert."""
    try:
        Database.execute_query("""
            INSERT INTO song_fingerprints (song_id, sha256, fingerprint, fp_duration)
            VALUES (%s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
                sha256 = COALESCE(VALUES(sha256), sha256),
                fingerprint = COALESCE(VALUES(fingerprint), fingerprint),
                fp_duration = COALESCE(VALUES(fp_duration), fp_duration)
        """, (song_id, sha, fingerprint, duration))
    except Exception as e:  # noqa: BLE001
        print(f"[dedupe] store failed (song {song_id}): {e}")


def find_duplicate(file_path, new_song_id=None):
    """Check a just-created file for an existing duplicate song.

    Returns (existing_song_id, kind, score) or None, where kind is
    'sha256' (byte-identical) or 'audio' (acoustic fingerprint match).
    new_song_id is excluded from matching when re-checking a fresh row.
    """
    sha = sha256_of(file_path)
    if sha:
        rows = Database.execute_query(
            "SELECT song_id FROM song_fingerprints "
            "WHERE sha256 = %s AND song_id <> %s",
            (sha, new_song_id or 0), fetch_all=True) or []
        if rows:
            return rows[0]['song_id'], 'sha256', 1.0

    ints, duration = fingerprint_of(file_path)
    if ints is None or len(ints) == 0:
        return None
    duration = float(duration or 0.0)
    if duration > 0:
        lo, hi = duration - DURATION_TOLERANCE, duration + DURATION_TOLERANCE
        rows = Database.execute_query(
            "SELECT song_id, fingerprint FROM song_fingerprints "
            "WHERE fingerprint IS NOT NULL AND fp_duration IS NOT NULL "
            "AND fp_duration BETWEEN %s AND %s AND song_id <> %s",
            (lo, hi, new_song_id or 0), fetch_all=True) or []
    else:
        rows = Database.execute_query(
            "SELECT song_id, fingerprint FROM song_fingerprints "
            "WHERE fingerprint IS NOT NULL AND song_id <> %s",
            (new_song_id or 0,), fetch_all=True) or []

    best_id, best_score = None, FP_THRESHOLD
    for row in rows:
        try:
            other = np.array(row['fingerprint'].split(), dtype=np.uint32)
        except (ValueError, AttributeError):
            continue
        if len(other) == 0:
            continue
        score = _hamming_ratio(ints, other)
        if score < best_score:
            best_score, best_id = score, row['song_id']
    if best_id is not None:
        return best_id, 'audio', 1.0 - best_score
    return None


def remove_song_and_file(song_id, file_path):
    """Remove a just-created duplicate: song row (cascades access + fp),
    queued enrichment job, and the redundant file from disk."""
    try:
        Database.execute_query(
            "DELETE FROM enrichment_jobs WHERE song_id = %s", (song_id,))
        Database.execute_query(
            "DELETE FROM songs WHERE id = %s", (song_id,))
    except Exception as e:  # noqa: BLE001
        print(f"[dedupe] row cleanup failed (song {song_id}): {e}")
    try:
        if file_path and os.path.isfile(file_path):
            os.remove(file_path)
    except Exception as e:  # noqa: BLE001
        print(f"[dedupe] file cleanup failed for {file_path}: {e}")


def finalize_new_song(file_path, song_id, duration=None):
    """Post-scan hook for a NEW song row.

    Checks the file against every other song; if a strong duplicate exists,
    removes the redundant row+file and returns (existing_id, kind, score).
    Otherwise stores the new song's own fingerprint and returns None.
    """
    dup = find_duplicate(file_path, new_song_id=song_id)
    if dup is not None:
        existing_id, kind, score = dup
        remove_song_and_file(song_id, file_path)
        return existing_id, kind, score
    sha = sha256_of(file_path)
    ints, fp_duration = fingerprint_of(file_path)
    if ints is not None:
        store(song_id, sha=sha,
              fingerprint=' '.join(str(int(v)) for v in ints),
              duration=fp_duration or duration)
    else:
        store(song_id, sha=sha, duration=duration)
    return None