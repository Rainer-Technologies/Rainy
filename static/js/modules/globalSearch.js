/**
 * Global Search Overlay (º key / / key).
 * Searches songs, artists, albums, and playlists simultaneously.
 * Renders a command-palette-style overlay with grouped results.
 */
import { Logger } from '../helper/logger.js';
import { Utils } from './utils.js';

export class GlobalSearch {
    constructor(app, player) {
        this.app = app;
        this.player = player;
        this.isOpen = false;
        this.results = { songs: [], artists: [], albums: [], playlists: [] };
        this._buildDOM();
        this._bindEvents();
        window.__globalSearch = this;
        Logger.info('Global search overlay registered');
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
                    <kbd class="gs-kbd">ESC</kbd>
                </div>
                <div id="gs-results" class="gs-results">
                    <div class="gs-empty">Type to search across your library</div>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        this.overlay = overlay;
        this.input = overlay.querySelector('#gs-input');
        this.resultsEl = overlay.querySelector('#gs-results');
    }

    _bindEvents() {
        this.overlay.querySelector('.gs-backdrop').addEventListener('click', () => this.close());
        this.input.addEventListener('input', () => this._onInput());
        this.input.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this.close();
            if (e.key === 'Enter') this._onEnter();
        });
    }

    toggle() { this.isOpen ? this.close() : this.open(); }

    open() {
        this.isOpen = true;
        this.overlay.classList.remove('hidden');
        this.input.value = '';
        this._renderEmpty('Type to search across your library');
        setTimeout(() => this.input.focus(), 0);
    }

    close() {
        this.isOpen = false;
        this.overlay.classList.add('hidden');
        this.input.blur();
    }

    _onInput() {
        const q = this.input.value.trim().toLowerCase();
        if (!q) { this._renderEmpty('Type to search across your library'); return; }
        this._search(q);
    }

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

    _onEnter() {
        // Select the first song result on Enter
        if (this.results.songs.length) this._onSelect('song', 0);
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
}
