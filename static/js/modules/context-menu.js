/**
 * Rainy Music Player - Context Menu Module
 * Handles song context menu (right-click/three-dot menu)
 */

export const ContextMenu = {
    selectedSong: null,

    /**
     * Show context menu at event position
     * @param {Event} event - Click event
     * @param {object} songData - Song data from element dataset
     * @param {array} songs - Full songs array to find complete song data
     */
    show(event, songData, songs) {
        const contextMenu = document.getElementById('song-context-menu');
        if (!contextMenu) return;

        // Find the full song object to get the path
        const fullSong = songs.find(s => s.id == songData.songId);

        this.selectedSong = {
            id: songData.songId,
            title: songData.songTitle,
            artist: songData.songArtist,
            path: fullSong?.path || songData.songId
        };

        // Position the menu
        const x = event.clientX;
        const y = event.clientY;

        contextMenu.style.left = `${x}px`;
        contextMenu.style.top = `${y}px`;
        contextMenu.classList.remove('hidden');

        // Adjust if menu goes off screen
        const rect = contextMenu.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            contextMenu.style.left = `${window.innerWidth - rect.width - 10}px`;
        }
        if (rect.bottom > window.innerHeight) {
            contextMenu.style.top = `${window.innerHeight - rect.height - 10}px`;
        }
    },

    /**
     * Hide context menu
     */
    hide() {
        const contextMenu = document.getElementById('song-context-menu');
        contextMenu?.classList.add('hidden');
    },

    /**
     * Get currently selected song
     * @returns {object|null} - Selected song data
     */
    getSelectedSong() {
        return this.selectedSong;
    },

    /**
     * Clear selected song
     */
    clearSelection() {
        this.selectedSong = null;
    },

    /**
     * Setup context menu event listeners
     * @param {object} callbacks - Callback functions for menu actions
     */
    setupEvents(callbacks) {
        // Close context menu when clicking outside
        document.addEventListener('click', (e) => {
            const contextMenu = document.getElementById('song-context-menu');
            if (contextMenu && !contextMenu.contains(e.target) && !e.target.closest('.song-menu-btn')) {
                this.hide();
            }
        });

        // Find metadata action
        document.getElementById('context-find-metadata')?.addEventListener('click', () => {
            this.hide();
            if (callbacks.onFindMetadata) callbacks.onFindMetadata();
        });

        // Remove song action
        document.getElementById('context-remove-song')?.addEventListener('click', () => {
            this.hide();
            if (callbacks.onRemoveSong) callbacks.onRemoveSong();
        });
    }
};
