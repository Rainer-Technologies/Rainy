"""What the About page in Settings shows: Rainy's version and the third-party
software it runs on.

THIRD_PARTY_NOTICES.md is the full legal text; this is its summary for the
UI (tests/test_about.py keeps the two in step).
"""

from importlib import metadata

# Rainy's version (server and web player). Bump it with each release.
VERSION = '1.0.0'

AUTHOR = 'Rainer Technologies'
WEBSITE = 'https://getrainy.com'
SOURCE = 'https://github.com/Rainer-Technologies/Rainy'
LICENSE = 'MIT'

# (name, license, homepage, PyPI distribution or None when it isn't one)
COMPONENTS = [
    ('Flask', 'BSD-3-Clause', 'https://flask.palletsprojects.com/', 'flask'),
    ('flask-cors', 'MIT', 'https://github.com/corydolphin/flask-cors', 'flask-cors'),
    ('Gunicorn', 'MIT', 'https://gunicorn.org/', 'gunicorn'),
    ('cryptography', 'Apache-2.0 or BSD-3-Clause', 'https://cryptography.io/', 'cryptography'),
    ('bcrypt', 'Apache-2.0', 'https://github.com/pyca/bcrypt', 'bcrypt'),
    ('python-dotenv', 'BSD-3-Clause', 'https://github.com/theskumar/python-dotenv', 'python-dotenv'),
    ('mutagen', 'GPL-2.0-or-later', 'https://github.com/quodlibet/mutagen', 'mutagen'),
    ('mysql-connector-python', 'GPL-2.0 with the Universal FOSS Exception',
     'https://github.com/mysql/mysql-connector-python', 'mysql-connector-python'),
    ('Pillow', 'MIT-CMU', 'https://python-pillow.org/', 'pillow'),
    ('librosa', 'ISC', 'https://librosa.org/', 'librosa'),
    ('NumPy', 'BSD-3-Clause', 'https://numpy.org/', 'numpy'),
    ('ONNX Runtime', 'MIT', 'https://onnxruntime.ai/', 'onnxruntime'),
    ('PyTorch', 'BSD-3-Clause', 'https://pytorch.org/', 'torch'),
    ('requests', 'Apache-2.0', 'https://requests.readthedocs.io/', 'requests'),
    ('ytmusicapi', 'MIT', 'https://github.com/sigma67/ytmusicapi', 'ytmusicapi'),
    ('yt-dlp', 'Unlicense', 'https://github.com/yt-dlp/yt-dlp', 'yt-dlp'),
    ('faster-whisper', 'MIT', 'https://github.com/SYSTRAN/faster-whisper', 'faster-whisper'),
    ('stable-ts', 'MIT', 'https://github.com/jianfch/stable-ts', 'stable-ts'),
    ('FFmpeg', 'LGPL-2.1+ or GPL-2+', 'https://ffmpeg.org/', None),
    ('Chromaprint', 'LGPL-2.1+', 'https://acoustid.org/chromaprint', None),
    ('Essentia', 'AGPL-3.0', 'https://essentia.upf.edu/', None),
    ('Discogs-EffNet', 'CC BY-NC-SA 4.0', 'https://essentia.upf.edu/models.html', None),
    ('Whisper', 'MIT', 'https://github.com/openai/whisper', None),
    ('Inter', 'OFL-1.1', 'https://rsms.me/inter/', None),
]


def _installed_version(distribution):
    if not distribution:
        return None
    try:
        return metadata.version(distribution)
    except metadata.PackageNotFoundError:
        return None


def about_info():
    return {
        'version': VERSION,
        'author': AUTHOR,
        'website': WEBSITE,
        'source': SOURCE,
        'license': LICENSE,
        'notices_url': f'{SOURCE}/blob/main/THIRD_PARTY_NOTICES.md',
        'components': [
            {
                'name': name,
                'license': license_,
                'url': url,
                # None: optional and not installed here, or not a Python package.
                'version': _installed_version(distribution),
            }
            for name, license_, url, distribution in COMPONENTS
        ],
    }
