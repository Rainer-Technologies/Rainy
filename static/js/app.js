/**
 * Rainy Music Player - Main Application
 * Handles views, API communication, and state management
 */

class RainyApp {
    constructor() {
        this.currentView = null;
        this.user = null;
        this.songs = [];
        this.filteredSongs = [];
        this.currentViewMode = 'grid'; // 'grid' or 'list'

        this.init();
    }

    async init() {
        // Bind event listeners
        this.bindEvents();

        // Check app state and show appropriate view
        await this.checkAppState();
    }

    bindEvents() {
        // Search
        const searchInput = document.getElementById('search-input');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => this.handleSearch(e.target.value));
        }

        // View toggle
        const gridViewBtn = document.getElementById('grid-view-btn');
        const listViewBtn = document.getElementById('list-view-btn');

        if (gridViewBtn) {
            gridViewBtn.addEventListener('click', () => this.setViewMode('grid'));
        }
        if (listViewBtn) {
            listViewBtn.addEventListener('click', () => this.setViewMode('list'));
        }

        // User menu dropdown
        const userMenuTrigger = document.getElementById('user-menu-trigger');
        const userMenu = document.getElementById('user-menu');
        const userDropdown = document.getElementById('user-dropdown');

        if (userMenuTrigger) {
            userMenuTrigger.addEventListener('click', (e) => {
                e.stopPropagation();
                userMenu.classList.toggle('open');
                userDropdown.classList.toggle('hidden');
            });
        }

        // Close dropdown when clicking outside
        document.addEventListener('click', () => {
            if (userMenu) {
                userMenu.classList.remove('open');
                userDropdown?.classList.add('hidden');
            }
        });

        // Dropdown menu items
        document.getElementById('menu-user-settings')?.addEventListener('click', () => {
            this.closeDropdown();
            // TODO: Open user settings modal
            console.log('User settings clicked');
        });

        document.getElementById('menu-server-settings')?.addEventListener('click', () => {
            this.closeDropdown();
            this.openServerSettings();
        });

        document.getElementById('menu-logout')?.addEventListener('click', () => {
            this.closeDropdown();
            this.handleLogout();
        });

        // Server Settings Modal
        document.getElementById('close-server-settings')?.addEventListener('click', () => {
            this.closeServerSettings();
        });

        document.getElementById('server-settings-modal')?.addEventListener('click', (e) => {
            if (e.target.id === 'server-settings-modal') {
                this.closeServerSettings();
            }
        });

        // Scan buttons
        document.getElementById('quick-scan-btn')?.addEventListener('click', () => {
            this.runScan(false);
        });

        document.getElementById('full-scan-btn')?.addEventListener('click', () => {
            this.runScan(true);
        });
    }

    closeDropdown() {
        const userMenu = document.getElementById('user-menu');
        const userDropdown = document.getElementById('user-dropdown');
        userMenu?.classList.remove('open');
        userDropdown?.classList.add('hidden');
    }

    async checkAppState() {
        try {
            // First check if setup is needed
            const setupResponse = await this.api('/api/setup/status');

            if (setupResponse.needs_setup) {
                this.showView('setup');
                return;
            }

            // Check if user is authenticated
            const authResponse = await this.api('/api/auth/me');

            if (authResponse.authenticated) {
                this.user = authResponse.user;
                this.showView('app');
                await this.loadLibrary();
            } else {
                this.showView('login');
            }
        } catch (error) {
            console.error('Error checking app state:', error);
            this.showView('setup');
        }
    }

    showView(view) {
        // Hide all views
        document.getElementById('setup-view').classList.add('hidden');
        document.getElementById('login-view').classList.add('hidden');
        document.getElementById('app-view').classList.add('hidden');

        // Show requested view
        const viewElement = document.getElementById(`${view}-view`);
        if (viewElement) {
            viewElement.classList.remove('hidden');
            this.currentView = view;
        }

        // Update user info if showing app
        if (view === 'app' && this.user) {
            document.getElementById('user-avatar').textContent = this.user.username.charAt(0).toUpperCase();
            document.getElementById('user-name').textContent = this.user.username;

            // Show server settings for sysadmin users
            const serverSettingsItem = document.getElementById('menu-server-settings');
            if (serverSettingsItem) {
                if (this.user.role === 'sysadmin') {
                    serverSettingsItem.classList.remove('hidden');
                } else {
                    serverSettingsItem.classList.add('hidden');
                }
            }
        }
    }

    async openServerSettings() {
        const modal = document.getElementById('server-settings-modal');
        modal?.classList.remove('hidden');

        // Reset scan result display
        document.getElementById('scan-progress')?.classList.add('hidden');
        document.getElementById('scan-result')?.classList.add('hidden');

        // Load current scan status
        await this.loadScanStatus();
    }

    closeServerSettings() {
        const modal = document.getElementById('server-settings-modal');
        modal?.classList.add('hidden');
    }

    async loadScanStatus() {
        try {
            const response = await this.api('/api/music/scan/status');

            // Update library count
            const libraryCount = document.getElementById('library-count');
            if (libraryCount) {
                libraryCount.textContent = `${response.library_total || 0} songs`;
            }

            // Update last scan time
            const lastScanTime = document.getElementById('last-scan-time');
            if (lastScanTime && response.has_scan && response.scan) {
                if (response.scan.completed_at) {
                    const date = new Date(response.scan.completed_at);
                    lastScanTime.textContent = date.toLocaleString();
                } else if (response.scan.status === 'running') {
                    lastScanTime.textContent = 'In progress...';
                }
            }
        } catch (error) {
            console.error('Error loading scan status:', error);
        }
    }

    async runScan(fullScan = false) {
        const quickScanBtn = document.getElementById('quick-scan-btn');
        const fullScanBtn = document.getElementById('full-scan-btn');
        const scanProgress = document.getElementById('scan-progress');
        const scanProgressText = document.getElementById('scan-progress-text');
        const scanResult = document.getElementById('scan-result');

        // Disable buttons and show progress
        quickScanBtn.disabled = true;
        fullScanBtn.disabled = true;
        scanProgress?.classList.remove('hidden');
        scanResult?.classList.add('hidden');
        scanProgressText.textContent = fullScan ? 'Running full scan...' : 'Scanning for new files...';

        try {
            const endpoint = fullScan ? '/api/music/scan/full' : '/api/music/scan';
            const response = await this.api(endpoint, 'POST');

            // Hide progress, show result
            scanProgress?.classList.add('hidden');
            scanResult?.classList.remove('hidden');

            // Update result stats
            if (response.stats) {
                document.getElementById('scan-files-found').textContent = response.stats.files_found || 0;
                document.getElementById('scan-files-added').textContent = response.stats.files_added || 0;
                document.getElementById('scan-files-updated').textContent = response.stats.files_updated || 0;
                document.getElementById('scan-files-removed').textContent = response.stats.files_removed || 0;
            }

            // Refresh library count
            await this.loadScanStatus();

            // Reload library in the background
            this.loadLibrary();

        } catch (error) {
            console.error('Scan error:', error);
            scanProgress?.classList.add('hidden');
            alert('Scan failed: ' + (error.message || 'Unknown error'));
        } finally {
            quickScanBtn.disabled = false;
            fullScanBtn.disabled = false;
        }
    }

    async loadLibrary() {
        const loadingState = document.getElementById('loading-state');
        const emptyState = document.getElementById('empty-state');
        const songsGrid = document.getElementById('songs-grid');
        const songsList = document.getElementById('songs-list');

        // Show loading
        loadingState.classList.remove('hidden');
        emptyState.classList.add('hidden');
        songsGrid.innerHTML = '';
        document.getElementById('songs-list-content').innerHTML = '';

        try {
            const response = await this.api('/api/music/library');

            loadingState.classList.add('hidden');

            if (response.songs && response.songs.length > 0) {
                this.songs = response.songs;
                this.filteredSongs = [...this.songs];
                this.renderSongs();
                this.updateStats();
            } else {
                emptyState.classList.remove('hidden');
            }
        } catch (error) {
            console.error('Error loading library:', error);
            loadingState.classList.add('hidden');
            emptyState.classList.remove('hidden');
        }
    }

    renderSongs() {
        if (this.currentViewMode === 'grid') {
            this.renderGridView();
        } else {
            this.renderListView();
        }
    }

    renderGridView() {
        const songsGrid = document.getElementById('songs-grid');
        const songsList = document.getElementById('songs-list');

        songsGrid.classList.remove('hidden');
        songsList.classList.add('hidden');

        songsGrid.innerHTML = this.filteredSongs.map((song, index) => `
            <div class="song-card fade-in" data-index="${index}" data-id="${song.id}">
                <div class="song-artwork">
                    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                        <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
                    </svg>
                    <div class="song-artwork-overlay">
                        <div class="play-btn-overlay">
                            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                                <path d="M8 5v14l11-7z"/>
                            </svg>
                        </div>
                    </div>
                </div>
                <div class="song-info">
                    <div class="song-title">${this.escapeHtml(song.title)}</div>
                    <div class="song-artist">${this.escapeHtml(song.artist)}</div>
                    <div class="song-duration">${this.formatDuration(song.duration)}</div>
                </div>
            </div>
        `).join('');

        // Add click listeners
        songsGrid.querySelectorAll('.song-card').forEach(card => {
            card.addEventListener('click', () => {
                const index = parseInt(card.dataset.index);
                window.player.playSong(index, this.filteredSongs);
            });
        });
    }

    renderListView() {
        const songsGrid = document.getElementById('songs-grid');
        const songsList = document.getElementById('songs-list');
        const listContent = document.getElementById('songs-list-content');

        songsGrid.classList.add('hidden');
        songsList.classList.remove('hidden');

        listContent.innerHTML = this.filteredSongs.map((song, index) => `
            <div class="song-row fade-in" data-index="${index}" data-id="${song.id}">
                <div class="song-row-number">${index + 1}</div>
                <div class="song-row-main">
                    <div class="song-row-artwork">
                        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                            <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
                        </svg>
                    </div>
                    <div class="song-row-info">
                        <div class="song-row-title">${this.escapeHtml(song.title)}</div>
                        <div class="song-row-artist">${this.escapeHtml(song.artist)}</div>
                    </div>
                </div>
                <div class="song-row-album">${this.escapeHtml(song.album)}</div>
                <div class="song-row-duration">${this.formatDuration(song.duration)}</div>
            </div>
        `).join('');

        // Add click listeners
        listContent.querySelectorAll('.song-row').forEach(row => {
            row.addEventListener('click', () => {
                const index = parseInt(row.dataset.index);
                window.player.playSong(index, this.filteredSongs);
            });
        });
    }

    setViewMode(mode) {
        this.currentViewMode = mode;

        // Update toggle buttons
        document.getElementById('grid-view-btn').classList.toggle('active', mode === 'grid');
        document.getElementById('list-view-btn').classList.toggle('active', mode === 'list');

        // Re-render songs
        this.renderSongs();
    }

    handleSearch(query) {
        const searchTerm = query.toLowerCase().trim();

        if (!searchTerm) {
            this.filteredSongs = [...this.songs];
        } else {
            this.filteredSongs = this.songs.filter(song =>
                song.title.toLowerCase().includes(searchTerm) ||
                song.artist.toLowerCase().includes(searchTerm) ||
                song.album.toLowerCase().includes(searchTerm)
            );
        }

        this.renderSongs();
        this.updateStats();
    }

    updateStats() {
        const songs = this.filteredSongs;
        const artists = new Set(songs.map(s => s.artist)).size;
        const albums = new Set(songs.map(s => s.album)).size;

        document.getElementById('stat-songs').textContent = songs.length;
        document.getElementById('stat-artists').textContent = artists;
        document.getElementById('stat-albums').textContent = albums;

        document.getElementById('library-subtitle').textContent =
            this.filteredSongs.length === this.songs.length
                ? 'All your music in one place'
                : `Showing ${this.filteredSongs.length} of ${this.songs.length} songs`;
    }

    async handleLogout() {
        try {
            await this.api('/api/auth/logout', 'POST');
            this.user = null;
            this.songs = [];
            this.filteredSongs = [];
            this.showView('login');
        } catch (error) {
            console.error('Error logging out:', error);
        }
    }

    // API helper
    async api(url, method = 'GET', data = null) {
        const options = {
            method,
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include'
        };

        if (data) {
            options.body = JSON.stringify(data);
        }

        const response = await fetch(url, options);
        return response.json();
    }

    // Utility functions
    formatDuration(seconds) {
        if (!seconds) return '0:00';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // Method to update song playing state
    updatePlayingState(songId) {
        // Remove playing class from all cards/rows
        document.querySelectorAll('.song-card, .song-row').forEach(el => {
            el.classList.remove('playing');
        });

        // Add playing class to current song
        if (songId) {
            document.querySelectorAll(`[data-id="${songId}"]`).forEach(el => {
                el.classList.add('playing');
            });
        }
    }
}

// Initialize app
const app = new RainyApp();
window.app = app;
