import { API } from './modules/api.js';
import { Auth } from './modules/auth.js';
import { State } from './modules/state.js';
import { UI } from './modules/ui.js';
import { Library } from './modules/library.js';
import { Playlists } from './modules/playlists.js';
import { Scan } from './modules/scan.js';
import { Metadata } from './modules/metadata.js';
import { Importer } from './modules/importer.js';
import { ContextMenu } from './modules/context-menu.js';
import { Utils } from './modules/utils.js';

export class RainyApp {
    constructor() {
        this.currentView = null;
        this.user = null;
        this.songs = [];
        this.filteredSongs = [];
        this.currentViewMode = 'grid'; // 'grid' or 'list'
        this.selectedSong = null; // For context menu
        this.listSortOrder = 'none'; // 'none', 'asc', 'desc'
        this.currentSort = 'default';
        this.coverVersion = {};
        this.coverOverride = {};

        this.init();
    }

    async init() {
        // Restore sidebar state
        const isCollapsed = localStorage.getItem('sidebarCollapsed') === 'true';
        if (isCollapsed) {
            document.querySelector('.app-sidebar')?.classList.add('collapsed');
        }

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

        // View toggle
        document.getElementById('grid-view-btn')?.addEventListener('click', () => {
            this.setViewMode('grid');
        });

        document.getElementById('list-view-btn')?.addEventListener('click', () => {
            this.setViewMode('list');
        });

        // List view sort by title
        document.getElementById('list-sort-title')?.addEventListener('click', () => {
            this.toggleListSort();
        });

        // Scan buttons
        document.getElementById('quick-scan-btn')?.addEventListener('click', () => {
            this.runScan(false);
        });

        document.getElementById('full-scan-btn')?.addEventListener('click', () => {
            this.runScan(true);
        });

        // Context menu


        // Playlist Settings Menu
        document.getElementById('playlist-settings-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const dropdown = document.getElementById('playlist-settings-dropdown');
            dropdown.classList.toggle('hidden');
        });

        document.getElementById('action-rename-playlist')?.addEventListener('click', () => {
            document.getElementById('playlist-settings-dropdown').classList.add('hidden');
            this.renameCurrentPlaylist();
        });

        document.getElementById('action-delete-playlist')?.addEventListener('click', () => {
            document.getElementById('playlist-settings-dropdown').classList.add('hidden');
            this.deleteCurrentPlaylist();
        });

        // Rename Playlist Modal
        document.getElementById('close-rename-playlist-modal')?.addEventListener('click', () => {
            document.getElementById('rename-playlist-modal').classList.add('hidden');
        });
        document.getElementById('cancel-rename-playlist')?.addEventListener('click', () => {
            document.getElementById('rename-playlist-modal').classList.add('hidden');
        });
        document.getElementById('save-rename-playlist')?.addEventListener('click', () => {
            this.performRenamePlaylist();
        });
        document.getElementById('rename-playlist-input')?.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.performRenamePlaylist();
            }
        });

        // Delete Playlist Modal
        document.getElementById('close-delete-playlist-modal')?.addEventListener('click', () => {
            document.getElementById('delete-playlist-modal').classList.add('hidden');
        });
        document.getElementById('cancel-delete-playlist')?.addEventListener('click', () => {
            document.getElementById('delete-playlist-modal').classList.add('hidden');
        });
        document.getElementById('confirm-delete-playlist')?.addEventListener('click', () => {
            this.performDeletePlaylist();
        });

        document.addEventListener('click', (e) => {
            // Close context menu when clicking outside
            const contextMenu = document.getElementById('song-context-menu');
            if (contextMenu && !contextMenu.contains(e.target) && !e.target.closest('.song-menu-btn')) {
                contextMenu.classList.add('hidden');
            }

            // Close playlist settings menu when clicking outside
            const playlistDropdown = document.getElementById('playlist-settings-dropdown');
            const playlistBtn = document.getElementById('playlist-settings-btn');
            if (playlistDropdown && !playlistDropdown.contains(e.target) && !playlistBtn?.contains(e.target)) {
                playlistDropdown.classList.add('hidden');
            }
        });


        document.getElementById('context-find-metadata')?.addEventListener('click', () => {
            this.hideContextMenu();
            this.openMetadataModal();
        });

        document.getElementById('context-remove-song')?.addEventListener('click', () => {
            this.hideContextMenu();
            this.removeSong();
        });

        // Metadata modal
        document.getElementById('close-metadata-modal')?.addEventListener('click', () => {
            this.closeMetadataModal();
        });

        document.getElementById('metadata-modal')?.addEventListener('click', (e) => {
            if (e.target.id === 'metadata-modal') {
                this.closeMetadataModal();
            }
        });

        document.getElementById('metadata-search-btn')?.addEventListener('click', () => {
            this.searchMetadata();
        });

        document.getElementById('metadata-search-input')?.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.searchMetadata();
            }
        });

        // Add Music modal
        document.getElementById('menu-add-music')?.addEventListener('click', () => {
            this.closeDropdown();
            this.openAddMusicModal();
        });

        document.getElementById('close-add-music-modal')?.addEventListener('click', () => {
            this.closeAddMusicModal();
        });

        document.getElementById('add-music-modal')?.addEventListener('click', (e) => {
            if (e.target.id === 'add-music-modal') {
                this.closeAddMusicModal();
            }
        });

        // Add Music tabs
        document.querySelectorAll('.add-music-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                this.switchAddMusicTab(tab.dataset.tab);
            });
        });

        // Upload dropzone
        const dropzone = document.getElementById('upload-dropzone');
        const fileInput = document.getElementById('file-upload-input');

        dropzone?.addEventListener('click', () => fileInput?.click());
        dropzone?.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropzone.classList.add('dragover');
        });
        dropzone?.addEventListener('dragleave', () => {
            dropzone.classList.remove('dragover');
        });
        dropzone?.addEventListener('drop', (e) => {
            e.preventDefault();
            dropzone.classList.remove('dragover');
            if (e.dataTransfer.files.length > 0) {
                this.uploadFiles(e.dataTransfer.files);
            }
        });
        fileInput?.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                this.uploadFiles(e.target.files);
            }
        });

        // YouTube import
        document.getElementById('youtube-import-btn')?.addEventListener('click', () => {
            this.importFromYouTube();
        });

        document.getElementById('youtube-url-input')?.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.importFromYouTube();
            }
        });

        // Playlist events
        document.getElementById('sidebar-new-playlist')?.addEventListener('click', (e) => {
            e.stopPropagation(); // prevent triggering nav section collapse if we had that
            this.openCreatePlaylistModal();
        });

        document.getElementById('close-playlist-modal')?.addEventListener('click', () => {
            document.getElementById('create-playlist-modal').classList.add('hidden');
        });

        document.getElementById('cancel-playlist-btn')?.addEventListener('click', () => {
            document.getElementById('create-playlist-modal').classList.add('hidden');
        });

        document.getElementById('save-playlist-btn')?.addEventListener('click', () => {
            this.createPlaylist();
        });

        document.getElementById('nav-library')?.addEventListener('click', (e) => {
            e.preventDefault();
            this.switchToLibraryView();
        });

        // Sidebar Toggle
        document.getElementById('sidebar-toggle')?.addEventListener('click', () => {
            this.toggleSidebar();
        });

        // Context menu submenu hover
        const playlistItem = document.getElementById('context-add-playlist');
        const playlistSubmenu = document.getElementById('context-playlist-submenu');

        if (playlistItem && playlistSubmenu) {
            playlistItem.addEventListener('mouseenter', () => {
                // Populate/Refresh playlists in submenu
                this.renderPlaylistSubmenu();
                playlistSubmenu.classList.remove('hidden');

                // Smart positioning: check if submenu fits on the right
                const contextMenu = document.getElementById('song-context-menu');
                const contextRect = contextMenu.getBoundingClientRect();
                const submenuWidth = 180; // min-width from CSS
                const gap = 5; // gap between menus

                // Calculate available space on right
                const spaceOnRight = window.innerWidth - contextRect.right - gap;

                if (spaceOnRight < submenuWidth) {
                    // Not enough space on right, show on left
                    playlistSubmenu.classList.add('show-left');
                } else {
                    playlistSubmenu.classList.remove('show-left');
                }
            });

            // Use a timeout for more forgiving submenu interaction
            let submenuTimeout = null;

            playlistItem.addEventListener('mouseleave', () => {
                // Delay hiding to allow cursor to reach submenu
                submenuTimeout = setTimeout(() => {
                    playlistSubmenu.classList.add('hidden');
                }, 150);
            });

            // Keep submenu open when hovering over it
            playlistSubmenu.addEventListener('mouseenter', () => {
                if (submenuTimeout) {
                    clearTimeout(submenuTimeout);
                    submenuTimeout = null;
                }
            });

            playlistSubmenu.addEventListener('mouseleave', () => {
                playlistSubmenu.classList.add('hidden');
            });

            document.getElementById('context-new-playlist')?.addEventListener('click', (e) => {
                e.stopPropagation();
                // Close context menu
                document.getElementById('song-context-menu').classList.add('hidden');
                this.openCreatePlaylistModal();
            });
        }

    }

    closeDropdown() {
        const userMenu = document.getElementById('user-menu');
        const userDropdown = document.getElementById('user-dropdown');
        userMenu?.classList.remove('open');
        userDropdown?.classList.add('hidden');
    }

    toggleSidebar() {
        const sidebar = document.querySelector('.app-sidebar');
        if (sidebar) {
            sidebar.classList.toggle('collapsed');
            const isCollapsed = sidebar.classList.contains('collapsed');
            localStorage.setItem('sidebarCollapsed', isCollapsed);
        }
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
                await this.loadPlaylists();
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

            if (response.all_songs && response.all_songs.length > 0) {
                this.songs = response.all_songs;
                this.librarySongs = [...this.songs]; // Cache for switching back
                this.currentViewType = 'library'; // Track view type
                this.sections = response.sections || [];
                this.librarySections = JSON.parse(JSON.stringify(this.sections)); // Deep copy cache
                this.filteredSongs = [...this.songs];
                this.renderSections();
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

    renderSections() {
        const songsGrid = document.getElementById('songs-grid');
        const songsList = document.getElementById('songs-list');

        // Clear existing content
        songsGrid.innerHTML = '';

        if (this.currentViewMode === 'list') {
            // In list view, just show all songs
            this.renderListView();
            return;
        }

        // Grid view with sections
        songsGrid.classList.remove('hidden');
        songsList.classList.add('hidden');

        Library.renderSections(
            songsGrid,
            this.sections,
            this.songs,
            this.escapeHtml.bind(this),
            this.formatDuration.bind(this),
            this.currentSort,
            this.coverOverride,
            this.coverVersion
        );

        // Bind click events
        this.bindSongEvents();
    }

    bindSongEvents() {
        const songsGrid = document.getElementById('songs-grid');

        // Add click listeners for play
        songsGrid.querySelectorAll('.song-card, .song-card-horizontal').forEach(card => {
            card.addEventListener('click', (e) => {
                if (e.target.closest('.song-menu-btn')) return;
                const index = parseInt(card.dataset.index);
                if (index >= 0) {
                    window.player.playSong(index, this.songs);
                }
            });
        });

        // Add menu button listeners
        songsGrid.querySelectorAll('.song-menu-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.showContextMenu(e, btn.dataset);
            });
        });

        // Bind sort dropdown
        const sortSelect = document.getElementById('sort-select');
        if (sortSelect) {
            sortSelect.addEventListener('change', (e) => {
                this.applySortFilter(e.target.value);
            });
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

        // We wrap filtered songs in a section to use Library.renderGridSection
        const section = {
            id: 'filtered-songs',
            title: 'Search Results',
            songs: this.filteredSongs
        };

        songsGrid.innerHTML = Library.renderGridSection(
            section,
            this.escapeHtml.bind(this),
            this.formatDuration.bind(this),
            this.currentSort,
            this.coverOverride,
            this.coverVersion
        );

        // Add click listeners for play
        songsGrid.querySelectorAll('.song-card').forEach(card => {
            card.addEventListener('click', (e) => {
                // Don't play if clicking menu button
                if (e.target.closest('.song-menu-btn')) return;
                const index = parseInt(card.dataset.index);
                window.player.playSong(index, this.filteredSongs);
            });
        });

        // Add menu button listeners
        songsGrid.querySelectorAll('.song-menu-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.showContextMenu(e, btn.dataset);
            });
        });
    }

    renderListView() {
        const songsGrid = document.getElementById('songs-grid');
        const songsList = document.getElementById('songs-list');
        const listContent = document.getElementById('songs-list-content');

        songsGrid.classList.add('hidden');
        songsList.classList.remove('hidden');

        Library.renderListView(
            listContent,
            this.filteredSongs,
            this.escapeHtml.bind(this),
            this.formatDuration.bind(this),
            this.coverOverride,
            this.coverVersion
        );

        // Add click listeners for play
        listContent.querySelectorAll('.song-row').forEach(row => {
            row.addEventListener('click', (e) => {
                // Don't play if clicking menu button
                if (e.target.closest('.song-menu-btn')) return;
                const index = parseInt(row.dataset.index);
                window.player.playSong(index, this.filteredSongs);
            });
        });

        // Add menu button listeners
        listContent.querySelectorAll('.song-menu-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.showContextMenu(e, btn.dataset);
            });
        });
    }

    setViewMode(mode) {
        this.currentViewMode = mode;

        // Update toggle buttons
        document.getElementById('grid-view-btn').classList.toggle('active', mode === 'grid');
        document.getElementById('list-view-btn').classList.toggle('active', mode === 'list');

        // Re-render with sections
        if (this.sections && this.sections.length > 0) {
            this.renderSections();
        } else {
            this.renderSongs();
        }
    }

    handleSearch(query) {
        const searchTerm = query.toLowerCase().trim();

        if (!searchTerm) {
            this.filteredSongs = [...this.songs];
            this.renderSections();
        } else {
            this.filteredSongs = this.songs.filter(song =>
                song.title.toLowerCase().includes(searchTerm) ||
                song.artist.toLowerCase().includes(searchTerm) ||
                song.album.toLowerCase().includes(searchTerm)
            );
            this.renderSongs();
        }

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

    applySortFilter(sortValue) {
        if (!this.sections || this.sections.length === 0) return;
        this.currentSort = sortValue;

        // Find the "All Songs" section
        const allSongsSection = this.sections.find(s => s.id === 'all-songs');
        if (!allSongsSection) return;

        // Sort the songs based on the selected option
        switch (sortValue) {
            case 'title-asc':
                allSongsSection.songs.sort((a, b) =>
                    a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
                );
                break;
            case 'title-desc':
                allSongsSection.songs.sort((a, b) =>
                    b.title.localeCompare(a.title, undefined, { sensitivity: 'base' })
                );
                break;
            case 'default':
            default:
                // Reset to original order (by artist, album, track)
                allSongsSection.songs.sort((a, b) => {
                    if (a.artist !== b.artist) {
                        return a.artist.localeCompare(b.artist, undefined, { sensitivity: 'base' });
                    }
                    if (a.album !== b.album) {
                        return a.album.localeCompare(b.album, undefined, { sensitivity: 'base' });
                    }
                    return (a.track || 0) - (b.track || 0);
                });
                break;
        }

        // Re-render sections
        this.renderSections();
    }

    toggleListSort() {
        const titleHeader = document.getElementById('list-sort-title');
        if (!titleHeader) return;

        // Cycle through: none -> asc -> desc -> none
        if (this.listSortOrder === 'none' || this.listSortOrder === 'desc') {
            this.listSortOrder = 'asc';
        } else {
            this.listSortOrder = 'desc';
        }

        // Update visual indicator
        titleHeader.classList.remove('sort-asc', 'sort-desc');
        if (this.listSortOrder !== 'none') {
            titleHeader.classList.add(`sort-${this.listSortOrder}`);
        }

        // Sort the filtered songs
        if (this.listSortOrder === 'asc') {
            this.filteredSongs.sort((a, b) =>
                a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
            );
        } else {
            this.filteredSongs.sort((a, b) =>
                b.title.localeCompare(a.title, undefined, { sensitivity: 'base' })
            );
        }

        // Re-render list view
        this.renderListView();
    }

    async removeSong() {
        if (!this.selectedSong) return;

        const { id, title, artist } = this.selectedSong;

        // Confirm deletion
        if (!confirm(`Remove "${title}" by ${artist}?\n\nThis will permanently delete the song file.`)) {
            return;
        }

        try {
            // Stop playback if this song is currently playing
            const currentSong = window.player?.getCurrentSong();
            if (currentSong && currentSong.id === id) {
                window.player.audio.pause();
                window.player.audio.src = '';
            }

            // Delete by database ID
            const response = await this.api(`/api/music/song/${id}`, 'DELETE');

            if (response.success) {
                // Refresh library
                this.loadLibrary();
            } else {
                throw new Error(response.error || 'Failed to remove song');
            }
        } catch (error) {
            console.error('Error removing song:', error);
            alert('Failed to remove song: ' + error.message);
        }
    }

    // Add Music Modal Methods
    openAddMusicModal() {
        document.getElementById('add-music-modal')?.classList.remove('hidden');
        // Reset to upload tab
        this.switchAddMusicTab('upload');
        // Reset inputs
        document.getElementById('youtube-url-input').value = '';
        document.getElementById('file-upload-input').value = '';
        document.getElementById('upload-progress')?.classList.add('hidden');
        document.getElementById('youtube-status')?.classList.add('hidden');
    }

    closeAddMusicModal() {
        document.getElementById('add-music-modal')?.classList.add('hidden');
    }

    switchAddMusicTab(tabName) {
        // Update tab buttons
        document.querySelectorAll('.add-music-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.tab === tabName);
        });
        // Update tab content
        document.querySelectorAll('.add-music-tab-content').forEach(content => {
            content.classList.remove('active');
        });
        document.getElementById(`${tabName}-tab`)?.classList.add('active');
    }

    async uploadFiles(files) {
        const dropzone = document.getElementById('upload-dropzone');
        const progress = document.getElementById('upload-progress');
        const progressFill = document.getElementById('upload-progress-fill');
        const statusText = document.getElementById('upload-status');

        dropzone.classList.add('hidden');
        progress.classList.remove('hidden');
        progressFill.style.width = '0%';

        const formData = new FormData();
        for (const file of files) {
            formData.append('files', file);
        }

        try {
            statusText.textContent = `Uploading ${files.length} file(s)...`;

            const response = await fetch('/api/music/upload', {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                throw new Error('Upload failed');
            }

            const result = await response.json();
            progressFill.style.width = '100%';
            statusText.textContent = `Successfully uploaded ${result.uploaded || files.length} file(s)!`;

            // Refresh library after short delay
            setTimeout(() => {
                this.closeAddMusicModal();
                this.loadLibrary();
            }, 1500);
        } catch (error) {
            console.error('Upload error:', error);
            statusText.textContent = 'Upload failed. Please try again.';
            setTimeout(() => {
                dropzone.classList.remove('hidden');
                progress.classList.add('hidden');
            }, 2000);
        }
    }

    async importFromYouTube() {
        const urlInput = document.getElementById('youtube-url-input');
        const importBtn = document.getElementById('youtube-import-btn');
        const status = document.getElementById('youtube-status');
        const statusText = document.getElementById('youtube-status-text');
        const progressFill = document.getElementById('youtube-progress-fill');

        const url = urlInput.value.trim();
        if (!url) {
            urlInput.focus();
            return;
        }

        importBtn.disabled = true;
        status.classList.remove('hidden');
        progressFill.style.width = '0%';

        // Animate progress through stages
        const updateProgress = (percent, message) => {
            progressFill.style.width = `${percent}%`;
            statusText.textContent = message;
        };

        try {
            updateProgress(10, 'Connecting to YouTube...');

            // Start a simulated progress animation while waiting
            let currentProgress = 10;
            const progressInterval = setInterval(() => {
                if (currentProgress < 85) {
                    currentProgress += Math.random() * 5;
                    const messages = [
                        'Fetching video info...',
                        'Downloading audio...',
                        'Converting to MP3...',
                        'Downloading cover art...'
                    ];
                    const messageIndex = Math.min(Math.floor(currentProgress / 25), messages.length - 1);
                    updateProgress(currentProgress, messages[messageIndex]);
                }
            }, 500);

            const response = await this.api('/api/music/youtube-import', 'POST', { url });

            clearInterval(progressInterval);

            if (response.success) {
                updateProgress(100, `✓ Imported: ${response.title || 'song'}`);
                setTimeout(() => {
                    this.closeAddMusicModal();
                    this.loadLibrary();
                }, 1500);
            } else {
                throw new Error(response.error || 'Import failed');
            }
        } catch (error) {
            console.error('YouTube import error:', error);
            progressFill.style.width = '0%';
            statusText.textContent = error.message || 'Import failed. Please try again.';
            setTimeout(() => {
                status.classList.add('hidden');
            }, 3000);
        } finally {
            importBtn.disabled = false;
        }
    }

    // API helper
    async api(url, method = 'GET', data = null) {
        return API.request(url, method, data);
    }

    // Utility functions
    formatDuration(seconds) {
        return Utils.formatDuration(seconds);
    }

    escapeHtml(text) {
        return Utils.escapeHtml(text);
    }

    showToast(message, type = 'success', duration = 3000) {
        return Utils.showToast(message, type, duration);
    }

    handleCoverError(img) {
        if (!img) return;

        // Helper to create the fallback SVG
        const createFallback = () => {
            const div = document.createElement('div');
            div.innerHTML = `
                <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" class="cover-placeholder">
                    <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
                </svg>
            `;
            return div.querySelector('svg');
        };

        // Try to reload the image up to 3 times
        const retries = parseInt(img.dataset.retries || '0');

        if (retries < 3) {
            img.dataset.retries = retries + 1;

            // Should show placeholder while retrying?
            // Hide the broken image (removes alt text)
            img.style.display = 'none';

            // Check if we already have a placeholder next to it
            let placeholder = null;
            if (img.nextElementSibling && img.nextElementSibling.classList.contains('cover-placeholder')) {
                placeholder = img.nextElementSibling;
            } else {
                placeholder = createFallback();
                if (placeholder && img.parentNode) {
                    img.parentNode.insertBefore(placeholder, img.nextSibling);
                }
            }

            // Setup success handler to revert
            img.onload = () => {
                img.style.display = ''; // Show image
                if (placeholder) placeholder.remove();
                img.onload = null; // cleanup
            };

            setTimeout(() => {
                const src = img.src.split('?')[0];
                img.src = `${src}?retry=${Date.now()}`;
            }, 1000 * (retries + 1));
            return;
        }

        // Final failure: Replace with SVG permanently
        if (img.parentNode) {
            const svgElement = createFallback();
            if (svgElement) {
                // If we had a temporary placeholder, remove it first
                if (img.nextElementSibling && img.nextElementSibling.classList.contains('cover-placeholder')) {
                    img.nextElementSibling.remove();
                }
                img.parentNode.replaceChild(svgElement, img);
            }
        }
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

    // Context menu methods
    showContextMenu(event, songData) {
        const contextMenu = document.getElementById('song-context-menu');
        if (!contextMenu) return;

        // Find the full song object to get the path
        const fullSong = this.songs.find(s => s.id == songData.songId);

        this.selectedSong = {
            id: songData.songId,
            title: songData.songTitle,
            artist: songData.songArtist,
            path: fullSong?.path || songData.songId  // Fallback to songId if not found
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
    }

    hideContextMenu() {
        const contextMenu = document.getElementById('song-context-menu');
        contextMenu?.classList.add('hidden');
    }

    // Metadata modal methods
    openMetadataModal() {
        if (!this.selectedSong) return;

        const modal = document.getElementById('metadata-modal');
        const songName = document.getElementById('metadata-song-name');
        const searchInput = document.getElementById('metadata-search-input');
        const resultsContainer = document.getElementById('metadata-results');
        const noResults = document.getElementById('metadata-no-results');
        const loading = document.getElementById('metadata-loading');

        // Reset modal state
        resultsContainer.innerHTML = '';
        noResults.classList.add('hidden');
        loading.classList.add('hidden');

        // Set song info and pre-fill search
        songName.textContent = `${this.selectedSong.title} - ${this.selectedSong.artist}`;
        searchInput.value = `${this.selectedSong.title} ${this.selectedSong.artist}`;

        modal?.classList.remove('hidden');

        // Auto-search
        this.searchMetadata();
    }

    closeMetadataModal() {
        const modal = document.getElementById('metadata-modal');
        modal?.classList.add('hidden');
        this.selectedSong = null;
    }

    async searchMetadata() {
        const searchInput = document.getElementById('metadata-search-input');
        const resultsContainer = document.getElementById('metadata-results');
        const noResults = document.getElementById('metadata-no-results');
        const loading = document.getElementById('metadata-loading');

        const query = searchInput.value.trim();
        if (!query) return;

        // Show loading
        loading.classList.remove('hidden');
        resultsContainer.innerHTML = '';
        noResults.classList.add('hidden');

        try {
            const response = await this.api('/api/music/metadata/search', 'POST', { query });

            loading.classList.add('hidden');

            if (response.success && response.results && response.results.length > 0) {
                this.renderMetadataResults(response.results);
            } else {
                noResults.classList.remove('hidden');
            }
        } catch (error) {
            console.error('Metadata search error:', error);
            loading.classList.add('hidden');
            noResults.classList.remove('hidden');
        }
    }

    renderMetadataResults(results) {
        const container = document.getElementById('metadata-results');

        container.innerHTML = results.map(result => `
            <div class="metadata-result-card" data-result='${JSON.stringify(result).replace(/'/g, "&#39;")}'>
                <div class="metadata-result-cover">
                    ${result.cover_url
                ? `<img src="${result.cover_url}" alt="Cover" loading="lazy">`
                : `<svg viewBox="0 0 24 24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>`
            }
                </div>
                <div class="metadata-result-info">
                    <div class="metadata-result-title">${this.escapeHtml(result.title)}</div>
                    <div class="metadata-result-artist">${this.escapeHtml(result.artist)}</div>
                    <div class="metadata-result-album">${this.escapeHtml(result.album)}</div>
                    <div class="metadata-result-duration">${result.duration_text || this.formatDuration(result.duration)}</div>
                </div>
                <div class="metadata-result-action">
                    <button class="btn btn-primary apply-metadata-btn">Apply</button>
                </div>
            </div>
        `).join('');

        // Add click listeners
        container.querySelectorAll('.apply-metadata-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const card = btn.closest('.metadata-result-card');
                const result = JSON.parse(card.dataset.result);
                this.applyMetadata(result);
            });
        });
    }

    async applyMetadata(metadata) {
        if (!this.selectedSong) return;

        // Store the song ID before we clear selectedSong
        const songId = this.selectedSong.id;

        const applyButtons = document.querySelectorAll('.apply-metadata-btn');
        applyButtons.forEach(btn => btn.disabled = true);

        try {
            const response = await this.api(
                `/api/music/metadata/apply/${songId}`,
                'POST',
                {
                    title: metadata.title,
                    artist: metadata.artist,
                    album: metadata.album,
                    year: metadata.year,
                    cover_url: metadata.cover_url
                }
            );

            if (response.success) {
                // Close modal first
                this.closeMetadataModal();

                // Update local song data in ALL caches
                const updatedSong = response.song;
                if (updatedSong.cover_path) {
                    this.coverVersion[songId] = Date.now();
                    this.coverOverride[songId] = updatedSong.cover_path;
                }

                // Update main songs array
                const songIndex = this.songs.findIndex(s => s.id === songId);
                if (songIndex !== -1) {
                    this.songs[songIndex] = { ...this.songs[songIndex], ...updatedSong };
                }

                // Update filtered songs
                const filteredIndex = this.filteredSongs.findIndex(s => s.id === songId);
                if (filteredIndex !== -1) {
                    this.filteredSongs[filteredIndex] = { ...this.filteredSongs[filteredIndex], ...updatedSong };
                }

                // Update library cache (for switching back from playlist view)
                if (this.librarySongs) {
                    const libIndex = this.librarySongs.findIndex(s => s.id === songId);
                    if (libIndex !== -1) {
                        this.librarySongs[libIndex] = { ...this.librarySongs[libIndex], ...updatedSong };
                    }
                }

                // Update sections cache
                if (this.librarySections) {
                    for (const section of this.librarySections) {
                        const sectionSongIndex = section.songs.findIndex(s => s.id === songId);
                        if (sectionSongIndex !== -1) {
                            section.songs[sectionSongIndex] = { ...section.songs[sectionSongIndex], ...updatedSong };
                        }
                    }
                }

                // Re-render with sections
                if (this.sections && this.sections.length > 0) {
                    // Update current sections data
                    for (const section of this.sections) {
                        const sectionSongIndex = section.songs.findIndex(s => s.id === songId);
                        if (sectionSongIndex !== -1) {
                            section.songs[sectionSongIndex] = { ...section.songs[sectionSongIndex], ...updatedSong };
                        }
                    }
                    this.renderSections();
                } else {
                    this.renderSongs();
                }

                if (updatedSong.cover_path) {
                    this.coverVersion[songId] = Date.now();
                    setTimeout(() => {
                        const ts = this.coverVersion[songId] || Date.now();
                        document.querySelectorAll(`[data-id="${songId}"] .song-artwork, [data-id="${songId}"] .song-row-artwork`).forEach(container => {
                            const img = container.querySelector('img');
                            if (img) {
                                const base = img.src.split('?')[0];
                                img.src = `${base}?t=${ts}`;
                            } else {
                                const svg = container.querySelector('svg');
                                const newImg = document.createElement('img');
                                newImg.alt = 'Cover';
                                newImg.loading = 'lazy';
                                newImg.src = `/api/music/cover/${encodeURIComponent(updatedSong.cover_path)}?t=${ts}`;
                                newImg.onerror = () => window.handleCoverError ? window.handleCoverError(newImg) : null;
                                if (svg) {
                                    container.insertBefore(newImg, svg);
                                    svg.remove();
                                } else {
                                    container.insertBefore(newImg, container.firstChild);
                                }
                            }
                        });
                    }, 50);
                }

                // Update player if this song is currently playing
                if (window.player && window.player.currentSong && window.player.currentSong.id === songId) {
                    window.player.updateNowPlaying(updatedSong);
                }

                this.showToast('Metadata updated successfully', 'success');
            } else {
                alert('Failed to apply metadata: ' + (response.error || 'Unknown error'));
            }
        } catch (error) {
            console.error('Apply metadata error:', error);
            alert('Failed to apply metadata: ' + error.message);
        } finally {
            applyButtons.forEach(btn => btn.disabled = false);
        }
    }
    // Playlist Methods

    async loadPlaylists() {
        try {
            const playlists = await this.api('/api/playlists');
            this.playlists = playlists;
            this.renderSidebarPlaylists();
        } catch (error) {
            console.error('Error loading playlists:', error);
        }
    }

    renderSidebarPlaylists() {
        const container = document.getElementById('sidebar-playlists');
        Playlists.renderSidebar(
            container,
            this.playlists,
            this.currentPlaylistId,
            this.currentViewType,
            this.escapeHtml.bind(this),
            (id) => this.openPlaylist(id)
        );
    }

    openCreatePlaylistModal() {
        document.getElementById('create-playlist-modal').classList.remove('hidden');
        document.getElementById('playlist-name-input').value = '';
        document.getElementById('playlist-name-input').focus();
    }

    async createPlaylist() {
        const nameInput = document.getElementById('playlist-name-input');
        const name = nameInput.value.trim();
        if (!name) return;

        try {
            const response = await this.api('/api/playlists', 'POST', { name });
            if (response.success) {
                document.getElementById('create-playlist-modal').classList.add('hidden');
                await this.loadPlaylists();
                this.showToast('Playlist created', 'success');
            } else {
                this.showToast(response.error || 'Failed to create playlist', 'error');
            }
        } catch (error) {
            console.error('Error creating playlist:', error);
            this.showToast('Failed to create playlist', 'error');
        }
    }

    renameCurrentPlaylist() {
        if (!this.currentPlaylistId) return;

        const playlist = this.playlists.find(p => p.id === this.currentPlaylistId);
        const currentName = playlist ? playlist.name : '';

        document.getElementById('rename-playlist-input').value = currentName;
        document.getElementById('rename-playlist-modal').classList.remove('hidden');
        document.getElementById('rename-playlist-input').focus();
    }

    async performRenamePlaylist() {
        const input = document.getElementById('rename-playlist-input');
        const newName = input.value.trim();

        if (!newName) {
            this.showToast('Playlist name cannot be empty', 'error');
            return;
        }

        try {
            const response = await this.api(`/api/playlists/${this.currentPlaylistId}`, 'PUT', {
                name: newName
            });

            if (response.success) {
                document.getElementById('rename-playlist-modal').classList.add('hidden');
                await this.loadPlaylists(); // Refresh sidebar

                // Update header if we are still on that playlist
                document.querySelector('.section-title').textContent = newName;
                this.showToast('Playlist renamed', 'success');
            } else {
                this.showToast(response.error || 'Failed to rename playlist', 'error');
            }
        } catch (error) {
            console.error('Error renaming playlist:', error);
            this.showToast('Failed to rename playlist', 'error');
        }
    }

    deleteCurrentPlaylist() {
        if (!this.currentPlaylistId) return;
        document.getElementById('delete-playlist-modal').classList.remove('hidden');
    }

    async performDeletePlaylist() {
        try {
            const response = await this.api(`/api/playlists/${this.currentPlaylistId}`, 'DELETE');

            if (response.success) {
                document.getElementById('delete-playlist-modal').classList.add('hidden');
                await this.loadPlaylists(); // Refresh sidebar list
                this.switchToLibraryView(); // Go back to library
                this.showToast('Playlist deleted', 'success');
            } else {
                this.showToast(response.error || 'Failed to delete playlist', 'error');
            }
        } catch (error) {
            console.error('Error deleting playlist:', error);
            this.showToast('Failed to delete playlist', 'error');
        }
    }

    async openPlaylist(playlistId) {
        try {
            const playlist = await this.api(`/api/playlists/${playlistId}`);
            if (playlist && playlist.songs) {
                this.currentViewType = 'playlist';
                this.currentPlaylistId = playlistId;

                // Update UI state
                document.querySelectorAll('.app-sidebar .nav-item').forEach(el => el.classList.remove('active'));

                // Re-render sidebar to highlight active playlist
                this.renderSidebarPlaylists();

                // Update Header
                document.querySelector('.section-title').textContent = playlist.name;
                document.getElementById('library-subtitle').textContent = `${playlist.songs.length} songs`;
                document.getElementById('library-stats').classList.add('hidden');

                // Show playlist settings menu
                document.getElementById('playlist-menu-container').classList.remove('hidden');

                // Set content
                this.songs = playlist.songs;
                this.filteredSongs = [...playlist.songs];

                // Create a dummy section for compatibility
                this.sections = [{
                    type: 'grid',
                    title: 'Playlist Songs',
                    songs: this.songs
                }];

                // Reset search if any
                document.getElementById('search-input').value = '';

                this.renderSections();
            }
        } catch (error) {
            console.error('Error loading playlist:', error);
        }
    }

    switchToLibraryView() {
        if (this.currentViewType === 'library') return;

        this.currentViewType = 'library';
        this.currentPlaylistId = null;

        // Update Sidebar UI
        document.querySelectorAll('.app-sidebar .nav-item').forEach(el => el.classList.remove('active'));
        document.getElementById('nav-library').classList.add('active');
        this.renderSidebarPlaylists(); // Remove active state from playlist items

        // Restore Library Content
        this.songs = [...(this.librarySongs || [])];
        this.sections = JSON.parse(JSON.stringify(this.librarySections || []));
        this.filteredSongs = [...this.songs];

        // Update Header
        document.querySelector('.section-title').textContent = 'Your Library';
        const totalSongs = this.songs.length;
        document.getElementById('library-subtitle').textContent = 'All your music in one place';

        // Hide playlist settings menu
        document.getElementById('playlist-menu-container').classList.add('hidden');

        // Show Stats
        document.getElementById('library-stats').classList.remove('hidden');
        document.getElementById('stat-songs').textContent = totalSongs;

        // Clear search
        document.getElementById('search-input').value = '';

        this.renderSections();
    }

    renderPlaylistSubmenu() {
        const container = document.getElementById('context-playlists-list');
        if (!container) return;

        container.innerHTML = '';
        (this.playlists || []).forEach(playlist => {
            const item = document.createElement('div');
            item.className = 'context-menu-item';
            item.innerHTML = `
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/></svg>
                <span>${this.escapeHtml(playlist.name)}</span>
            `;
            item.addEventListener('click', (e) => this.addToPlaylist(playlist.id, e));
            container.appendChild(item);
        });
    }

    async addToPlaylist(playlistId, event) {
        if (event) event.stopPropagation();
        if (!this.selectedSong) return;

        try {
            const response = await this.api(`/api/playlists/${playlistId}/songs`, 'POST', {
                song_id: this.selectedSong.id
            });

            if (response.success) {
                // Determine playlist name for toaster
                const playlist = this.playlists.find(p => p.id === playlistId);
                const playlistName = playlist ? playlist.name : 'Unknown Playlist';

                this.hideContextMenu();
                this.showToast(`Added to "${playlistName}"`, 'success');
            } else {
                throw new Error(response.error || 'Failed to add to playlist');
            }
        } catch (error) {
            console.error('Error adding to playlist:', error);
            this.showToast('Failed to add song to playlist', 'error');
        }
    }
}
