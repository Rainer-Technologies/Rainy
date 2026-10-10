# Third-party notices

Rainy's own source code is released under the [MIT License](LICENSE). Rainy does not vendor or redistribute the components below: they are installed from PyPI or the OS package manager, or downloaded at runtime. They keep their own licenses, which apply when you install or redistribute them, for example in a Docker image.

## Copyleft dependencies worth knowing about

| Component | License | How Rainy uses it |
| --- | --- | --- |
| [mutagen](https://github.com/quodlibet/mutagen) | GPL-2.0-or-later | Required: reads and writes audio tags |
| [mysql-connector-python](https://github.com/mysql/mysql-connector-python) | GPL-2.0 with the Universal FOSS Exception | Required: database driver |
| [FFmpeg](https://ffmpeg.org/) | LGPL-2.1+ or GPL-2+, depending on the build | Installed in the Docker image for yt-dlp |
| [Chromaprint](https://acoustid.org/chromaprint) (`fpcalc`) | LGPL-2.1+ | Optional: acoustic fingerprints for duplicate detection |
| [Essentia](https://essentia.upf.edu/) | AGPL-3.0 | Optional: mel-spectrogram front end for genre classification |

Anyone who distributes a bundle that includes these components (such as a prebuilt Docker image) must meet their license terms, for example by offering the corresponding source code.

## Models downloaded at runtime

| Model | License | Notes |
| --- | --- | --- |
| [Discogs-EffNet](https://essentia.upf.edu/models.html) (`discogs-effnet-bsdynamic-1`) | CC BY-NC-SA 4.0 (non-commercial) | Optional genre classification. Downloaded from essentia.upf.edu into `classifier/` on first use and never committed. Commercial use needs a separate license from the Music Technology Group (UPF). |
| [Whisper](https://github.com/openai/whisper) weights via faster-whisper | MIT | Optional word-level lyrics alignment, downloaded on first use |

## Permissive dependencies

Flask (BSD-3-Clause), flask-cors (MIT), cryptography (Apache-2.0 or BSD-3-Clause), Gunicorn (MIT), python-dotenv (BSD-3-Clause), bcrypt (Apache-2.0), Pillow (MIT-CMU), librosa (ISC), NumPy (BSD-3-Clause and others), ytmusicapi (MIT), requests (Apache-2.0), yt-dlp (Unlicense), faster-whisper (MIT), stable-ts (MIT), ONNX Runtime (MIT) and PyTorch (BSD-3-Clause plus bundled component licenses, optional).

## Fonts

The web player loads [Inter](https://rsms.me/inter/) (SIL Open Font License 1.1) from Google Fonts; it is not bundled with Rainy.

## Services

YouTube, YouTube Music, Spotify, Last.fm and MusicBrainz are third-party services with their own terms of use. Rainy is not affiliated with or endorsed by any of them. See the disclaimer in the [README](README.md#-license-and-disclaimer).
