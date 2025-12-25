/**
 * Rainy Music Player - Playlists Module
 * Handles playlist operations
 */

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
            console.error('Error loading playlists:', error);
            return [];
        }
    },

    /**
     * Create a new playlist
     * @param {function} api - API function
     * @param {string} name - Playlist name
     * @returns {Promise<object>} - Response
     */
    async create(api, name) {
        return await api('/api/playlists', 'POST', { name });
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

        container.innerHTML = (playlists || []).map(playlist => `
            <div class="nav-item ${currentViewType === 'playlist' && currentPlaylistId === playlist.id ? 'active' : ''}" 
                 data-id="${playlist.id}">
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z"/></svg>
                <span>${escapeHtml(playlist.name)}</span>
            </div>
        `).join('');

        // Add click listeners
        container.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', (e) => {
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

        container.innerHTML = (playlists || []).map(playlist => `
            <div class="context-menu-item" data-id="${playlist.id}">
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/></svg>
                <span>${escapeHtml(playlist.name)}</span>
            </div>
        `).join('');

        // Add click listeners
        container.querySelectorAll('.context-menu-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                onAddToPlaylist(parseInt(item.dataset.id));
            });
        });
    }
};
