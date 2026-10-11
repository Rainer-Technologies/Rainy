# Light show environments

An environment is a kind of light show: one way of staging a song in the fullscreen player. Rainy analyses every song on the server (beats, bars, sections, drums, drops, silences, key, genre) and keeps a clock locked to the audio. An environment receives all of that every frame and decides what it looks like, lyrics included.

**Classic** is built in. Anything else is a **package**: a zip an administrator installs on a server, after which every user of that server can pick it, by its picture, in Settings → Light Show, or with the cube button in the show.

Two packages live in this repository:

- [`packages/example-pulse`](../packages/example-pulse): about 130 lines on a 2D canvas. Start here.
- [`packages/voyage`](../packages/voyage): a full 3D environment with three.js, its own lyrics and an immersive layout.

> **A package is trusted code.** It runs in the browser of everyone who uses the server, inside Rainy's own page and with their session. Rainy checks that a package is well formed; it does not and cannot make an untrusted one safe. Only administrators can install packages, and they should only install ones from authors they trust.

## A package

```
my-environment.zip
  rainy-environment.json    the manifest
  index.js                  an ES module; its default export is the environment class
  style.css                 optional
  preview.jpg               the picture people pick it by (16:9)
  …                         your own modules, libraries, shaders, images, fonts
```

The manifest sits at the root of the zip, or inside a single top-level folder (what a repository download gives you). A package may be up to 20 MB zipped, 60 MB unpacked and 500 files, of these types: `js mjs json css wasm`, images (`png jpg jpeg webp avif gif svg`), fonts (`woff2 woff ttf otf`), shaders and text (`glsl vert frag wgsl txt md`), `bin ktx2 hdr`, and media (`mp3 ogg mp4 webm`). Hidden files, `node_modules` and what archivers add (`__MACOSX`) are skipped.

### Manifest

```json
{
    "manifest": 1,
    "api": 1,
    "id": "my-environment",
    "name": "My Environment",
    "version": "1.0.0",
    "description": "One line for the picker",
    "author": "You",
    "license": "MIT",
    "homepage": "https://example.com",
    "entry": "index.js",
    "styles": ["style.css"],
    "preview": "preview.jpg",
    "layout": "stage",
    "requires": ["webgl2"],
    "i18n": { "es": { "name": "Mi entorno", "description": "Una línea para el selector" } }
}
```

| Field | | |
| --- | --- | --- |
| `manifest` | required | Version of this file's format: `1`. |
| `api` | required | Version of the environment contract the code was written for: `1`. Rainy refuses a package written for a version it does not speak. |
| `id` | required | 2 to 32 characters, lowercase letters, digits and hyphens, starting with a letter. Installing a package with the id of an installed one replaces it. `classic` is taken. |
| `name`, `version` | required | `version` looks like `1.2.3`. |
| `entry` | required | The module to load, a `.js` or `.mjs` file of the package. |
| `description`, `author`, `license`, `homepage` | | Shown in Settings. |
| `styles` | | Stylesheets loaded while the environment is on stage, and removed when it leaves. |
| `preview` | recommended | The picture of the environment in Settings, where people choose by it: a 16:9 image, 960 × 540 is plenty. A frame of the show itself works best. Without one the environment gets a blank plate. |
| `layout` | | `stage` (default) or `immersive`, see [Layout](#layout). |
| `requires` | | Any of `webgl`, `webgl2`, `webgpu`. On a device without one of them the environment cannot be picked. |
| `i18n` | | `name` and `description` per language code. |

## The environment

The entry module's default export is a class. Rainy creates one instance when the environment goes on stage and calls it like this (only the first four are required):

| | |
| --- | --- |
| `mount(ctx)` | Build everything. May be `async`. `ctx` is described below. |
| `update(S)` | Every frame, first: read the show state, fire cues, move the lyrics. |
| `render(S)` | Every frame, second: draw. |
| `unmount()` | Release what the page cannot release for you (WebGL contexts, workers, timers). |
| `resize(cssW, cssH, { tier, lowPower, scale })` | Every frame, before `update`; return early when nothing changed. Render at `cssW × scale` by `cssH × scale`. `tier` is 0 (full), 1 or 2 (lightest), chosen by Rainy from how long frames are taking. |
| `setScore(score \| null)` | The song's score arrived, or went away. |
| `setTrack(track \| null)` | `{ id, title, artist, cover }` of the song on stage (`cover` is an image URL or `null`). |
| `onTrackChange()` | Another song started. |
| `leave()` | Another environment is taking over; your layer is already fading out. |
| `dropLyrics()` | Take the lyrics off stage now. |

```js
import { TAU, clamp, rgba } from '@rainy/lightshow';

export default class MyEnvironment {
    mount(ctx) {
        this.canvas = document.createElement('canvas');
        ctx.root.appendChild(this.canvas);
        this.g = this.canvas.getContext('2d');
    }

    unmount() {}

    resize(cssW, cssH, { scale }) {
        const w = Math.round(cssW * scale), h = Math.round(cssH * scale);
        if (this.canvas.width !== w || this.canvas.height !== h) Object.assign(this.canvas, { width: w, height: h });
    }

    update(S) {
        for (const ev of S.F.events) if (ev.type === 'drop') S.flash(1, S.palette.w);
    }

    render(S) {
        const { g, canvas } = this;
        g.fillStyle = rgba(S.palette.deep, 1);
        g.fillRect(0, 0, canvas.width, canvas.height);
        g.fillStyle = rgba(S.palette.a, S.dim);
        g.beginPath();
        g.arc(canvas.width / 2, canvas.height / 2, canvas.height * (0.1 + 0.1 * S.pulse.k), 0, TAU);
        g.fill();
    }
}
```

If `update` or `render` throws three frames in a row, if any other call throws, or if loading and mounting takes more than ten seconds, Rainy takes the environment off stage, removes everything it added and goes back to Classic until the page is reloaded or the package is updated. The error is in the browser console.

### `ctx`: what Rainy gives you

| | |
| --- | --- |
| `ctx.root` | Your own layer over the stage, an empty `div` that fills it. Canvases and DOM go in here. Rainy fades it in after `mount` and out when you leave, and removes it afterwards. It ignores the pointer unless you set `pointer-events` on something inside it. |
| `ctx.lyrics` | The lyrics timeline, also passed every frame as `S.lyrics`. |
| `ctx.asset(path)` | The URL of a file of your package: `ctx.asset('textures/noise.png')`. Relative imports and `url()` in your stylesheets work as usual. |
| `ctx.ui.safeArea()` | `{ top, right, bottom, left }`, each 0 to 1: how much of that side of the stage the player covers right now. Keep what must be read out of it. |
| `ctx.ui.addButton({ icon, title, onClick, pressed })` | A button of your own in the show's HUD. `icon` is SVG markup (14 px). Returns `{ el, setPressed(on), remove() }`. |
| `ctx.ui.toast(message)` | A short notice. |
| `ctx.ui.fontFamily` | The interface's font, for text you draw yourself. |
| `ctx.locale` | Language of the interface (`en`, `es`, …). |
| `ctx.id`, `ctx.manifest`, `ctx.api` | Who you are, and the contract version of this Rainy. |
| `ctx.fail(error)` | You cannot go on (a lost WebGL context, a shader that does not compile). Rainy falls back to Classic. |

### `@rainy/lightshow`: what you can import

The only module of Rainy's a package imports. Names are added over time, never removed within an API version.

| | |
| --- | --- |
| `API_VERSION` | `1` |
| `TAU`, `clamp(v, a, b)`, `lerp(a, b, t)`, `smooth(t)` | Maths. |
| `hsl(h, s, l)`, `mixHue(a, b, t)`, `mixRgb(a, b, t)`, `toWhite(c, t)`, `rgba(c, alpha)` | Colour. A colour is `[r, g, b]` in 0 to 255; `rgba` gives a CSS string. |
| `paletteFor({ accentHue, key, mode, label, genre, swap })` | The palette of a section, as the conductor computes it. For when you need a section's colours before it plays. |
| `stepEase(beat)`, `altBeat(beat)`, `hash(n)` | Motion locked to the beat, and a deterministic random number. |
| `floorIndex(sortedArray, t)` | Index of the last element ≤ `t`, for a score's time arrays. |
| `LEAD`, `HOLD_MAX`, `REST_AFTER`, `HELD`, `pickTransition(F, lineIndex, last)` | The lyric timings every environment shares, and which of six hand-overs (`slam`, `fall`, `flicker`, `sweep`, `collapse`, `lift`) a line gets. |
| `MIN_FLASH_GAP`, `PHRASE_BARS` | The conductor's limits. |

## The data

### `S`: the show, this frame

| | |
| --- | --- |
| `S.F` | The musical frame, below. |
| `S.t` | Media time in seconds, smoothed and corrected by the user's sync offset. Everything should be a function of this. |
| `S.now`, `S.dt` | Wall clock and frame time in seconds, for things that are not music (idle animation, smoothing). |
| `S.running` | The song is playing. Fire one-shot cues only when it is. |
| `S.I` | Intensity, 0.3 to 1: how hard the show should go, from the song's own profile or the user's setting. |
| `S.pulse` | `{ k, s, h }`: kick, snare and hi-hat envelopes, 0 to 1, with instant attack and a short release. |
| `S.phrase` | Which 8-bar phrase of the section this is. Change the look on it. |
| `S.palette` | `{ a, b, c, w, deep }`: primary, secondary, tertiary, tinted white and ambience, from the section's key and mode, the genre and the user's accent colour. It glides between sections. |
| `S.dim` | Master dimmer, 0 to 1: pause, blackouts, the breath before a drop. Multiply your light by it. |
| `S.flash(amount, color)` | Ask for a flash. The conductor limits flashes to three per second and softens them when the user asked to reduce flashing. |
| `S.blind(amount)`, `S.burst(amount)` | Ask for a blinder (a slower wash of light) or a burst (a boost that rings out over half a second). |
| `S.flashAmt`, `S.flashColor`, `S.blinderAmt`, `S.burstAmt` | What to draw of them this frame, after the limiter. |
| `S.prefs` | `{ reduceFlashing, disableLasers, showBgBlur, lowPower, intensity }`: what the user asked for. |
| `S.lyrics`, `S.lyricsOn`, `S.songId` | The lyrics timeline, and whether the user has lyrics on stage right now. |
| `S.accentHue` | Hue of the user's accent colour. |

### `F`: the music, this frame

With a score, `F.scripted` is `true` and everything is exact and known ahead. While a song is still being analysed Rainy listens to the audio instead: the same fields, estimated, with no look-ahead (`dropIn` and `nextIn` are `Infinity`, `section` is a guess).

| | |
| --- | --- |
| `F.bands` | `{ sub, bass, mid, high, air, rms, harm }`, 0 to 1: energy per band, overall loudness, and how tonal the sound is. |
| `F.hits` | `{ k, s, h }`: strength of a kick, snare or hi-hat that landed in this frame, else 0. |
| `F.beat`, `F.bar` | Fractional beat and bar numbers. `F.beatPhase` and `F.barPhase` are their fractions, `F.beatInBar` is 0 to 3, `F.period` is seconds per beat. |
| `F.newBeat`, `F.newBar` | A beat or a bar started in this frame. |
| `F.section` | `{ idx, label, t0, t1, key, mode, energy, density }`. `label` is one of `intro`, `verse`, `build`, `chorus`, `drop`, `breakdown`, `outro`. |
| `F.sectionProgress`, `F.sectionBar` | 0 to 1 through the section, and bars since it started. |
| `F.nextSection`, `F.nextIn` | The section that follows, and seconds until it. |
| `F.dropIn` | Seconds until the next drop. |
| `F.buildProgress` | 0 to 1 through a build-up. |
| `F.stopDepth`, `F.stopIn` | How deep into a silence the song is (0 to 1), and seconds until the next one. |
| `F.events` | What happened in this frame: `{ type, t }` with `type` one of `drop`, `impact`, `stop`, `riser`. |
| `F.profile` | `{ genre, intensity }`. `genre` is one of `edm`, `pop`, `rock`, `hiphop`, `latin`, `chill`, `orchestral`. |
| `F.jumped` | The user seeked, or the track changed: snap, do not glide. |

### The score

`setScore(score)` gives you the whole song at once, which is what lets an environment show the music that is coming. `score` is `null` while there is none.

| | |
| --- | --- |
| `score.duration`, `score.tempo`, `score.period` | Seconds, BPM, seconds per beat. |
| `score.beats`, `score.downbeats` | Times in seconds, sorted. |
| `score.onsets.k`, `.s`, `.h` | Kicks, snares and hi-hats: `{ t, s }`, parallel arrays of time and strength. |
| `score.env[band]`, `score.fps` | One byte per frame (0 to 255) for each band of `F.bands`, at `fps` frames per second. `score.envAt(band, t)` reads it. |
| `score.sections` | As `F.section`. `score.sectionAt(t)`. |
| `score.events` | As `F.events`, the whole song. `score.nextEvent(type, t, horizon)`. |
| `score.beatAt(t)`, `score.barAt(t)`, `score.stopDepth(t)` | The same lookups Rainy uses to build `F`. |

### Lyrics

`S.lyrics` says what is sung when; how it looks is up to you. It is only worth reading when `S.lyricsOn` is true.

| | |
| --- | --- |
| `lyrics.ready` | The song has synced lyrics. |
| `lyrics.lines` | `{ t0, t1, on, end, blank, words: [{ text, s, e }] }`. A line goes on stage at `on` and its last word ends at `end`; `blank` marks an instrumental line. |
| `lyrics.adlibs` | Backing vocals (the words in parentheses), apart from the lines: `{ s, e, k, words }`. |
| `lyrics.aligned` | The word times are exact. Otherwise they are an estimate from the line's length. |
| `lyrics.lineIndex(t)` | The line on stage at `t`, or -1. |
| `lyrics.resting(t, index)` | Nobody is singing that line right now. |
| `lyrics.breakAt(t, index)` | `{ a, b }` when an instrumental break is running. |
| `lyrics.version` | Changes whenever the lines are replaced (a new song, exact timings arriving). |

## Layout

`"layout"` in the manifest says how the player is arranged around your layer:

- **`stage`**: the player as it is, with its artwork, controls and queue, and the show behind it.
- **`immersive`**: the show is the whole picture. The queue folds away (a HUD button brings it back over the show), the song and its controls become one small card at the bottom, and all of it dims while the pointer rests.

## Styling the player

An environment changes what the player looks like with CSS, not with JavaScript. List your stylesheets under `"styles"` in the manifest: Rainy loads them when the environment goes on stage and removes them when it leaves, so nothing you write outlives your show.

While you are on stage, the fullscreen player has the class `ls-env-<id>`. Start every rule with it:

```css
/* The progress bar and the glow around the artwork take the colours of the song. */
#fullscreen-player.ls-env-my-environment .fs-progress-fill {
    background-color: rgb(var(--ls-a));
}

#fullscreen-player.ls-env-my-environment .fs-artwork-container {
    box-shadow: 0 0 70px rgb(var(--ls-b) / 0.55);
}
```

### State

Classes on `#fullscreen-player` that say what is going on:

| Class | |
| --- | --- |
| `lightshow-on` | The show is running. |
| `ls-env-<id>` | That environment is on stage. |
| `ls-immersive` | The layout is immersive. |
| `ls-idle` | Immersive only: the pointer is resting and the player is dimmed. |
| `ls-queue-peek` | Immersive only: the user opened the queue over the show. |
| `ls-lowpower` | Low Performance Mode is on. Drop your filters and shadows. |
| `mode-modern`, `mode-standard` | Which fullscreen player the user chose. Modern has its own controls. Standard keeps the app's player bar at the bottom, so `.fs-player-controls` and the volume button are hidden. |
| `layout-swapped` | The artwork is on the left and the queue on the right, which is the default. Without it they are the other way round. |

### Parts

| Selector | |
| --- | --- |
| `.fs-backdrop` | The blurred album art behind everything. |
| `.ls-env-root` | Your layer. |
| `.fs-brand` | The Rainy mark, top left. |
| `#fs-volume-btn`, `#fs-lightshow-btn`, `#fs-close-btn` | The buttons at the top. |
| `.ls-hud`, `.ls-hud-btn` | The show's bar (tempo, genre) and its buttons, yours included. |
| `.fs-content` | The box that holds the song and the queue. |
| `.fs-current-info` | The song: artwork, title, artist and controls. In an immersive layout this is the card. |
| `.fs-artwork-container` | The album art. |
| `.fs-title`, `.fs-artist` | |
| `.fs-player-controls` | The progress bar and the buttons. |
| `.fs-progress-container`, `.fs-progress-bar`, `.fs-progress-fill`, `.fs-time` | |
| `.fs-buttons`, `.fs-control-btn`, `.fs-control-btn.play-pause` | |
| `.fs-queue-container` | The panel with the queue and the lyrics. |

Anything not in this table is internal and may change without notice.

### Variables

The palette of the song is on the player as CSS variables, each holding `r g b`, so stylesheets can follow the music. They glide from one section's colours to the next.

| Variable | |
| --- | --- |
| `--ls-a`, `--ls-b`, `--ls-c` | Primary, secondary and tertiary colour of the section. |
| `--ls-w` | Tinted white. |
| `--ls-deep` | The dark ambience colour. |

Use them as `rgb(var(--ls-a))` or, with transparency, `rgb(var(--ls-a) / 0.5)`.

Rainy's own theme is there too: `--accent-primary`, `--text-primary`, `--text-secondary`, `--text-tertiary`, `--bg-primary`, `--bg-secondary`, `--bg-tertiary`, `--bg-elevated`, `--border-subtle`, `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-full`, `--spacing-xs` to `--spacing-xl` and `--font-family`.

### Limits

- Keep to the fullscreen player. The rest of Rainy is not yours to change, and your rules should not match anything outside `#fullscreen-player.ls-env-<id>`.
- Leave people a way out: do not hide or cover `#fs-close-btn` or `#fs-lightshow-btn`, and keep the playback controls usable.
- For anything that moves with the beat, draw it in your layer. CSS gets the palette, not the kick drum.

## Rules of the house

- **Flashes go through the conductor.** Call `S.flash` and draw `S.flashAmt`. Never strobe on your own: the limit protects people with photosensitive epilepsy.
- **Respect the user's settings**: `S.prefs.reduceFlashing` (also drop camera shake and sudden motion), `S.prefs.disableLasers`, `S.prefs.lowPower` and the `tier` you are given.
- **Be a function of the song's time.** Compute what is on screen from `S.t` and the score instead of accumulating state frame by frame, and a seek, a pause or a dropped frame can never leave the show out of sync.
- **Stay inside `ctx`.** Draw in `ctx.root`, talk to Rainy through `ctx` and `@rainy/lightshow`, and do not reach for `window.player`, the page's other elements or Rainy's API. That is what will let a future Rainy run packages isolated, and what keeps yours working when the page changes.
- **Carry your libraries.** Put what you import inside the package; do not load code from other servers.

## Develop

Start Rainy in development mode with a folder of unpacked packages:

```bash
RAINY_DEV=1 RAINY_ENVIRONMENTS_DEV=packages .venv/bin/python app.py
```

Every folder in it that holds a valid `rainy-environment.json` is listed as an environment (tagged *Development*) and served straight from disk, uncached: change a file and reload the page. A folder stands in for the installed package with the same id. Folders that do not validate are reported on the server's console.

For code that does not touch the DOM, Node can resolve the SDK the way the browser does:

```bash
node --import ./tests/js/sdk-hook.mjs --test packages/voyage/tests/*.mjs
```

## Pack and install

```bash
python scripts/pack_environment.py packages/example-pulse
```

writes `dist/example-pulse-1.0.0.zip`, after checking the folder exactly as the server checks an upload. Hidden files and the folder's `tests/` are left out, and the same files always give the same zip.

Then, as an administrator: Settings → Light Show → Installed Environments → *Install package (.zip)*. From there a package can be switched off or removed. Uploading a package with the same id updates it: you get the new version at once, everyone else the next time they open Rainy.

Installed packages are kept in the database, so they survive a rebuilt container; the unpacked copy they are served from is rebuilt whenever it is missing.
