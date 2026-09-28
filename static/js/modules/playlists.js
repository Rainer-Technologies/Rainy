/**
 * Rainy Music Player - Playlists Module
 * Handles playlist operations
 */

import { PLAYLIST_ICONS } from '../data/playlist-icons.js';
import { Logger } from '../helper/logger.js';

export const Playlists = {
    /**
     * Load all playlists from API
     * @param {function} api - API function
     * @returns {Promise<array>} - Array of playlists
     */
    async loadAll(api) {
        try {
            return await api('/api/playlists');
        } catch (error) {
            Logger.error('Error loading playlists:', error);
            return [];
        }
    },

    /**
     * Create a new playlist
     * @param {function} api - API function
     * @param {string} name - Playlist name
     * @param {string} icon - Icon identifier (optional)
     * @param {string} iconColor - Icon color hex (optional)
     * @returns {Promise<object>} - Response
     */
    async create(api, name, icon = 'music-note', iconColor = '#fa586a') {
        return await api('/api/playlists', 'POST', { name, icon, icon_color: iconColor });
    },

    /**
     * Update a playlist (name, icon, color)
     * @param {function} api - API function
     * @param {number} playlistId - Playlist ID
     * @param {object} updates - { name, icon, icon_color }
     * @returns {Promise<object>} - Response
     */
    async update(api, playlistId, updates) {
        return await api(`/api/playlists/${playlistId}`, 'PUT', updates);
    },

    /**
     * Rename a playlist
     * @param {function} api - API function
     * @param {number} playlistId - Playlist ID
     * @param {string} newName - New name
     * @returns {Promise<object>} - Response
     */
    async rename(api, playlistId, newName) {
        return await api(`/api/playlists/${playlistId}`, 'PUT', { name: newName });
    },

    /**
     * Delete a playlist
     * @param {function} api - API function
     * @param {number} playlistId - Playlist ID
     * @returns {Promise<object>} - Response
     */
    async delete(api, playlistId) {
        return await api(`/api/playlists/${playlistId}`, 'DELETE');
    },

    /**
     * Get playlist with songs
     * @param {function} api - API function
     * @param {number} playlistId - Playlist ID
     * @returns {Promise<object>} - Playlist with songs
     */
    async get(api, playlistId) {
        return await api(`/api/playlists/${playlistId}`);
    },

    /**
     * Add song to playlist
     * @param {function} api - API function
     * @param {number} playlistId - Playlist ID
     * @param {number} songId - Song ID
     * @returns {Promise<object>} - Response
     */
    async addSong(api, playlistId, songId) {
        return await api(`/api/playlists/${playlistId}/songs`, 'POST', { song_id: songId });
    },

    /**
     * Render playlists in sidebar
     * @param {HTMLElement} container - Sidebar playlists container
     * @param {array} playlists - Array of playlists
     * @param {number} currentPlaylistId - Currently open playlist ID
     * @param {string} currentViewType - Current view type ('library' or 'playlist')
     * @param {function} escapeHtml - HTML escape function
     * @param {function} onOpenPlaylist - Callback when playlist is clicked
     */
    renderSidebar(container, playlists, currentPlaylistId, currentViewType, escapeHtml, onOpenPlaylist) {
        if (!container) return;

        const likedPlaylist = (playlists || []).find(p => (p.name || '').toLowerCase() === 'liked music');
        // Shared playlists live in the normal list, marked by the shared badge.
        const visiblePlaylists = [
            ...(likedPlaylist ? [likedPlaylist] : []),
            ...(playlists || []).filter(p => (p.name || '').toLowerCase() !== 'liked music'),
        ];

        container.innerHTML = visiblePlaylists.map(playlist => {
            const isLiked = (playlist.name || '').toLowerCase() === 'liked music';
            const isShared = !!playlist.shared;
            const iconId = playlist.icon || (isLiked ? 'like' : 'music-note');
            const iconColor = playlist.icon_color || (isLiked ? '#fa586a' : '#888888');
            const icon = PLAYLIST_ICONS[iconId] || PLAYLIST_ICONS['music-note'];
            const classes = [
                'nav-item',
                isShared ? 'nav-shared-item' : '',
                isLiked ? 'nav-liked-item' : '',
                currentViewType === 'playlist' && currentPlaylistId === playlist.id ? 'active' : ''
            ].filter(Boolean).join(' ');

            // Prefer the auto-generated cover image; fall back to the icon.
            const media = playlist.cover_path
                ? `<img src="/api/music/cover/${encodeURIComponent(playlist.cover_path)}"
                        class="playlist-icon playlist-cover" alt="" loading="lazy"
                        onerror="this.style.display='none'" />`
                : `<svg viewBox="0 0 24 24" fill="${iconColor}" class="playlist-icon"><path d="${icon.path}"/></svg>`;

            const badge = isShared
                ? `<svg viewBox="0 0 24 24" class="nav-shared-badge" fill="currentColor"
                       title="Shared playlist">
                       <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
                   </svg>`
                : '';
            const titleAttr = isShared
                ? ` title="Shared with you by ${escapeHtml(playlist.owner_username || 'a friend')}"`
                : '';

            return `
            <a href="/playlists/${encodeURIComponent(playlist.id)}" class="${classes}"
                 data-id="${playlist.id}"${titleAttr}>
                 ${media}
                 <span>${escapeHtml(playlist.name)}</span>
                 ${badge}
            </a>
        `}).join('');

        // Add click listeners
        container.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                onOpenPlaylist(parseInt(item.dataset.id));
            });
        });
    },

    /**
     * Render playlists in context menu submenu
     * @param {HTMLElement} container - Submenu container
     * @param {array} playlists - Array of playlists
     * @param {function} escapeHtml - HTML escape function
     * @param {function} onAddToPlaylist - Callback when playlist is clicked
     */
    renderSubmenu(container, playlists, escapeHtml, onAddToPlaylist) {
        if (!container) return;

        const visiblePlaylists = (playlists || []).filter(p => (p.name || '').toLowerCase() !== 'liked music');
        container.innerHTML = visiblePlaylists.map(playlist => {
            const iconId = playlist.icon || 'music-note';
            const iconColor = playlist.icon_color || '#888888';
            const icon = PLAYLIST_ICONS[iconId] || PLAYLIST_ICONS['music-note'];

            return `
            <div class="context-menu-item" data-id="${playlist.id}">
                <svg viewBox="0 0 24 24" fill="${iconColor}"><path d="${icon.path}"/></svg>
                <span>${escapeHtml(playlist.name)}</span>
            </div>
        `}).join('');

        // Add click listeners
        container.querySelectorAll('.context-menu-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                onAddToPlaylist(parseInt(item.dataset.id));
            });
        });
    }
};
