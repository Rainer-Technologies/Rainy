/**
 * New Views Module — Albums, Recently Played, Smart Mix
 * Handles rendering and interaction for the three new library views.
 */
import { Logger } from '../helper/logger.js';
import { Utils } from './utils.js';
import { useContext } from '../helper/context.js';
import { useAlbumService } from '../services/album.js';
import { usePlaybackService } from '../services/playback.js';

export class NewViews {
    constructor(app, player) {
        this.app = app;
        this.player = player;
        this.currentView = null;
        this.albumsCache = [];
        this.recentCache = [];
        this.topCache = [];
        this.statsCache = null;
        this.smartMixSongs = [];
        this.init();
    }

    init() {
        // Albums
        document.getElementById('nav-albums')?.addEventListener('click', (e) => {
            if (!this.app.shouldHandleInternalClick(e)) return;
            e.preventDefault();
            this.switchToAlbums();
        });
        document.getElementById('albums-search-input')?.addEventListener('input', (e) => {
            this.filterAlbums(e.target.value);
        });
        document.getElementById('albums-sort-select')?.addEventListener('change', (e) => {
            this.sortAlbums(e.target.value);
        });
        document.getElementById('album-back-btn')?.addEventListener('click', () => {
            this.showAlbumGrid();
        });

        // Recently Played
        document.getElementById('nav-recent')?.addEventListener('click', (e) => {
            if (!this.app.shouldHandleInternalClick(e)) return;
            e.preventDefault();
            this.switchToRecent();
        });
        document.querySelectorAll('.recent-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.recent-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                this.loadRecentTab(tab.dataset.tab);
            });
        });
        document.getElementById('clear-history-btn')?.addEventListener('click', () => {
            this.clearHistory();
        });

        // Smart Mix
        document.getElementById('nav-smartmix')?.addEventListener('click', (e) => {
            if (!this.app.shouldHandleInternalClick(e)) return;
            e.preventDefault();
            this.switchToSmartMix();
        });
        document.querySelectorAll('.smartmix-mode-card').forEach(card => {
            card.addEventListener('click', () => {
                this.generateSmartMix(card.dataset.mode);
            });
        });
        document.getElementById('smartmix-play-all')?.addEventListener('click', () => {
            this.playSmartMix();
        });

        Logger.info('New views module initialized');
    }

    // --- View Switching ---

    hideAllViews() {
        ['albums-view', 'recent-view', 'smartmix-view', 'discover-view', 'artists-view', 'friends-view'].forEach(id => {
            document.getElementById(id)?.classList.add('hidden');
        });
        document.getElementById('songs-grid')?.classList.add('hidden');
        document.getElementById('songs-list')?.classList.add('hidden');
        document.getElementById('empty-state')?.classList.add('hidden');
        document.getElementById('loading-container')?.classList.add('hidden');
        // Hide dashboard chrome so it doesn't bleed through
        document.querySelector('.section-header')?.classList.add('hidden');
        document.getElementById('library-stats')?.classList.add('hidden');
        document.querySelector('.view-toggle')?.classList.add('hidden');
    }

    /**
     * Hide only the new-feature views. Called by app.js when switching back
     * to Library / Discover / Artists so the new views don't linger.
     */
    hideNewViews() {
        ['albums-view', 'recent-view', 'smartmix-view', 'friends-view'].forEach(id => {
            document.getElementById(id)?.classList.add('hidden');
        });
    }

    updateNav(activeId) {
        document.querySelectorAll('.app-sidebar .nav-item').forEach(el => el.classList.remove('active'));
        document.getElementById(activeId)?.classList.add('active');
    }

    // --- Albums View ---

    async switchToAlbums({ updateUrl = true } = {}) {
        if (updateUrl) {
            return this.app.navigateTo('/albums');
        }

        this.currentView = 'albums';
        useContext().set('current-view-type', 'albums');
        this.hideAllViews();
        document.getElementById('albums-view').classList.remove('hidden');
        this.updateNav('nav-albums');
        document.querySelector('.section-title').textContent = 'Albums';
        document.getElementById('library-subtitle').textContent = 'Browse your music by album';
        document.querySelector('.view-toggle')?.classList.add('hidden');
        document.getElementById('library-stats')?.classList.add('hidden');
        document.getElementById('playlist-menu-container')?.classList.add('hidden');
        this.showAlbumGrid({ updateUrl: false });
        await this.loadAlbums();
    }

    async openAlbumFromSearch(albumName) {
        if (!albumName) return;
        const match = (this.app.songs || []).find(song => song.album === albumName);
        const artistName = match?.artist || '';
        const params = new URLSearchParams();
        if (artistName) params.set('artist', artistName);
        const suffix = params.toString() ? `?${params.toString()}` : '';
        return this.app.navigateTo(`/albums/${encodeURIComponent(albumName)}${suffix}`);
    }

    async loadAlbums(search = '', sort = 'name') {
        try {
            const res = await useAlbumService().getAll(search, sort);
            if (res.error) {
                Logger.error('Failed to load albums:', res.error);
                return;
            }
            this.albumsCache = res.value.albums || [];
            this.renderAlbums(this.albumsCache);
        } catch (e) {
            Logger.error('Album load error:', e);
        }
    }

    renderAlbums(albums) {
        const grid = document.getElementById('albums-grid-list');
        if (!albums.length) {
            grid.innerHTML = '<div class="empty-state"><h3>No Albums Found</h3><p>Try a different search or add more music.</p></div>';
            return;
        }
        grid.innerHTML = albums.map(album => `
            <div class="album-card" data-album="${Utils.escapeHtml(album.album)}" data-artist="${Utils.escapeHtml(album.artist)}">
                <div class="album-card-cover">
                    ${album.cover_path 
                        ? `<img src="/api/music/cover/${encodeURIComponent(album.cover_path)}" alt="${Utils.escapeHtml(album.album)}" loading="lazy">`
                        : '<div class="album-no-cover">💿</div>'}
                </div>
                <div class="album-card-info">
                    <div class="album-card-title">${Utils.escapeHtml(album.album)}</div>
                    <div class="album-card-artist">${Utils.escapeHtml(album.artist)}</div>
                    <div class="album-card-meta">${album.song_count} songs • ${Utils.formatDuration(album.total_duration)}</div>
                </div>
            </div>
        `).join('');

        grid.querySelectorAll('.album-card').forEach(card => {
            card.addEventListener('click', () => {
                this.openAlbumDetail(card.dataset.album, card.dataset.artist);
            });
        });
    }

    filterAlbums(query) {
        const q = query.toLowerCase().trim();
        if (!q) {
            this.renderAlbums(this.albumsCache);
            return;
        }
        const filtered = this.albumsCache.filter(a =>
            a.album.toLowerCase().includes(q) || a.artist.toLowerCase().includes(q)
        );
        this.renderAlbums(filtered);
    }

    sortAlbums(sortBy) {
        const sorted = [...this.albumsCache];
        switch (sortBy) {
            case 'name': sorted.sort((a, b) => a.album.localeCompare(b.album)); break;
            case 'artist': sorted.sort((a, b) => a.artist.localeCompare(b.artist) || a.album.localeCompare(b.album)); break;
            case 'year': sorted.sort((a, b) => (b.year || 0) - (a.year || 0)); break;
            case 'recent': break; // Already sorted by backend
        }
        this.renderAlbums(sorted);
    }

    showAlbumGrid({ updateUrl = true } = {}) {
        if (updateUrl) {
            return this.app.navigateTo('/albums');
        }

        document.getElementById('albums-grid-list').classList.remove('hidden');
        document.getElementById('album-detail-view').classList.add('hidden');
    }

    async openAlbumDetail(albumName, artistName, { updateUrl = true } = {}) {
        if (updateUrl) {
            const params = new URLSearchParams();
            if (artistName) params.set('artist', artistName);
            const suffix = params.toString() ? `?${params.toString()}` : '';
            return this.app.navigateTo(`/albums/${encodeURIComponent(albumName)}${suffix}`);
        }

        try {
            const res = await useAlbumService().getDetail(albumName, artistName);
            if (res.error) {
                Logger.error('Failed to load album detail:', res.error);
                return;
            }
            const { album, songs } = res.value;
            document.getElementById('albums-grid-list').classList.add('hidden');
            document.getElementById('album-detail-view').classList.remove('hidden');

            const hero = document.getElementById('album-detail-hero');
            hero.innerHTML = `
                <div class="album-detail-cover">
                    ${album.cover_path 
                        ? `<img src="/api/music/cover/${encodeURIComponent(album.cover_path)}" alt="${Utils.escapeHtml(album.album)}">`
                        : '<div class="album-no-cover-large">💿</div>'}
                </div>
                <div class="album-detail-info">
                    <div class="album-detail-type">Album</div>
                    <h1 class="album-detail-title">${Utils.escapeHtml(album.album)}</h1>
                    <div class="album-detail-artist">${Utils.escapeHtml(album.artist)}</div>
                    <div class="album-detail-meta">${album.year || 'Unknown year'} • ${album.song_count} songs • ${Utils.formatDuration(album.total_duration)}</div>
                    <button class="album-play-btn" id="album-play-all">▶ Play Album</button>
                </div>
            `;

            const tracks = document.getElementById('album-detail-tracks');
            tracks.innerHTML = songs.map((song, idx) => `
                <div class="album-track-row" data-song-id="${song.id}" data-index="${idx}">
                    <div class="album-track-num">${idx + 1}</div>
                    <div class="album-track-info">
                        <div class="album-track-title">${Utils.escapeHtml(song.title)}</div>
                        <div class="album-track-artist">${Utils.escapeHtml(song.artist)}</div>
                    </div>
                    <div class="album-track-duration">${Utils.formatDuration(song.duration)}</div>
                </div>
            `).join('');

            tracks.querySelectorAll('.album-track-row').forEach(row => {
                row.addEventListener('click', () => {
                    const idx = parseInt(row.dataset.index);
                    this.player.playSong(idx, songs, { type: 'album', id: albumName });
                });
            });

            document.getElementById('album-play-all')?.addEventListener('click', () => {
                if (songs.length) this.player.playSong(0, songs, { type: 'album', id: albumName });
            });
        } catch (e) {
            Logger.error('Album detail error:', e);
        }
    }

    // --- Recently Played View ---

    async switchToRecent({ updateUrl = true } = {}) {
        if (updateUrl) {
            return this.app.navigateTo('/recent');
        }

        this.currentView = 'recent';
        useContext().set('current-view-type', 'recent');
        this.hideAllViews();
        document.getElementById('recent-view').classList.remove('hidden');
        this.updateNav('nav-recent');
        document.querySelector('.section-title').textContent = 'Recently Played';
        document.getElementById('library-subtitle').textContent = 'Your listening history and stats';
        document.querySelector('.view-toggle')?.classList.add('hidden');
        document.getElementById('library-stats')?.classList.add('hidden');
        document.getElementById('playlist-menu-container')?.classList.add('hidden');
        await this.loadRecentTab('recent');
    }

    async loadRecentTab(tab) {
        // Keep the tab pills in sync no matter which entry point
        // (sidebar nav vs. pill click) triggered the load. Without this,
        // opening the view via the sidebar left the previously-selected
        // pill (e.g. "Listening Stats") highlighted over the wrong content.
        document.querySelectorAll('.recent-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.tab === tab);
        });
        const content = document.getElementById('recent-content');
        const stats = document.getElementById('recent-stats');
        content.classList.remove('hidden');
        stats.classList.add('hidden');

        if (tab === 'recent') {
            try {
                const res = await usePlaybackService().getRecentlyPlayed(50);
                if (res.error) return Logger.error('Failed to load recent:', res.error);
                this.recentCache = res.value.songs || [];
                this.renderSongList(content, this.recentCache, 'recent');
            } catch (e) {
                Logger.error('Recent load error:', e);
            }
        } else if (tab === 'top') {
            try {
                const res = await usePlaybackService().getTopSongs(50);
                if (res.error) return Logger.error('Failed to load top:', res.error);
                this.topCache = res.value.songs || [];
                this.renderSongList(content, this.topCache, 'top');
            } catch (e) {
                Logger.error('Top songs load error:', e);
            }
        } else if (tab === 'stats') {
            content.classList.add('hidden');
            stats.classList.remove('hidden');
            await this.loadStats(stats);
        }
    }

    renderSongList(container, songs, mode) {
        if (!songs.length) {
            container.innerHTML = '<div class="empty-state"><h3>No History Yet</h3><p>Play some songs to see them here.</p></div>';
            return;
        }
        container.innerHTML = songs.map((song, idx) => `
            <div class="recent-song-row" data-song-id="${song.id}" data-index="${idx}">
                <div class="recent-song-num">${idx + 1}</div>
                <div class="recent-song-cover">
                    ${song.cover_path 
                        ? `<img src="/api/music/cover/${encodeURIComponent(song.cover_path)}" alt="" loading="lazy">`
                        : '<div class="recent-no-cover">♪</div>'}
                </div>
                <div class="recent-song-info">
                    <div class="recent-song-title">${Utils.escapeHtml(song.title)}</div>
                    <div class="recent-song-artist">${Utils.escapeHtml(song.artist)}</div>
                </div>
                ${mode === 'top' ? `<div class="recent-song-plays">${song.play_count} plays</div>` : ''}
                ${mode === 'recent' && song.played_at ? `<div class="recent-song-time">${this.timeAgo(song.played_at)}</div>` : ''}
                <div class="recent-song-duration">${Utils.formatDuration(song.duration)}</div>
            </div>
        `).join('');

        container.querySelectorAll('.recent-song-row').forEach(row => {
            row.addEventListener('click', () => {
                const idx = parseInt(row.dataset.index);
                const list = mode === 'top' ? this.topCache : this.recentCache;
                this.player.playSong(idx, list, { type: mode, id: null });
            });
        });
    }

    async loadStats(container) {
        try {
            const [statsRes, artistsRes, genresRes] = await Promise.all([
                usePlaybackService().getStats(),
                usePlaybackService().getTopArtists(10),
                usePlaybackService().getTopGenres(10)
            ]);

            if (statsRes.error) return Logger.error('Stats load error:', statsRes.error);

            const stats = statsRes.value.stats || {};
            const artists = artistsRes.value?.artists || [];
            const genres = genresRes.value?.genres || [];

            container.innerHTML = `
                <div class="stats-grid">
                    <div class="stat-card">
                        <div class="stat-value">${stats.total_plays || 0}</div>
                        <div class="stat-label">Total Plays</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">${stats.unique_songs || 0}</div>
                        <div class="stat-label">Unique Songs</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">${stats.active_days || 0}</div>
                        <div class="stat-label">Active Days</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value">${Utils.formatHumanDuration(stats.total_seconds || 0)}</div>
                        <div class="stat-label">Listening Time</div>
                    </div>
                </div>
                <div class="stats-section">
                    <h3>Top Artists</h3>
                    <div class="stats-list">
                        ${artists.map((a, i) => `
                            <div class="stats-list-item">
                                <span class="stats-rank">${i + 1}</span>
                                <span class="stats-name">${Utils.escapeHtml(a.artist)}</span>
                                <span class="stats-count">${a.play_count} plays</span>
                            </div>
                        `).join('')}
                    </div>
                </div>
                <div class="stats-section">
                    <h3>Top Genres</h3>
                    <div class="stats-list">
                        ${genres.map((g, i) => `
                            <div class="stats-list-item">
                                <span class="stats-rank">${i + 1}</span>
                                <span class="stats-name">${Utils.escapeHtml(g.genre)}</span>
                                <span class="stats-count">${g.play_count} plays</span>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
        } catch (e) {
            Logger.error('Stats error:', e);
        }
    }

    async clearHistory() {
        if (!confirm('Clear all play history? This cannot be undone.')) return;
        try {
            const res = await usePlaybackService().clearHistory();
            if (res.error) return Logger.error('Clear history error:', res.error);
            window.showToast?.('History cleared', 'success');
            this.recentCache = [];
            this.topCache = [];
            this.loadRecentTab('recent');
        } catch (e) {
            Logger.error('Clear history error:', e);
        }
    }

    timeAgo(isoString) {
        const date = new Date(isoString);
        const now = new Date();
        const diff = Math.floor((now - date) / 1000);
        if (diff < 60) return 'just now';
        if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
        if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
        if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
        return date.toLocaleDateString();
    }

    // --- Smart Mix View ---

    async switchToSmartMix({ updateUrl = true } = {}) {
        if (updateUrl) {
            return this.app.navigateTo('/smart-mix');
        }

        this.currentView = 'smartmix';
        useContext().set('current-view-type', 'smartmix');
        this.hideAllViews();
        document.getElementById('smartmix-view').classList.remove('hidden');
        this.updateNav('nav-smartmix');
        document.querySelector('.section-title').textContent = 'Smart Mix';
        document.getElementById('library-subtitle').textContent = 'Auto-generated playlists based on your taste';
        document.querySelector('.view-toggle')?.classList.add('hidden');
        document.getElementById('library-stats')?.classList.add('hidden');
        document.getElementById('playlist-menu-container')?.classList.add('hidden');
        document.getElementById('smartmix-result').classList.add('hidden');
    }

    async generateSmartMix(mode) {
        try {
            const seedSongId = this.player.currentSong?.id || null;
            const res = await fetch('/api/smartmix/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode, seed_song_id: seedSongId, limit: 30 })
            });
            const data = await res.json();
            if (data.error) return Logger.error('Smart mix error:', data.error);

            this.smartMixSongs = data.songs || [];
            const titles = { radio: 'Radio Mix', liked: 'Liked Mix', discovery: 'Discovery Mix' };
            document.getElementById('smartmix-result-title').textContent = titles[mode] || 'Your Mix';
            document.getElementById('smartmix-result').classList.remove('hidden');

            const container = document.getElementById('smartmix-songs');
            container.innerHTML = this.smartMixSongs.map((song, idx) => `
                <div class="smartmix-song-row" data-index="${idx}">
                    <div class="smartmix-song-num">${idx + 1}</div>
                    <div class="smartmix-song-cover">
                        ${song.cover_path 
                            ? `<img src="/api/music/cover/${encodeURIComponent(song.cover_path)}" alt="" loading="lazy">`
                            : '<div class="smartmix-no-cover">♪</div>'}
                    </div>
                    <div class="smartmix-song-info">
                        <div class="smartmix-song-title">${Utils.escapeHtml(song.title)}</div>
                        <div class="smartmix-song-artist">${Utils.escapeHtml(song.artist)}</div>
                    </div>
                    <div class="smartmix-song-duration">${Utils.formatDuration(song.duration)}</div>
                </div>
            `).join('');

            container.querySelectorAll('.smartmix-song-row').forEach(row => {
                row.addEventListener('click', () => {
                    const idx = parseInt(row.dataset.index);
                    this.player.playSong(idx, this.smartMixSongs, { type: 'smartmix', id: mode });
                });
            });
        } catch (e) {
            Logger.error('Smart mix generation error:', e);
        }
    }

    playSmartMix() {
        if (this.smartMixSongs.length) {
            this.player.playSong(0, this.smartMixSongs, { type: 'smartmix', id: 'mix' });
        }
    }
}
