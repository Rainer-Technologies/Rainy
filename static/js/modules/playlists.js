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

        const visiblePlaylists = (playlists || []).filter(p => (p.name || '').toLowerCase() !== 'liked music');
        container.innerHTML = visiblePlaylists.map(playlist => {
            const iconId = playlist.icon || 'music-note';
            const iconColor = playlist.icon_color || '#888888';
            const icon = PLAYLIST_ICONS[iconId] || PLAYLIST_ICONS['music-note'];

            // Prefer the auto-generated cover image; fall back to the icon.
            const media = playlist.cover_path
                ? `<img src="/api/music/cover/${encodeURIComponent(playlist.cover_path)}"
                        class="playlist-icon playlist-cover" alt="" loading="lazy"
                        onerror="this.style.display='none'" />`
                : `<svg viewBox="0 0 24 24" fill="${iconColor}" class="playlist-icon"><path d="${icon.path}"/></svg>`;

            return `
            <a href="/playlists/${encodeURIComponent(playlist.id)}" class="nav-item ${currentViewType === 'playlist' && currentPlaylistId === playlist.id ? 'active' : ''}"
                 data-id="${playlist.id}">
                ${media}
                <span>${escapeHtml(playlist.name)}</span>
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
