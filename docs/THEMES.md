# Interface themes

A theme changes how all of Rainy looks in the browser: colours, type, shapes, and where things sit on the screen. **Rainy** (Rainy's own look) is built in. Anything else is a **package**: a zip an administrator installs on a server. Each user then picks one in Settings → Appearance, and their pick follows them to every device. An administrator can also choose the theme people get until they pick their own.

Two packages live in this repository:

- [`packages/example-daylight`](../packages/example-daylight): a light theme made of tokens and about 40 lines of CSS. Start here.
- [`packages/encore`](../packages/encore): YouTube Music's look, one to one. Roboto and Material Symbols carried in the package, YouTube Music's words (Home, Explore, Quick picks), a 64px top bar, a guide of rounded rows, shelves of covers, Quick picks, a one-row player bar with its red line, the Now playing page, Settings as a dialog, and a small module that washes the song's colours over the page. Every control of Rainy's is still there.

> **A package is trusted code.** Its stylesheets restyle the app for everyone on the server. Its module, if it has one, runs in their browser, inside Rainy's page and with their session. Rainy checks that a package is well formed and that its styles follow the rules below; it cannot make an untrusted package safe. Only administrators can install packages, and they should only install ones from authors they trust.

## What a theme can and cannot do

A theme **never replaces Rainy's markup**. Rainy builds every view, button and menu. A theme restyles them with tokens and stylesheets, swaps their [icons](#icons), renames their [words](#words), and hides the purely decorative parts it does not want. This one rule is what lets themes and Rainy change independently:

- **A feature Rainy adds shows up in every theme.** It is built by Rainy, so it is there. It takes the theme's look through the tokens and the shared classes (`.btn`, `.control-btn`, `.nav-item`, …), and through the region it lands in.
- **A theme cannot hide Rainy's controls.** Before a package is installed, its stylesheets are read. Any rule that would hide, disable or shrink away something Rainy built is refused: `display: none`, `visibility: hidden`, `opacity: 0`, `pointer-events: none`, `font-size: 0`, `content-visibility: hidden`, and `display: contents` on anything but a region. A theme may hide only:
  - what it draws itself (pseudo-elements, its own `.theme-*` elements, anything in its layers);
  - the parts below marked *may be hidden*.
- **Rainy's state always wins.** What Rainy hides (a closed menu, an inactive tab, `.hidden`, `[hidden]`) stays hidden whatever a theme says. These rules live in a cascade layer no theme can override, and `!important` is not allowed in a theme.
- **There is always a way back.** The account menu, its Settings entry and the theme picker are kept visible and clickable whatever a theme does. `?theme=off` in the address, or **Alt+Shift+D**, shows Rainy's own look in that tab.
- **One to one in looks, not in features.** A theme can make Rainy look exactly like another app, as Encore does with YouTube Music. Controls that other app does not have (keyboard shortcuts, sort, grid or list, Friends, the queue, the player's More menu) stay, drawn in the theme's language.
- **What a theme breaks can be found.** Settings → Appearance → *Check the theme in use* (administrators) compares every control on every view with the theme's styles off and on. It reports what the theme hides, covers, shrinks, pushes off screen or makes hard to read. See [Checking a theme](#checking-a-theme).

## A package

```
my-theme.zip
  rainy-theme.json    the manifest
  style.css           stylesheets, as many as you like (up to 8)
  index.js            optional: a module for decorative layers
  preview.jpg         the picture people pick it by (16:9)
  …                   fonts, images, more modules
```

The manifest sits at the root of the zip, or inside a single top-level folder (what a repository download gives you). The limits and file types are the same as for [light show environments](ENVIRONMENTS.md#a-package): up to 20 MB zipped, 60 MB unpacked and 500 files. Each stylesheet may be up to 1 MB.

### Manifest

```json
{
    "manifest": 1,
    "api": 1,
    "id": "my-theme",
    "name": "My Theme",
    "version": "1.0.0",
    "description": "One line for the picker",
    "author": "You",
    "license": "MIT",
    "homepage": "https://example.com",
    "colorScheme": "dark",
    "fullscreen": "standard",
    "tokens": { "--accent-primary": "#ff0033", "--bg-primary": "#030303" },
    "styles": ["style.css"],
    "icons": { "play": "icons/play.svg", "library-music": "icons/home.svg" },
    "strings": { "en": { "Library": "Home" }, "es": { "Library": "Inicio" } },
    "entry": "index.js",
    "preview": "preview.jpg",
    "i18n": { "es": { "name": "Mi tema", "description": "Una línea para el selector" } }
}
```

| Field | | |
| --- | --- | --- |
| `manifest` | required | Version of this file's format: `1`. |
| `api` | required | Version of the theme contract (below) the theme was written for: `1`. Rainy refuses a package for a version it does not speak. |
| `id` | required | 2 to 32 characters: lowercase letters, digits and hyphens, starting with a letter. Installing a package with the id of an installed one replaces it. `rainy` is taken. |
| `name`, `version` | required | `version` looks like `1.2.3`. |
| `colorScheme` | | `dark` (default) or `light`. It tells the browser how to draw its own controls (scroll bars, date pickers), and the picker shows it. |
| `fullscreen` | | `standard` or `modern`: the full player the theme is drawn for. While the theme is on it wins over the user's own choice (Settings → Player). The standard one keeps the player bar underneath; the modern one has its own controls. Leave it out to follow the user. |
| `tokens` | | Values for Rainy's [tokens](#tokens), or for your own (their names start with `--theme-`). A value is a CSS value of at most 200 characters, without `;`, braces, `<`, `>`, `\`, `url()` or `!important`. |
| `styles` | | Stylesheets of the package, in order. A theme needs at least one of `tokens`, `styles`, `icons` or `strings`. |
| `icons` | | [Icons](#icons) to draw instead of Rainy's: an icon name to an SVG file of the package. |
| `strings` | | [Words](#words) to use instead of Rainy's, per language. |
| `entry` | | A module for [decorative layers](#a-themes-module). |
| `preview` | recommended | A 16:9 picture of the theme, about 960 × 540. A screenshot works best. Without one, the picker draws a little window in the theme's colours. |
| `description`, `author`, `license`, `homepage`, `i18n` | | As for environments. |

## Tokens

Rainy's CSS is written in tokens: custom properties on `:root` (static/css/variables.css). Set them in the manifest and every view follows. A light theme is mostly a matter of tokens; see Daylight.

| Token | |
| --- | --- |
| `--bg-primary`, `--bg-secondary`, `--bg-tertiary`, `--bg-elevated`, `--bg-glass` | Backgrounds from the page down to raised panels; `--bg-glass` is for translucent bars. |
| `--surface-base`, `--surface-raised`, `--surface-elevated`, `--surface-popover`, `--surface-accent` | The same levels by role. They follow the backgrounds unless you set them. |
| `--text-primary`, `--text-secondary`, `--text-tertiary` | Text, from titles to hints. |
| `--tint-2`, `--tint-4`, `--tint-6`, `--tint-10`, `--tint-15`, `--tint-20`, `--tint-30`, `--tint-50`, `--bg-hover`, `--bg-highlight`, `--border-color`, `--border-subtle` | Washes of the text colour (2 % to 50 %) for hovers, wells and hairlines. They follow `--text-primary`, so they turn dark in a light theme on their own. |
| `--accent-primary` | The accent. `--accent-light`, `--accent-secondary`, `--accent-gradient`, `--accent-glow`, `--accent-bg-subtle` and `--focus-ring` follow it; set them only to override that. |
| `--text-on-accent` | Text and icons drawn on the accent. |
| `--error`, `--success`, `--warning` | Status colours. |
| `--scrim` | What dims the page behind a dialog. |
| `--shadow-sm`, `--shadow-md`, `--shadow-lg`, `--shadow-glow` | Shadows. |
| `--font-family`, `--font-family-display` | Body text, and headings and big titles. Bundle your fonts with `@font-face` in a stylesheet. |
| `--font-size-xs`, `--font-size-sm`, `--font-size-base`, `--font-size-lg`, `--font-size-xl`, `--font-size-2xl`, `--font-size-3xl`, `--font-size-4xl` | The type scale. |
| `--spacing-xs`, `--spacing-sm`, `--spacing-md`, `--spacing-lg`, `--spacing-xl`, `--spacing-2xl` | Spacing. |
| `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-xl`, `--radius-full`, `--radius-card`, `--radius-control` | Corners. |
| `--transition-fast`, `--transition-base`, `--transition-normal`, `--transition-slow`, `--hit-target` | Timing, and the smallest size of a thing to press. |
| `--header-height`, `--player-height`, `--mobile-player-height`, `--sidebar-width` | The size of the chrome. |
| `--shell-inset-top`, `--shell-inset-right`, `--shell-inset-bottom`, `--shell-inset-left` | How much of each edge of the content the fixed chrome covers (by default, the player bar at the bottom). If you move the player or the navigation, move these with it so nothing hides behind them. |

**The accent.** `--accent-primary` in your tokens is the theme's accent. A user can still pick their own in Settings → Appearance; theirs wins, and *Reset* goes back to the theme's. Picking a theme also goes back to its accent.

The full player is a dark stage over the album art whatever the theme. Its own light show variables (`--ls-*`) are in [ENVIRONMENTS.md](ENVIRONMENTS.md#variables).

## Stylesheets

Your stylesheets are loaded into the **`theme` cascade layer**, which comes after Rainy's own (`@layer guard, rainy, theme`). Your rules therefore win over Rainy's on order alone: `.nav-item { … }` beats Rainy's `.app-sidebar .nav-section .nav-item { … }`, whatever the specificity. The only rules you cannot beat are Rainy's guard rules, which keep its state and the way back. Relative `url()`s and `@font-face` work as usual; files must come from the package (no outside addresses, no `@import`).

Write your rules against the **contract**: the parts, classes and states below. They are Rainy's promise. Within an `api` version they are only ever added, never removed or renamed. Anything else is internal and may change in any release. Packing or installing a theme warns you about internal names it uses; it still installs, and such rules simply stop matching if Rainy changes.

### Parts

Regions of the page carry a `data-part` attribute. Select them with `[data-part~="name"]`.

| Part | |
| --- | --- |
| `splash` | The boot splash, shown to signed-in users while Rainy loads. |
| `splash-logo` | The logo on the boot splash. *May be hidden.* |
| `setup`, `login` | The first-run setup screen and the sign-in screen. |
| `app` | The signed-in app: header, body and player bar. |
| `header` | The top bar. |
| `header-start` | Left of the top bar: the navigation toggle and the brand. |
| `brand` | The Rainy logo and name in the top bar. *May be hidden.* |
| `logo` | The logo picture in the brand. *May be hidden.* |
| `header-actions` | Right of the top bar: search, shortcuts and the account menu. |
| `search` | The library search box. |
| `user-menu` | The account menu (trigger and dropdown). |
| `user-menu-trigger` | The avatar and name that open the account menu. *A control.* |
| `user-name` | The user's name beside the avatar, in the top bar. *May be hidden.* |
| `user-menu-arrow` | The little chevron of the account menu's trigger. *May be hidden.* |
| `user-dropdown` | The account menu's dropdown. |
| `menu-settings` | The Settings entry of the account menu. *A control.* |
| `app-body` | Everything between the top bar and the player bar: sidebar and main. |
| `sidebar` | The navigation sidebar. |
| `sidebar-backdrop` | What dims the page behind the sidebar on phones. *A control.* |
| `nav` | The navigation inside the sidebar. |
| `nav-section` | A group of the navigation: Library, Browse, Playlists. |
| `nav-title` | The title of a group of the navigation, where it is only a title (Library, Playlists). *May be hidden.* |
| `playlists` | The list of playlists in the sidebar. |
| `main` | The scrolling area where every view is shown. |
| `section-header` | The title row of the library and playlist views, with the grid/list toggle. |
| `button-label` | The words of a button that also has an icon and tells screen readers what it does (a playlist's or an album's Play). *May be hidden*, which leaves the icon. |
| `shelf-title` | A shelf's title (built by the app; the same element as `.section-heading`). *May be hidden*, for a view whose only shelf needs none, like a playlist's. |
| `view-title`, `view-subtitle` | The big title of the library and playlist views, and the line under it. *May be hidden.* Hide them by view (`html[data-view="library"]`): on a playlist the title is the playlist's name. |
| `library-stats` | The song, artist and album counts of the library. *May be hidden.* |
| `loading`, `empty-state` | The library's loading and empty states. |
| `song-grid`, `song-list` | The library's songs as a grid (shelves and cards), and as a list. |
| `view-discover`, `view-friends`, `view-recent`, `view-smartmix` | The Discover, Friends, Recently Played and Smart Mix views. |
| `view-artists`, `artist-profile` | The Artists view, and one artist's page. |
| `view-albums`, `album-detail` | The Albums view, and one album's page. |
| `player-bar` | The player at the bottom of the app. |
| `now-playing` | The song playing, in the player bar; it opens the full player. *A control.* |
| `player-controls` | The middle of the player bar: transport and progress. |
| `transport` | Shuffle, previous, play/pause, next and repeat. |
| `progress` | The progress bar and the times. |
| `player-actions` | The right of the player bar: like, queue, volume, more. |
| `volume` | The volume control. |
| `volume-readout` | The volume as a number, beside the slider. *May be hidden.* |
| `player-menu` | The player bar's More menu: sleep timer, speed, EQ, crossfade, Connect. |
| `settings` | The Settings page. |
| `settings-sidebar`, `settings-nav` | The Settings page's navigation and search, and its list of sections. |
| `settings-main`, `settings-content` | The Settings page's title and content, and the open section. |
| `theme-escape` | What must stay reachable whatever the theme: the account menu's trigger, its Settings entry and the theme picker. Rainy keeps these visible and clickable. |
| `toasts` | Where notices appear. |
| `modal` | A dialog: its host element (a `.modal-overlay` or a `rainy-*-modal`). |
| `context-menu` | The song menu. |
| `fullscreen` | The full player. While a light show runs, its environment styles it too ([ENVIRONMENTS.md](ENVIRONMENTS.md#styling-the-player)). |
| `fs-content` | The box with the song and the side panel in the full player. |
| `fs-brand` | The Rainy mark at the top left of the full player. *May be hidden.* |
| `fs-title`, `fs-artist` | The song's title and artist under the cover in the full player. *May be hidden*: the standard full player shows them in the player bar too (`[data-part~="fullscreen"].mode-standard`). |
| `fs-side` | The full player's side panel: queue and lyrics. |
| `fs-now-playing` | The song in the full player: artwork, title, artist and controls. |
| `fs-controls` | The full player's progress and buttons. |

Parts not marked *a control* are containers. You may flatten one with `display: contents`, and its children become items of its parent's layout. Encore does this to the player bar.

### Classes and ids

What Rainy builds over and over has a class of its own, and a few controls have an id. These are public too.

| Selector | |
| --- | --- |
| `.song-card`, `.song-card-horizontal`, `.song-row` | A song as a card in a grid or shelf, as a wide card in a horizontal shelf, and as a row in a list. |
| `.song-artwork`, `.song-info`, `.song-title`, `.song-artist`, `.play-btn-overlay` | Inside a song card: the cover, the text under it, the title, the artists, and the play button over the cover on hover. |
| `.album-track-row`, `.artist-track-row`, `.recent-song-row` | A track of an album page, a song on an artist's page, a song in Recently Played. |
| `.album-card`, `.album-card-cover` | An album in the Albums grid, and its cover. |
| `.artist-circle-card` | An artist in the Artists grid. |
| `.mix-card` | A mix in Smart Mix. |
| `.discover-item` | A search result in Discover. |
| `.friend-row` | A friend, request or invite. |
| `.library-section`, `.section-heading`, `.horizontal-scroll-content` | A shelf of the library, its title, and its cards in a row that scrolls sideways. |
| `.section-title` | The big title of the library and playlist views. |
| `.nav-item`, `.nav-header`, `#sidebar-playlists .nav-item` | An entry of the sidebar navigation (`.active` when it is the current view), the title of a group (in Browse it is also the button that folds it), and a playlist in the sidebar. |
| `.btn` | A button. `.btn-primary`, `.btn-secondary` and `.btn-danger` say which kind. |
| `.icon-btn` | A round button with only an icon (`.icon-btn-small` too). |
| `.control-btn` | A player control; `.play-pause` is the big one. |
| `#shuffle-btn`, `#prev-btn`, `#play-pause-btn`, `#next-btn`, `#repeat-btn` | The transport, in the player bar. |
| `#keep-btn`, `#like-btn`, `#dislike-btn`, `#queue-btn`, `#player-more-btn` | Keep a radio song (only while one plays), like, dislike, the queue and the More menu, in the player bar. |
| `.progress-bar`, `.progress-fill`, `.progress-time` | The player bar's progress bar, the part played, and the times either side of it (`.current` is the first). |
| `.now-playing-artwork` | The cover of the song playing, in the player bar. |
| `.recent-tab`, `.view-toggle-btn` | A tab or filter chip, and the grid/list switch of a view (`.active` when chosen). |
| `.form-input`, `.toggle-switch` | A text field or select, and an on/off switch. |
| `.settings-card`, `.settings-row` | A card of rows in Settings, and one setting in it. |
| `.modal-content` | The box of a dialog (`.modal-header` and `.modal-body` inside). |
| `.context-menu`, `.context-menu-item` | A menu (the song menu, the player bar's More menu), and an entry of it. |
| `.toast` | A notice (`.success`, `.error`, `.info`). |
| `.global-search-overlay`, `.shortcut-overlay` | The global search palette and the keyboard shortcuts sheet. |
| `.fs-side-tab`, `.fs-artwork-container` | A tab of the full player's side panel (queue, lyrics; `.active` when chosen), and its album art. |
| `.fs-backdrop`, `.fs-brand`, `.fs-title`, `.fs-artist`, `.fs-side-tabs`, `.fs-control-btn`, `.fs-progress-fill`, `.fs-queue-item` | In the full player: the background (the blurred album art), the Rainy mark, the song's title and artist, the tabs of the side panel, a button of its own controls, the played part of its progress, and a song in its queue (`.active` is the one playing). |
| `#sidebar-toggle`, `.header-icon-btn`, `#search-input`, `#user-avatar`, `.dropdown-item` | In the top bar: the button that opens or folds the navigation, a round icon button, the search field, the user's initial, and an entry of the account menu. |
| `.nav-more-toggle`, `#nav-browse-toggle`, `.nav-header-row`, `#sidebar-new-playlist` | In the navigation: the "More" row, the title of the Browse group (which folds it), the title row of Playlists, and its New playlist button. |
| `.view-toggle`, `.songs-list`, `.section-header-row`, `.section-sort`, `#sort-select`, `.songs-grid-section` | In the library: the grid/list switch, the songs as a list, a shelf's title row with a control beside it, the sort of All songs and its select, and the cards of All songs in a grid. |
| `.song-artwork-overlay`, `.song-menu-btn`, `.song-duration` | In a song card: what darkens the cover on hover, the menu button (three dots), and the length. |
| `.song-row-artwork`, `.song-row-title`, `.song-row-artist`, `.song-row-album`, `.song-row-duration` | In a song's list row: its cover, title, artists, album and length. |
| `.album-card-title`, `.album-card-artist`, `.album-card-meta` | In an album card: its title, artists, and song count and length. |
| `.album-detail-hero`, `.album-detail-cover`, `.album-detail-type`, `.album-detail-title`, `.album-detail-artist`, `.album-detail-meta`, `.album-detail-tracks`, `.album-play-btn`, `.album-back-btn` | An album's page: its head, cover, kind ("Album"), title, artists, details, songs, Play (on mix pages too), and Back. |
| `.albums-search-wrapper`, `.albums-search-input`, `.albums-sort-select`, `.artists-search-wrapper`, `.artists-search-input` | The search boxes and fields of the Albums and Artists views, and the sort of Albums. |
| `.artist-hero`, `#artist-back-btn`, `#artist-play-all-btn`, `.artist-tracks-list` | An artist's page: its head, Back, Play all, and its songs. |
| `.recent-content`, `.recent-song-cover`, `.recent-song-title` | Recently played: its content, and the cover and title in a row. |
| `.discover-item-cover`, `.discover-item-title`, `.discover-item-artist-album` | A Discover result's cover, title, and artist and album. |
| `.mix-hero`, `.mix-detail-head`, `.mix-card-title`, `.mix-card-sub`, `.mix-nav` | Smart Mix: the big mix at the top, the head of a mix's page, a mix card's name and line, and the arrows that scroll a row of mixes. |
| `#now-playing-title`, `#now-playing-artist`, `#volume-slider` | In the player bar: the title and artist of the song playing, and the volume slider. |
| `.settings-nav-item`, `.settings-row-label`, `.settings-row-hint`, `.toggle-slider` | In Settings: an entry of the navigation (`.active` when open), a setting's name and the line under it, and the track and knob of a switch. |
| `.modal-overlay` | The dimmed backdrop of a dialog (it holds `.modal-content`). |
| `#fs-volume-btn`, `#fs-lightshow-btn`, `#fs-close-btn`, `.fs-buttons`, `.fs-progress-bar`, `.fs-time` | In the full player: its volume, light show and close buttons, the row of its own buttons, its progress bar and the times beside it. |
| `.fs-queue-cover`, `.fs-queue-title`, `.fs-queue-artist`, `.fs-queue-duration`, `.fs-queue-menu-btn`, `.fs-queue-drag-handle` | In a song of the full player's queue: its cover, title, artist, length, menu button and the handle to reorder it. |
| `.title-row`, `#playlist-menu-container`, `#playlist-settings-btn`, `.playlist-actions`, `#playlist-play-btn` | A playlist's head: the row of its title and menu, the menu (button and dropdown), its button, and its Play. |
| `.album-detail-info`, `.album-track-num`, `.album-track-title`, `.album-track-artist`, `.album-track-duration` | An album's page: the words and buttons beside the cover, and a track's number, title, artist and length. |

The state classes `active`, `selected`, `playing`, `current`, `collapsed`, `open`, `hidden`, `no-anime`, `success`, `error`, `info` and `warning` may be combined with any of these, and the full player says which one it is with `mode-standard` or `mode-modern`, `lyrics-active` and `lightshow-on`.

### States

Attributes on `<html>` say what the app is doing, so a theme can follow it: `html[data-view="albums"] [data-part~="main"] { … }`.

| Attribute | Values | |
| --- | --- | --- |
| `data-theme` | the id of the theme in use (`rainy` is Rainy's own) | Which theme is on. |
| `data-color-scheme` | `dark`, `light` | The theme's colour scheme. |
| `data-auth` | `setup`, `login`, `app` | Which screen is showing. |
| `data-view` | `library`, `playlist`, `albums`, `artists`, `recent`, `smartmix`, `discover`, `friends` | The view in the main area. |
| `data-playing` | `true`, `false` | Music is playing. |
| `data-has-track` | `true`, `false` | There is a song in the player. |
| `data-fullscreen` | `true`, `false` | The full player is open. |
| `data-settings` | `true`, `false` | Settings is open. |
| `data-sidebar` | `open`, `collapsed` | Whether the sidebar is folded to icons. |
| `class no-anime` | present or not | The user hid the anime logo. |

## Icons

Every icon Rainy draws is an `<svg data-icon="name">`, and a theme can bring its own drawing for any of them. Give the names and SVG files under `icons` in the manifest:

```json
"icons": { "play": "icons/play.svg", "pause": "icons/pause.svg", "library-music": "icons/home.svg" }
```

An icon file holds shapes only: `path`, `circle`, `rect`, `ellipse`, `line`, `polyline`, `polygon` and `g`, with their geometry and paint, in any `viewBox`. A file with scripts, links, images, styles or text is refused when the package is installed, and whatever a file holds, only its shapes reach the page. Leave out `fill` to take the colour of the icon's place (Rainy's CSS and yours colour icons through `fill`). Icons a theme does not bring stay Rainy's, and icons Rainy draws later (a new view, a menu just opened) are replaced too. Material Symbols, for instance, work as they come.

| Icon | |
| --- | --- |
| `add` | Add, new (a plus) |
| `album` | An album |
| `arrow-back` | Go back |
| `arrow-forward` | Go on, submit |
| `auto-awesome` | Automatic, magic (sparkles) |
| `autorenew` | Jobs running again |
| `bolt` | Energy |
| `bookmark` | Saved |
| `build` | Maintenance (a wrench) |
| `cast` | Cast to a device, Rainy Connect |
| `check` | Done |
| `check-circle` | Success |
| `chevron-left` | Scroll back |
| `chevron-right` | Scroll on, open |
| `close` | Close, cancel |
| `cloud-download` | Download from the internet |
| `crossfade` | Crossfade |
| `delete` | Delete |
| `description` | A file (export) |
| `disc` | A disc |
| `drag-indicator` | Drag to reorder |
| `edit` | Edit, rename |
| `equalizer` | Equalizer |
| `error` | Error |
| `exit` | Leave |
| `expand-more` | Open a list or menu (a chevron down) |
| `explore` | Discover, explore |
| `fire` | Hot |
| `graphic-eq` | Light show |
| `grid-view` | Grid view |
| `group` | Friends, users, sharing |
| `guitar` | Instrumental |
| `headphones` | Listening |
| `heart` | Loved |
| `help` | Help |
| `history` | Recently played |
| `image` | A picture, cover |
| `import` | Import |
| `info` | About, information |
| `key` | Password |
| `keyboard` | Keyboard shortcuts |
| `library-music` | The library |
| `list-view` | List view |
| `logout` | Sign out |
| `lyrics` | Lyrics |
| `menu` | Open the navigation (three lines) |
| `monitor` | A computer |
| `moon` | Night, sleep |
| `more-horiz` | More (three dots in a row) |
| `more-vert` | More actions (three dots in a column) |
| `music-note` | A song, music, no cover |
| `palette` | Colour, appearance |
| `pause` | Pause |
| `person` | An artist, a user |
| `phone` | A phone |
| `play` | Play |
| `play-circle` | Play (in a circle) |
| `playlist-add` | Add to a playlist |
| `playlist-play` | Play a playlist |
| `queue-music` | The queue |
| `queue-play-next` | Play next |
| `radio` | Radio |
| `refresh` | Refresh, scan |
| `remove` | Remove (a minus) |
| `repeat` | Repeat |
| `save` | Save |
| `save-alt` | Keep, download to the device |
| `schedule` | Time, schedule |
| `search` | Search |
| `settings` | Settings |
| `share` | Share |
| `shield` | Role, permissions |
| `shuffle` | Shuffle, mix |
| `skip-next` | Next track |
| `skip-previous` | Previous track |
| `sort` | Sort |
| `speed` | Playback speed |
| `spinner` | Loading (drawn as an arc) |
| `spotify` | Spotify |
| `star` | Favourite |
| `sun` | Day |
| `sync` | Sync |
| `thumb-down` | Dislike |
| `thumb-up` | Like |
| `timer` | Sleep timer |
| `tune` | Options, adjust |
| `upload` | Upload |
| `volume-up` | Volume |
| `yt` | YouTube |

## Words

A theme can call things by other names: "Home" for Rainy's Library, "Explore" for Discover. Under `strings`, map Rainy's English text (the source text every translation starts from) to yours, per language:

```json
"strings": {
    "en": { "Library": "Home", "Search your library": "Search songs, albums, artists" },
    "es": { "Library": "Inicio", "Search your library": "Busca canciones, álbumes, artistas" }
}
```

Only the language in use is read: give each language you want to change, and the others keep Rainy's own words. A text is plain (no markup), up to 160 characters. The English texts are the keys of Rainy's translations, in static/js/i18n/locales/ (`es.js` lists them next to their Spanish). A key that Rainy stops using simply stops applying.

## Laying things out

A theme can move almost anything. Encore turns the player bar into one row with the progress along its top edge. Daylight only recolours. Some advice so a layout keeps working as Rainy grows:

- **Leave room for what comes later.** A region you lay out yourself will get new buttons one day. In a grid, set `grid-auto-flow: column` (or `row`) so an item you did not place gets a cell of its own instead of landing outside the box. In a flex row, let it wrap, or let it scroll. Encore's player bar does this: a button Rainy adds to the transport appears at the end of the bar, styled like its neighbours.
- **Do not count children.** `:nth-child(3)` is "the third button today". Use the ids and classes above.
- **Keep phones in mind.** Your rules apply at every width. Encore keeps its big layout changes inside `@media (min-width: 900px)` and only recolours on phones, where Rainy's own layout already fits.
- **Move the insets with the chrome.** If the player or the navigation moves, update `--shell-inset-*` so the content is not hidden behind them.
- **Mind the light show.** While an environment is on stage it styles the full player too, and its rules win over yours there. Leave the full player mostly to it.

## A theme's module

The `entry` module is for decoration: a backdrop that follows the music, grain, a glow. Its default export is a class:

| | |
| --- | --- |
| `mount(ctx)` | Build everything. May be `async`; 5 seconds at most. |
| `unmount()` | Release what the page cannot release for you (timers, workers, WebGL contexts). |

```js
export default class MyTheme {
    mount(ctx) {
        this.glow = document.createElement('div');
        this.glow.className = 'theme-glow';
        ctx.layers.back.appendChild(this.glow);
        ctx.on('track', async (track) => {
            const colors = track && track.cover ? await ctx.colors(track.cover) : null;
            ctx.setVar('--theme-glow', colors ? colors.vivid.join(' ') : null);
        });
    }

    unmount() {}
}
```

### `ctx`

| | |
| --- | --- |
| `ctx.layers.back`, `ctx.layers.front` | Your own layers, each filling the window: one behind the app, one over it. They never take a click. Rainy's backgrounds are opaque, so to see the back layer make the regions over it transparent in your stylesheet (`[data-part~="app"] { background: transparent }`); Encore does. |
| `ctx.state.get()` | `{ view, auth, playing, hasTrack, fullscreen, settings, sidebar, track }`. `track` is `{ id, title, artist, album, cover }` or `null`. |
| `ctx.on(event, fn)` | `'track'`, `'view'`, `'playing'`, `'fullscreen'`, `'settings'`: the new value of that state. `'state'`: `(name, value, state)` for any of them. `'accent'`: the accent in effect, as `#rrggbb`. `'visibility'`: whether the page is visible. Returns a function that stops. |
| `ctx.setVar(name, value)` | Set one of your own `--theme-*` variables on the page (`null` removes it), for your stylesheets to use. |
| `ctx.colors(url)` | `{ average, vivid }`, each `[r, g, b]`, of a picture from this server (a cover). |
| `ctx.asset(path)` | The address of a file of your package. |
| `ctx.reducedMotion`, `ctx.lowPower` | The user asked for less motion, or for Low Performance Mode. Keep still, or keep it light. |
| `ctx.signal` | An `AbortSignal`, aborted when your theme comes off. |
| `ctx.locale`, `ctx.id`, `ctx.manifest`, `ctx.api` | Language of the interface, who you are, and the contract version. |
| `ctx.toast(message)` | A short notice. |
| `ctx.fail(error)` | You cannot go on. Your module is taken off; your stylesheets stay. |

If `mount` throws or takes too long, or any of your listeners throws three times in a row, the module is taken off. Rainy shows a notice and keeps your stylesheets: the theme stays on, without its decoration. If a stylesheet does not load, the whole theme comes off and Rainy's own look takes its place until the page is reloaded.

### Rules of the house

- **Draw in your layers.** Talk to Rainy through `ctx`, and do not reach for `window.app`, `window.player`, Rainy's API or the page's other elements. That keeps your theme working when Rainy changes, and lets a future Rainy run modules isolated.
- **Pause when no one is looking.** Stop animating when the page is hidden (`'visibility'`), and while the full player is open, where the light show needs the GPU.
- **Respect the user.** Honour `ctx.reducedMotion` and `ctx.lowPower`. Never flash.
- **Carry your libraries.** Put what you import inside the package; do not load code from other servers.

## Safe mode and recovery

- `?theme=off` at the end of any Rainy address shows Rainy's own look in that tab until `?theme=on` or the tab is closed. **Alt+Shift+D** does the same from the keyboard, and turns it back off. The user's pick is not changed.
- An administrator can switch a theme off (Settings → Appearance → Installed Themes). Everyone wearing it goes back to the default on their next visit, or at once if they are on Settings.
- A theme's pick that is no longer installed falls back to the server's default, then to Rainy.

## Checking a theme

Settings → Appearance → Installed Themes → **Check the theme in use** (administrators) visits every view and the full player. On each one it compares every control (buttons, links, fields, anything focusable) with the theme's styles switched off and on. It reports a control the theme:

- hides;
- shrinks below 8 px;
- covers with something else, so a click at its centre lands elsewhere;
- pushes off screen where it cannot be scrolled to;
- leaves with text contrast under 3:1 where Rainy's own look had more.

Run it at a desktop width and at a phone width (the browser's device toolbar), with a song playing. It finds problems in whatever Rainy adds later too, with no list to keep up to date.

The same check runs from the browser console:

```js
const audit = await import('/js/theme/audit.js');
audit.describeReport(await audit.auditAllViews());
```

or from [tests/browser/theme-audit.js](../tests/browser/theme-audit.js).

## Develop

Start Rainy in development mode with a folder of unpacked packages:

```bash
RAINY_DEV=1 RAINY_THEMES_DEV=packages .venv/bin/python app.py
```

Every folder in it that holds a valid `rainy-theme.json` is listed as a theme, tagged *Development*, and served straight from disk: change a file and pick the theme again, or reload. A folder stands in for the installed package with the same id. Folders that do not validate are reported on the server's console. One folder can hold environments and themes both (`RAINY_ENVIRONMENTS_DEV=packages` too); each kind takes the folders with its own manifest.

## Pack and install

```bash
python scripts/pack_package.py packages/encore
```

writes `dist/encore-1.0.0.zip`, after checking the folder exactly as the server checks an upload. It lists the internal names your stylesheets use. Then, as an administrator: Settings → Appearance → Installed Themes → *Install package (.zip)*. From there a theme can be switched off, made everyone's default, or removed. Installing a package with an id that is already installed updates it: you get the new version at once, and everyone else on their next visit.

Installed packages are kept in the database, so they survive a rebuilt container. The unpacked copy they are served from is rebuilt whenever it is missing. A theme's files are served without a session, so the sign-in screen can wear the theme a device last wore.

## For Rainy's developers

Themes keep working as Rainy changes because the contract is checked by `tests/test_theme_contract.py`:

- **New UI uses tokens.** Use `var(--…)` for colours, never a literal. For a wash of the text colour, use `color-mix(in srgb, var(--text-primary) 10%, transparent)` or a `--tint-*`. The test counts hard-coded colours and `!important` rules in Rainy's CSS, and fails if either grows.
- **A new control goes inside a region.** Any button, link or field in index.html must sit inside a `data-part`. A new region gets a part. Add it to static/js/theme/contract.json and to this file.
- **Renaming or removing something in the contract breaks installed themes.** The test fails if a part disappears from the page or a listed class is no longer built. Keep the old name working, or wait for a new `api` version.
- **State goes through classes or `.hidden`, not inline styles.** If something must stay hidden whatever a theme says (a closed panel, an inactive tab), express it with `.hidden` or `[hidden]`, or add its rule to static/css/guard.css.
- **A new icon gets a name.** Every `<svg>` carries `data-icon` with a name from contract.json's icons (the test fails on an unnamed one). To switch an icon in JavaScript, use `setIcon(svg, name, path)` from static/js/helper/icons.js: never rewrite its path or markup by hand, or a theme's icon would be lost.
- **New words go through `t()`.** That is what lets a theme rename them, as well as translate them.
- **A hideable part holds no controls.** Mark only decoration (a title, a count, a logo) as hideable; the test fails if a hideable part contains a button, a link or a field.
- **A new view gets a value for `data-view`** (through the `current-view-type` context). Add it to the states table.
