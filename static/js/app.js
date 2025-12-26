import { ResponseError } from './helper/request.js';
import { Result } from './helper/result.js';
import { Router, View } from './helper/router.js';
import { Library } from './modules/library.js';
import { Playlists } from './modules/playlists.js';
import { Utils } from './modules/utils.js';
import { AuthService } from "./services/auth.js";
import { MetadataService } from './services/metadata.js';
import { MusicService } from "./services/music.js";
import { PlaylistService } from './services/playlist.js';
import { ScanService } from './services/scan.js';
import { SetupService } from "./services/setup.js";
import * as AppView from "./view/app.js";
import * as LoginView from "./view/login.js";

export class RainyApp {
    constructor() {
        this.user = null;
        this.songs = [];
        this.filteredSongs = [];
        this.currentViewMode = 'grid'; // 'grid' or 'list'
        this.selectedSong = null; // For context menu
        this.listSortOrder = 'none'; // 'none', 'asc', 'desc'
        this.currentSort = 'default';
        this.coverVersion = {};
        this.coverOverride = {};

        this.authService = new AuthService();
        this.setupService = new SetupService();
        this.musicService = new MusicService();
        this.scanService = new ScanService();
        this.metadataService = new MetadataService();
        this.playlistService = new PlaylistService();

        Router.register('login', LoginView.handle);
        Router.register('app', AppView.handle);

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

        document.getElementById('setup-view').classList.add('hidden');
        document.getElementById('login-view').classList.add('hidden');
        document.getElementById('app-view').classList.add('hidden');

        let data = await this.setupService.status();
        if(data.error) return console.error(data.error);

        const setup = data.value;
        if(!setup) return console.error('unreachable');
        if(setup.needs_setup) return Router.navigate(new View('setup'));

        /** @type {Result<import('../services/auth.js').UserModel, import('../services/auth.js').ErrorModel | ResponseError>} */
        data = await this.authService.me();
        if(data.error) {
            if('authenticated' in data.error) return Router.navigate(new View('login'));
            return console.error(data.error);;
        }

        const user = data.value;
        if(!user) return console.error('unreachable');

        Router.navigate(new View('app', user));
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
        const data = await this.scanService.status();
        if(data.error) return console.error(data.error);

        const status = data.value;
        if(!status) return console.error('unreachable');

        const libraryCount = document.querySelector('#library-count');
        const lastScanTime = document.querySelector('#last-scan-time');

        if(libraryCount) libraryCount.textContent = `${status.library_total || 0} songs`;
        if(lastScanTime && status.has_scan) {
            if(status.scan.status === 'running') {
                lastScanTime.textContent = 'In progress...';
                return;
            }

            lastScanTime.textContent = (new Date(status.scan.completed_at)).toLocaleString();
        }
    }

    async runScan(fullScan = false) {
        const quickScanBtn = document.getElementById('quick-scan-btn');
        const fullScanBtn = document.getElementById('full-scan-btn');
        const scanProgress = document.getElementById('scan-progress');
        const scanProgressText = document.getElementById('scan-progress-text');
        const scanResult = document.getElementById('scan-result');

        quickScanBtn.disabled = true;
        fullScanBtn.disabled = true;
        scanProgress?.classList.remove('hidden');
        scanResult?.classList.add('hidden');
        scanProgressText.textContent = fullScan ? 'Running full scan...' : 'Scanning for new files...';

        const data = await (fullScan
            ? this.scanService.full()
            : this.scanService.quick());
        if(data.error) {
            console.error(data.error);
            scanProgress?.classList.add('hidden');

            quickScanBtn.disabled = false;
            fullScanBtn.disabled = false;

            return;
        }

        const scan = data.value;
        if(!scan) return console.error('unreachable');

        scanProgress?.classList.add('hidden');
        scanResult?.classList.remove('hidden');

        if(scan.stats) {
            document.getElementById('scan-files-found').textContent = scan.stats.files_found || 0;
            document.getElementById('scan-files-added').textContent = scan.stats.files_added || 0;
            document.getElementById('scan-files-updated').textContent = scan.stats.files_updated || 0;
            document.getElementById('scan-files-removed').textContent = scan.stats.files_removed || 0;
        }

        await this.loadScanStatus();
        this.loadLibrary();
            
        quickScanBtn.disabled = false;
        fullScanBtn.disabled = false;
    }

    async loadLibrary() {
        const loadingState = document.getElementById('loading-state');
        const emptyState = document.getElementById('empty-state');
        const songsGrid = document.getElementById('songs-grid');

        loadingState.classList.remove('hidden');
        emptyState.classList.add('hidden');
        songsGrid.innerHTML = '';
        document.getElementById('songs-list-content').innerHTML = '';

        const data = await this.musicService.library();
        if(data.error) {
            console.error('Failed to load music libary!', data.error);
            loadingState.classList.add('hidden');
            emptyState.classList.remove('hidden');

            return;
        }

        const library = data.value;
        if(!library) throw new Error('unreachable');
        loadingState.classList.add('hidden');

        const allSongs = library.all_songs;
        if(allSongs && allSongs.length > 0) {
            this.songs = allSongs;
            this.librarySongs = [...this.songs];
            this.currentViewType = 'library';
            this.sections = library.sections || [];
            this.librarySections = JSON.parse(JSON.stringify(this.sections));
            this.filteredSongs = [...this.songs];
            this.renderSections();
            this.updateStats();

            return;
        }
            
        emptyState.classList.remove('hidden');
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
        // FIXME: Handle error
        await this.authService.logout();

        this.user = null;
        this.songs = [];
        this.filteredSongs = [];

        Router.navigate(new View('login'));
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

        // FIXME: Use Dialog with actions (cancel, confirm)
        if (!confirm(`Remove "${title}" by ${artist}?\n\nThis will permanently delete the song file.`)) {
            return;
        }

        const currentSong = window.player.getCurrentSong();
        if(currentSong && currentSong.id === id) {
            window.player.audio.pause();
            window.player.audio.src = '';
        }

        const data = await this.musicService.delete(id);
        // FIXME: Add toast notification
        if(data.error) return console.error(data.error);

        const result = data.value;
        if(!result) return console.error('unreachable');

        this.loadLibrary();
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

    // FIXME: This method is fucking crazy. Refactor it ASAP
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

        const data = await this.musicService.YouTube.import(url);
        if(data.error) {
            console.error(data.error);

            importBtn.disabled = false;
            progressFill.style.width = '0%';
            statusText.textContent = error.message || 'Import failed. Please try again.';
            setTimeout(() => {
                status.classList.add('hidden');
            }, 3000);

            return;
        }

        const result = data.value;
        if(!result) return console.error('unreachable');

        clearInterval(progressInterval);
        updateProgress(100, `✓ Imported: ${result.title || 'song'}`);
        setTimeout(() => {
            this.closeAddMusicModal();
            this.loadLibrary();
        }, 1500);

        importBtn.disabled = false;
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

        loading.classList.remove('hidden');
        resultsContainer.innerHTML = '';
        noResults.classList.add('hidden');

        const data = await this.metadataService.search(query);
        if(data.error) {
            console.error(data.error);
            loading.classList.add('hidden');
            noResults.classList.remove('hidden');

            return;
        }

        loading.classList.add('hidden');

        const matches = data.value;
        if(!matches) return console.error('unreachable');
        if(matches.results.length === 0) {
            noResults.classList.remove('hidden');
            return;
        }

        this.renderMetadataResults(matches.results);
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

    // FIXME: This method is fucking crazy. Refactor it ASAP
    async applyMetadata(metadata) {
        if (!this.selectedSong) return;
        const songId = this.selectedSong.id;

        const applyButtons = document.querySelectorAll('.apply-metadata-btn');
        applyButtons.forEach(btn => btn.disabled = true);

        const data = await this.metadataService.apply(songId, 
            metadata.title, metadata.artist, metadata.album, metadata.year, metadata.genre, metadata.cover_url);
        if(data.error) {
            console.log(data.error);
            applyButtons.forEach(btn => btn.disabled = false);

            return;
        }

        const result = data.value;
        if(!result) return console.error('unreachable');
        this.closeMetadataModal();

        const updatedSong = result.song;
        if (updatedSong.cover_path) {
            this.coverVersion[songId] = Date.now();
            this.coverOverride[songId] = updatedSong.cover_path;
        }

        const songIndex = this.songs.findIndex(s => s.id === songId);
        if (songIndex !== -1) {
            this.songs[songIndex] = { ...this.songs[songIndex], ...updatedSong };
        }

        const filteredIndex = this.filteredSongs.findIndex(s => s.id === songId);
        if (filteredIndex !== -1) {
            this.filteredSongs[filteredIndex] = { ...this.filteredSongs[filteredIndex], ...updatedSong };
        }

        if (this.librarySongs) {
            const libIndex = this.librarySongs.findIndex(s => s.id === songId);
            if (libIndex !== -1) {
                this.librarySongs[libIndex] = { ...this.librarySongs[libIndex], ...updatedSong };
            }
        }

        if (this.librarySections) {
            for (const section of this.librarySections) {
                const sectionSongIndex = section.songs.findIndex(s => s.id === songId);
                if (sectionSongIndex !== -1) {
                    section.songs[sectionSongIndex] = { ...section.songs[sectionSongIndex], ...updatedSong };
                }
            }
        }

        if (this.sections && this.sections.length > 0) {
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

        if (window.player && window.player.currentSong && window.player.currentSong.id === songId) {
            window.player.updateNowPlaying(updatedSong);
        }

        this.showToast('Metadata updated successfully', 'success');
    }
    // Playlist Methods

    async loadPlaylists() {
        const data = await this.playlistService.all();
        // FIXME: Show toast notification
        if(data.error) return console.error(data.error);

        const playlists = data.value;
        if(!Array.isArray(playlists)) return console.error('unreachable');

        this.playlists = playlists;
        this.renderSidebarPlaylists();
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

        const data = await this.playlistService.create(name);
        if(data.error) {
            console.error(data.error);
            this.showToast('Failed to create playlist', 'error');
            return;
        }

        document.getElementById('create-playlist-modal').classList.add('hidden');
        await this.loadPlaylists();
        this.showToast('Playlist created', 'success');
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
        if(!newName) return this.showToast('Playlist name cannot be empty', 'error');

        const data = await this.playlistService.rename(this.currentPlaylistId, newName);
        if(data.error) {
            console.error(data.error);
            this.showToast('Failed to rename playlist', 'error');

            return;
        }

        document.getElementById('rename-playlist-modal').classList.add('hidden');
        await this.loadPlaylists();

        document.querySelector('.section-title').textContent = newName;
        this.showToast('Playlist renamed', 'success');
    }

    deleteCurrentPlaylist() {
        if (!this.currentPlaylistId) return;
        document.getElementById('delete-playlist-modal').classList.remove('hidden');
    }

    async performDeletePlaylist() {
        const data = await this.playlistService.delete(this.currentPlaylistId);
        if(data.error) {
            console.error(data.error);
            this.showToast('Failed to delete playlist', 'error');

            return;
        }

        document.getElementById('delete-playlist-modal').classList.add('hidden');
        await this.loadPlaylists();
        this.switchToLibraryView();
        this.showToast('Playlist deleted', 'success');
    }

    async openPlaylist(playlistId) {
        const data = await this.playlistService.fetch(playlistId);
        // FIXME: Show toast notification
        if(data.error) return console.error(data.error);

        const playlist = data.value;
        if(!playlist) return console.error('unreachable');

        this.currentViewType = 'playlist';
        this.currentPlaylistId = playlistId;

        document.querySelectorAll('.app-sidebar .nav-item').forEach(el => el.classList.remove('active'));
        this.renderSidebarPlaylists();

        document.querySelector('.section-title').textContent = playlist.name;
        document.getElementById('library-subtitle').textContent = `${playlist.songs.length} songs`;
        document.getElementById('library-stats').classList.add('hidden');

        document.getElementById('playlist-menu-container').classList.remove('hidden');

        this.songs = playlist.songs;
        this.filteredSongs = [...playlist.songs];

        this.sections = [{
            type: 'grid',
            title: 'Playlist Songs',
            songs: this.songs
        }];

        document.getElementById('search-input').value = '';
        this.renderSections();
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
        if(event) event.stopPropagation();
        if(!this.selectedSong) return;

        const data = await this.playlistService.addSong(playlistId, this.selectedSong.id);
        if(data.error) {
            console.error(data.error);
            this.showToast('Failed to add song to playlist', 'error');

            return;
        }

        const playlist = this.playlists.find(p => p.id === playlistId);
        const playlistName = playlist ? playlist.name : 'Unknown Playlist';

        this.hideContextMenu();
        this.showToast(`Added to "${playlistName}"`, 'success');
    }
}
