/**
 * Rainy Music Player - State Module
 * Application state management
 */

export const State = {
    // User state
    user: null,

    // View state
    currentView: null,
    currentViewMode: 'grid', // 'grid' or 'list'
    currentViewType: 'library', // 'library' or 'playlist'

    // Library state
    songs: [],
    filteredSongs: [],
    sections: [],
    librarySongs: [], // Cache for switching back from playlist
    librarySections: [], // Cache for switching back

    // Playlist state
    playlists: [],
    currentPlaylistId: null,

    // Context menu state
    selectedSong: null,

    // Sort state
    listSortOrder: 'none', // 'none', 'asc', 'desc'
    currentSort: 'default',

    /**
     * Reset to initial state
     */
    reset() {
        this.user = null;
        this.currentView = null;
        this.songs = [];
        this.filteredSongs = [];
        this.sections = [];
        this.playlists = [];
        this.currentPlaylistId = null;
        this.selectedSong = null;
    },

    /**
     * Set user data
     * @param {object} user - User data
     */
    setUser(user) {
        this.user = user;
    },

    /**
     * Set library songs
     * @param {array} songs - Array of song objects
     */
    setSongs(songs) {
        this.songs = songs;
        this.librarySongs = [...songs];
        this.filteredSongs = [...songs];
    },

    /**
     * Set library sections
     * @param {array} sections - Array of section objects
     */
    setSections(sections) {
        this.sections = sections;
        this.librarySections = JSON.parse(JSON.stringify(sections));
    },

    /**
     * Set playlists
     * @param {array} playlists - Array of playlist objects
     */
    setPlaylists(playlists) {
        this.playlists = playlists;
    },

    /**
     * Get current songs based on view
     * @returns {array} - Current song list
     */
    getCurrentSongs() {
        return this.filteredSongs;
    }
};
