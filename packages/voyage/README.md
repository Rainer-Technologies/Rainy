# Voyage

A light show environment for [Rainy](../../README.md): fly through the song in 3D.

The song is a road. The land on both sides is its sound, so what lies ahead is
the music that is about to play: gates stand on every beat, portals on every
section change, the album cover is the sun at the end of the road, and the
lyrics are built in the air ahead of you, word by word.

It needs WebGL 2 and is drawn with [three.js](https://threejs.org/), which
travels inside the package (`vendor/three/`, MIT, unmodified).

## Install

Pack it and upload the zip in Rainy under Settings → Server → Light Show
Environments (administrators only):

```bash
python scripts/pack_environment.py packages/voyage
```

That writes `dist/voyage-<version>.zip`.

## Work on it

Start Rainy with `RAINY_DEV=1 RAINY_ENVIRONMENTS_DEV=packages` and the folder is
served as it is on disk: change a file, reload the page. Its own tests:

```bash
node --import ./tests/js/sdk-hook.mjs --test packages/voyage/tests/*.mjs
```

How environments work is in [docs/ENVIRONMENTS.md](../../docs/ENVIRONMENTS.md).
