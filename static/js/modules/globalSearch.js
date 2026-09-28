/**
 * Global Search Overlay (º key / / key) — spawned via keyboard shortcuts only.
 * Two modes:
 *  - Library: searches songs, artists, albums, and playlists simultaneously.
 *  - Discover: quick YouTube Music search to preview a song or download it
 *    into the library.
 * Renders a command-palette-style overlay with grouped results.
 */
import { Logger } from '../helper/logger.js';
import { Utils } from './utils.js';
import { useMusicService } from '../services/music.js';

const MODE_LIBRARY = 'library';
const MODE_DISCOVER = 'discover';
const MODE_STORAGE_KEY = 'rainy.globalSearch.mode';

const SVG_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M8 5v14l11-7z"/></svg>';
const SVG_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
const SVG_DOWNLOAD = '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>';

export class GlobalSearch {
    constructor(app, player) {
        this.app = app;
        this.player = player;
        this.isOpen = false;
        this.results = { songs: [], artists: [], albums: [], playlists: [] };
        this.discoverResults = [];
        this.mode = this._loadMode();
        this._debounceTimer = null;
        this._searchSeq = 0;
        this._buildDOM();
        this._bindEvents();
        window.__globalSearch = this;
        this._applyModeUI();
        Logger.info('Global search overlay registered');
    }

    _loadMode() {
        try {
            const stored = localStorage.getItem(MODE_STORAGE_KEY);
            return stored === MODE_DISCOVER ? MODE_DISCOVER : MODE_LIBRARY;
        } catch (e) {
            return MODE_LIBRARY;
        }
    }

    _buildDOM() {
        const overlay = document.createElement('div');
        overlay.id = 'global-search-overlay';
        overlay.className = 'global-search-overlay hidden';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', 'Global search');
        overlay.innerHTML = `
            <div class="gs-backdrop"></div>
            <div class="gs-panel">
                <div class="gs-input-row">
                    <svg class="gs-icon" viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"/></svg>
                    <input type="text" id="gs-input" class="gs-input" placeholder="Search songs, artists, albums, playlists…" autocomplete="off" spellcheck="false" />
                    <div class="gs-seg" role="tablist" aria-label="Search mode">
                        <button type="button" class="gs-seg-btn active" data-mode="${MODE_LIBRARY}" role="tab" aria-selected="true">Library</button>
                        <button type="button" class="gs-seg-btn" data-mode="${MODE_DISCOVER}" role="tab" aria-selected="false">Discover</button>
                    </div>
                </div>
                <div id="gs-loading" class="gs-loading hidden">Searching YouTube Music…</div>
                <div id="gs-results" class="gs-results">
                    <div class="gs-empty">Type to search across your library</div>
                </div>
                <div class="gs-actions">
                    <span><kbd class="gs-kbd">Ctrl</kbd><kbd class="gs-kbd">1</kbd> Library</span>
                    <span><kbd class="gs-kbd">Ctrl</kbd><kbd class="gs-kbd">2</kbd> Discover</span>
                    <span class="gs-actions-spacer"></span>
                    <span><kbd class="gs-kbd">Esc</kbd> Close</span>
                </div>
                <audio id="gs-preview-audio" class="hidden" preload="none"></audio>
            </div>
        `;
        document.body.appendChild(overlay);
        this.overlay = overlay;
        this.input = overlay.querySelector('#gs-input');
        this.resultsEl = overlay.querySelector('#gs-results');
        this.loadingEl = overlay.querySelector('#gs-loading');
        this.audio = overlay.querySelector('#gs-preview-audio');
    }

    _bindEvents() {
        this.overlay.querySelector('.gs-backdrop').addEventListener('click', () => this.close());
        this.input.addEventListener('input', () => this._onInput());
        this.overlay.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.close();
                return;
            }
            // Mode shortcuts: Ctrl+1 = Library, Ctrl+2 = Discover.
            // Ctrl is required so they don't collide with typing digits.
            if ((e.key === '1' || e.key === '2') && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                this.setMode(e.key === '1' ? MODE_LIBRARY : MODE_DISCOVER);
                return;
            }
            if (e.key === 'Enter') this._onEnter();
        });

        this.overlay.querySelectorAll('.gs-seg-btn').forEach(btn => {
            btn.addEventListener('click', () => this.setMode(btn.dataset.mode));
        });

        // Reset preview buttons when streaming stops for any reason
        this.audio.addEventListener('pause', () => this._resetPreviewIcons());
        this.audio.addEventListener('ended', () => this._resetPreviewIcons());
    }

    toggle() { this.isOpen ? this.close() : this.open(); }

    open() {
        this.isOpen = true;
        this.overlay.classList.remove('hidden');
        this.input.value = '';
        this._applyModeUI();
        this._renderEmpty(this.mode === MODE_DISCOVER
            ? 'Search YouTube Music for songs to preview or download'
            : 'Type to search across your library');
        setTimeout(() => this.input.focus(), 0);
    }

    close() {
        this.isOpen = false;
        this._stopPreview();
        this.overlay.classList.add('hidden');
        this.input.blur();
    }

    /** Switch the overlay between Library and Discover search modes. */
    setMode(mode) {
        if (mode !== MODE_LIBRARY && mode !== MODE_DISCOVER) mode = MODE_LIBRARY;
        if (this.mode === mode) return;
        this.mode = mode;
        try { localStorage.setItem(MODE_STORAGE_KEY, mode); } catch (e) { /* ignore */ }
        this._stopPreview();
        // The two modes search completely different things (your library vs
        // YouTube Music) — a query typed for one has no meaning in the other.
        // Clear the box on switch so the input never carries stale text.
        this.input.value = '';
        clearTimeout(this._debounceTimer);
        this._applyModeUI();
        this._renderEmpty(mode === MODE_DISCOVER
            ? 'Search YouTube Music for songs to preview or download'
            : 'Type to search across your library');
        if (this.isOpen) setTimeout(() => this.input.focus(), 0);
    }

    _applyModeUI() {
        const discover = this.mode === MODE_DISCOVER;
        this.overlay.querySelectorAll('.gs-seg-btn').forEach(btn => {
            const active = btn.dataset.mode === this.mode;
            btn.classList.toggle('active', active);
            btn.setAttribute('aria-selected', String(active));
        });
        this.input.placeholder = discover
            ? 'Search YouTube Music for songs…'
            : 'Search songs, artists, albums, playlists…';
        const headerInput = document.getElementById('search-input');
        if (headerInput) {
            headerInput.placeholder = discover ? 'Search YouTube to discover' : 'Search your library';
        }
    }

    _onInput() {
        const q = this.input.value.trim().toLowerCase();
        if (this.mode === MODE_DISCOVER) {
            this._debouncedDiscoverSearch(q);
            return;
        }
        if (!q) { this._renderEmpty('Type to search across your library'); return; }
        this._search(q);
    }

    _onEnter() {
        // Only act on Enter when the search input has focus. When a result
        // button is focused (keyboard navigation), let the button's own
        // activation handle it — Enter would otherwise fire both.
        if (document.activeElement !== this.input) return;
        if (this.mode === MODE_DISCOVER) {
            const q = this.input.value.trim().toLowerCase();
            clearTimeout(this._debounceTimer);
            if (q) this._discoverSearch(q);
            return;
        }
        // Select the first song result on Enter
        if (this.results.songs.length) this._onSelect('song', 0);
    }

    // --- Library mode (existing behavior) ---

    _search(q) {
        const app = this.app;
        const songs = (app.songs || []).filter(s =>
            (s.title || '').toLowerCase().includes(q) ||
            (s.artist || '').toLowerCase().includes(q) ||
            (s.album || '').toLowerCase().includes(q)
        ).slice(0, 8);

        // Unique artists & albums from matches. Artist metadata can contain
        // comma-separated collaborators, so index each name independently.
        const artistMap = new Map();
        const albumSet = new Set();
        (app.songs || []).forEach(s => {
            if (s.artist) {
                Utils.splitArtists(s.artist).forEach(artist => {
                    const key = artist.toLowerCase();
                    if (key.includes(q) && !artistMap.has(key)) artistMap.set(key, artist);
                });
            }
            if ((s.album || '').toLowerCase().includes(q) && s.album && s.album !== 'Unknown Album') albumSet.add(s.album);
        });
        const artists = [...artistMap.values()].slice(0, 5);
        const albums = [...albumSet].slice(0, 5);

        const playlists = (app.playlists || []).filter(p =>
            (p.name || '').toLowerCase().includes(q)
        ).slice(0, 5);

        this.results = { songs, artists, albums, playlists };
        this._render();
    }

    _renderEmpty(msg) {
        this.resultsEl.innerHTML = `<div class="gs-empty">${Utils.escapeHtml(msg)}</div>`;
    }

    _render() {
        const { songs, artists, albums, playlists } = this.results;
        if (!songs.length && !artists.length && !albums.length && !playlists.length) {
            this._renderEmpty('No results found');
            return;
        }
        let html = '';

        if (songs.length) {
            html += `<div class="gs-group"><div class="gs-group-title">Songs</div>`;
            songs.forEach((s, i) => {
                const cover = s.cover_path
                    ? `<img src="/api/music/cover/${encodeURIComponent(s.cover_path)}" alt="" loading="lazy">`
                    : `<div class="gs-no-cover">♪</div>`;
                html += `<div class="gs-item" role="button" tabindex="0" data-type="song" data-index="${i}">
                    <div class="gs-item-cover">${cover}</div>
                    <div class="gs-item-text">
                        <div class="gs-item-title">${Utils.escapeHtml(s.title)}</div>
                        <div class="gs-item-sub">${Utils.escapeHtml(s.artist)}</div>
                    </div>
                </div>`;
            });
            html += `</div>`;
        }

        if (artists.length) {
            html += `<div class="gs-group"><div class="gs-group-title">Artists</div>`;
            artists.forEach((a, i) => {
                html += `<div class="gs-item" role="button" tabindex="0" data-type="artist" data-index="${i}">
                    <div class="gs-item-cover"><div class="gs-no-cover">👤</div></div>
                    <div class="gs-item-text"><div class="gs-item-title">${Utils.escapeHtml(a)}</div></div>
                </div>`;
            });
            html += `</div>`;
        }

        if (albums.length) {
            html += `<div class="gs-group"><div class="gs-group-title">Albums</div>`;
            albums.forEach((a, i) => {
                html += `<div class="gs-item" role="button" tabindex="0" data-type="album" data-index="${i}">
                    <div class="gs-item-cover"><div class="gs-no-cover">💿</div></div>
                    <div class="gs-item-text"><div class="gs-item-title">${Utils.escapeHtml(a)}</div></div>
                </div>`;
            });
            html += `</div>`;
        }

        if (playlists.length) {
            html += `<div class="gs-group"><div class="gs-group-title">Playlists</div>`;
            playlists.forEach((p, i) => {
                html += `<div class="gs-item" role="button" tabindex="0" data-type="playlist" data-index="${i}">
                    <div class="gs-item-cover"><div class="gs-no-cover">📁</div></div>
                    <div class="gs-item-text"><div class="gs-item-title">${Utils.escapeHtml(p.name)}</div></div>
                </div>`;
            });
            html += `</div>`;
        }

        this.resultsEl.innerHTML = html;
        this.resultsEl.querySelectorAll('.gs-item').forEach(el => {
            el.addEventListener('click', () => this._onSelect(el.dataset.type, parseInt(el.dataset.index)));
            el.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    this._onSelect(el.dataset.type, parseInt(el.dataset.index));
                }
            });
        });
    }

    async _onSelect(type, index) {
        const app = this.app;
        if (type === 'song') {
            const song = this.results.songs[index];
            if (song && this.player) {
                // Play within the current library context
                const idx = (app.songs || []).findIndex(s => s.id === song.id);
                if (idx >= 0) this.player.playSong(idx, app.songs, { type: 'library', id: null });
            }
        } else if (type === 'artist') {
            const artist = this.results.artists[index];
            if (artist && app.switchToArtistsView) app.switchToArtistsView(artist);
        } else if (type === 'album') {
            const album = this.results.albums[index];
            if (album && window.newViews?.openAlbumFromSearch) {
                await window.newViews.openAlbumFromSearch(album);
            }
        } else if (type === 'playlist') {
            const pl = this.results.playlists[index];
            if (pl && app.openPlaylist) app.openPlaylist(pl.id);
        }
        this.close();
    }

    // --- Discover mode (quick preview / download) ---

    _debouncedDiscoverSearch(q) {
        clearTimeout(this._debounceTimer);
        if (!q) {
            this.discoverResults = [];
            this._renderEmpty('Search YouTube Music for songs to preview or download');
            return;
        }
        this._debounceTimer = setTimeout(() => this._discoverSearch(q), 300);
    }

    async _discoverSearch(q) {
        const seq = ++this._searchSeq;
        this.resultsEl.innerHTML = '';
        this.loadingEl.classList.remove('hidden');
        try {
            const data = await useMusicService().discover.search(q);
            if (seq !== this._searchSeq) return; // stale response, a newer search is in flight
            this.loadingEl.classList.add('hidden');
            if (data.error) {
                Logger.error(data.error);
                this._renderEmpty('Search failed — try again in a moment');
                return;
            }
            const results = data.value || [];
            this.discoverResults = results;
            this._renderDiscoverResults(results);
        } catch (e) {
            if (seq !== this._searchSeq) return;
            this.loadingEl.classList.add('hidden');
            Logger.error(e);
            this._renderEmpty('Search failed — try again in a moment');
        }
    }

    _renderDiscoverResults(songs) {
        if (!songs.length) {
            this._renderEmpty('No songs found — try a different title or artist');
            return;
        }
        const app = this.app;
        const matches = new Map();

        let html = '<div class="gs-group"><div class="gs-group-title">Discover — YouTube Music</div>';
        songs.forEach((s, i) => {
            const match = app.isSongInLibrary ? app.isSongInLibrary(s) : null;
            matches.set(i, match);
            const inLib = match !== null;
            const cover = s.cover_url
                ? `<img src="${Utils.escapeHtml(s.cover_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
                : `<div class="gs-no-cover">♪</div>`;
            const sub = Utils.escapeHtml(s.artist)
                + (s.duration_text ? ` • ${Utils.escapeHtml(s.duration_text)}` : '');

            html += `
                <div class="gs-item gs-discover-item${inLib ? ' in-library' : ''}" data-index="${i}">
                    <div class="gs-item-cover">${cover}</div>
                    <div class="gs-item-text">
                        <div class="gs-item-title">${Utils.escapeHtml(s.title)}</div>
                        <div class="gs-item-sub">${sub}</div>
                    </div>
                    <div class="gs-discover-actions">
                        <button type="button" class="gs-act-btn gs-act-preview" data-action="preview" data-index="${i}"
                            data-play-label="${inLib ? 'Play' : 'Preview'}">${SVG_PLAY}<span>${inLib ? 'Play' : 'Preview'}</span></button>
                        <button type="button" class="gs-act-btn gs-act-download" data-action="download" data-index="${i}"
                            ${inLib ? 'disabled' : ''}>${SVG_DOWNLOAD}<span>${inLib ? 'In Library' : 'Download'}</span></button>
                    </div>
                </div>`;
        });
        html += '</div>';

        this.resultsEl.innerHTML = html;

        // Cover fallback
        this.resultsEl.querySelectorAll('.gs-discover-item img').forEach(img => {
            img.onerror = () => {
                img.onerror = null;
                const d = document.createElement('div');
                d.className = 'gs-no-cover';
                d.textContent = '♪';
                img.replaceWith(d);
            };
        });

        this.resultsEl.querySelectorAll('.gs-act-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const song = this.discoverResults[parseInt(btn.dataset.index)];
                if (!song) return;
                if (btn.dataset.action === 'preview') {
                    this._togglePreview(song, btn, matches.get(parseInt(btn.dataset.index)));
                } else {
                    this._downloadSong(song, btn);
                }
            });
        });
    }

    _togglePreview(song, btn, libraryMatch) {
        if (libraryMatch) {
            // Already in the library → play it with the main player
            this._stopPreview();
            const player = window.player;
            if (player && player.audio && !player.audio.paused) {
                player.audio.pause();
                player.updatePlayButton();
            }
            if (player) player.playSong(0, [libraryMatch], { type: 'library', id: 'library' });
            return;
        }

        const audio = this.audio;
        if (!audio.paused && audio.dataset.videoId === song.videoId) {
            audio.pause(); // pause listener resets the button
            return;
        }

        // Stop the main player so previews stream cleanly
        const player = window.player;
        if (player && player.audio && !player.audio.paused) {
            player.audio.pause();
            player.updatePlayButton();
        }

        this._resetPreviewIcons();
        audio.src = `/api/music/discover/preview/${encodeURIComponent(song.videoId)}`;
        audio.dataset.videoId = song.videoId;
        btn.querySelector('span').textContent = 'Pause';
        audio.play().catch(err => {
            Logger.error(err);
            this._resetPreviewIcons();
        });
    }

    _downloadSong(song, btn) {
        // Reuses the Discover page's download flow (imports via YouTube,
        // handles "already in library", refreshes the local song cache).
        if (!this.app.downloadDiscoverSong) return;
        this.app.downloadDiscoverSong(song, btn);
    }

    _stopPreview() {
        if (this.audio) {
            this.audio.pause();
            this.audio.src = '';
            delete this.audio.dataset.videoId;
        }
        this._resetPreviewIcons();
    }

    _resetPreviewIcons() {
        this.resultsEl.querySelectorAll('.gs-act-preview').forEach(btn => {
            btn.querySelector('span').textContent = btn.dataset.playLabel || 'Preview';
        });
    }
}