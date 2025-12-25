/**
 * Rainy Music Player - UI Module
 * DOM manipulation and UI updates
 */

export const UI = {
    /**
     * Show a specific view (setup, login, app)
     * @param {string} view - View name
     */
    showView(view) {
        document.getElementById('setup-view')?.classList.add('hidden');
        document.getElementById('login-view')?.classList.add('hidden');
        document.getElementById('app-view')?.classList.add('hidden');

        const viewElement = document.getElementById(`${view}-view`);
        if (viewElement) {
            viewElement.classList.remove('hidden');
        }
    },

    /**
     * Update user info in header
     * @param {object} user - User data
     */
    updateUserInfo(user) {
        if (!user) return;

        const userAvatar = document.getElementById('user-avatar');
        const userName = document.getElementById('user-name');
        
        if (userAvatar) userAvatar.textContent = user.username.charAt(0).toUpperCase();
        if (userName) userName.textContent = user.username;

        const serverSettingsItem = document.getElementById('menu-server-settings');
        if (serverSettingsItem) {
            if (user.role === 'sysadmin') {
                serverSettingsItem.classList.remove('hidden');
            } else {
                serverSettingsItem.classList.add('hidden');
            }
        }
    },

    /**
     * Toggle sidebar collapsed state
     */
    toggleSidebar() {
        const sidebar = document.querySelector('.app-sidebar');
        if (sidebar) {
            sidebar.classList.toggle('collapsed');
            const isCollapsed = sidebar.classList.contains('collapsed');
            localStorage.setItem('sidebarCollapsed', isCollapsed);
        }
    },

    /**
     * Restore sidebar state from localStorage
     */
    restoreSidebarState() {
        const isCollapsed = localStorage.getItem('sidebarCollapsed') === 'true';
        if (isCollapsed) {
            document.querySelector('.app-sidebar')?.classList.add('collapsed');
        }
    },

    /**
     * Close user dropdown menu
     */
    closeDropdown() {
        const userMenu = document.getElementById('user-menu');
        const userDropdown = document.getElementById('user-dropdown');
        userMenu?.classList.remove('open');
        userDropdown?.classList.add('hidden');
    },

    /**
     * Update library stats display
     * @param {number} songCount - Total songs
     * @param {number} artistCount - Unique artists
     * @param {number} albumCount - Unique albums
     */
    updateStats(songCount, artistCount = 0, albumCount = 0) {
        const statSongs = document.getElementById('stat-songs');
        const statArtists = document.getElementById('stat-artists');
        const statAlbums = document.getElementById('stat-albums');

        if (statSongs) statSongs.textContent = songCount;
        if (statArtists) statArtists.textContent = artistCount;
        if (statAlbums) statAlbums.textContent = albumCount;
    },

    /**
     * Update song playing state in UI
     * @param {string|number} songId - ID of currently playing song
     */
    updatePlayingState(songId) {
        document.querySelectorAll('.song-card, .song-row').forEach(el => {
            el.classList.remove('playing');
        });

        if (songId) {
            document.querySelectorAll(`[data-id="${songId}"]`).forEach(el => {
                el.classList.add('playing');
            });
        }
    },

    /**
     * Show loading state
     */
    showLoading() {
        document.getElementById('loading-state')?.classList.remove('hidden');
        document.getElementById('empty-state')?.classList.add('hidden');
    },

    /**
     * Hide loading state
     */
    hideLoading() {
        document.getElementById('loading-state')?.classList.add('hidden');
    },

    /**
     * Show empty state
     */
    showEmpty() {
        document.getElementById('empty-state')?.classList.remove('hidden');
    },

    /**
     * Set view mode (grid/list)
     * @param {string} mode - 'grid' or 'list'
     */
    setViewMode(mode) {
        const gridBtn = document.getElementById('grid-view-btn');
        const listBtn = document.getElementById('list-view-btn');
        const songsGrid = document.getElementById('songs-grid');
        const songsList = document.getElementById('songs-list');

        if (mode === 'grid') {
            gridBtn?.classList.add('active');
            listBtn?.classList.remove('active');
            songsGrid?.classList.remove('hidden');
            songsList?.classList.add('hidden');
        } else {
            listBtn?.classList.add('active');
            gridBtn?.classList.remove('active');
            songsList?.classList.remove('hidden');
            songsGrid?.classList.add('hidden');
        }
    }
};
