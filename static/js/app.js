import { PLAYLIST_ICONS, PLAYLIST_ICON_COLORS } from './data/playlist-icons.js';
import { useContext } from './helper/context.js';
import { Logger } from "./helper/logger.js";
import { ResponseError } from './helper/request.js';
import { Result } from './helper/result.js';
import { Router, View } from './helper/router.js';
import { Library } from './modules/library.js';
import { Playlists } from './modules/playlists.js';
import { Utils } from './modules/utils.js';
import { useAuthService } from "./services/auth.js";
import { useMusicService } from "./services/music.js";
import { usePlaylistService } from './services/playlist.js';
import { useScanService } from './services/scan.js';
import { useSetupService } from "./services/setup.js";
import * as AppView from "./view/app.js";
import * as LoginView from "./view/login.js";
import * as SetupView from "./view/setup.js";

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

        useContext().set('app', this);

        Router.register('login', LoginView.handle);
        Router.register('app', AppView.handle);
        Router.register('setup', SetupView.handle);

        this.init();
    }

    async init() {
        const ctx = useContext();
        ctx.set('current-view-type', 'library');

        // Restore sidebar state
        const isCollapsed = localStorage.getItem('sidebarCollapsed') === 'true';
        if (isCollapsed) {
            document.querySelector('.app-sidebar')?.classList.add('collapsed');
            document.querySelector('.header-left')?.classList.add('collapsed');
        }

        // Bind event listeners
        this.bindEvents();

        document.getElementById('setup-view').classList.add('hidden');
        document.getElementById('login-view').classList.add('hidden');
        document.getElementById('app-view').classList.add('hidden');

        let data = await useSetupService().status();
        if (data.error) return Logger.error(data.error);

        const setup = data.value;
        if (!setup) return Logger.error('unreachable');
        if (setup.needs_setup) return Router.navigate(new View('setup'), this);

        /** @type {Result<import('../services/auth.js').UserModel, import('../services/auth.js').ErrorModel | ResponseError>} */
        data = await useAuthService().me();
        if (data.error) {
            if ('authenticated' in data.error) return Router.navigate(new View('login'), this);
            return Logger.error(data.error);
        }

        const user = data.value;
        if (!user) return Logger.error('unreachable');

        this.user = user;
        this.applyThemeFromPreferences();

        Router.navigate(new View('app', user), this);
    }

    bindEvents() {
        // Discord-style Settings Page
        document.getElementById('menu-settings')?.addEventListener('click', () => {
            this.closeDropdown();
            this.openSettings('appearance');
        });

        document.getElementById('settings-close')?.addEventListener('click', () => {
            this.closeSettings();
        });

        // Close settings with Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                const settingsPage = document.getElementById('settings-page');
                if (settingsPage && !settingsPage.classList.contains('hidden')) {
                    this.closeSettings();
                }
            }
        });

        // Settings sidebar navigation
        document.querySelectorAll('.settings-nav-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                const section = item.dataset.section;
                if (section) this.switchSettingsSection(section);
            });
        });

        // Settings search functionality
        document.getElementById('settings-search-input')?.addEventListener('input', (e) => {
            this.handleSettingsSearch(e.target.value);
        });

        // Color Picker Logic
        const colorInput = document.getElementById('settings-accent-color');

        // Real-time preview
        colorInput?.addEventListener('input', (e) => {
            const color = e.target.value;
            document.getElementById('settings-accent-color-value').textContent = color;
            this.applyTheme(color);
        });

        // Save on commit
        colorInput?.addEventListener('change', (e) => {
            this.savePreferences({ theme_color: e.target.value });
        });

        // Color Presets (new Discord-style presets)
        document.querySelectorAll('.settings-color-preset').forEach(btn => {
            btn.addEventListener('click', () => {
                const color = btn.dataset.color;
                if (colorInput) colorInput.value = color;
                document.getElementById('settings-accent-color-value').textContent = color;
                this.applyTheme(color);
                this.savePreferences({ theme_color: color });
            });
        });

        // Reset Theme
        document.getElementById('reset-theme-btn')?.addEventListener('click', () => {
            const defaultColor = '#fa586a';
            if (colorInput) colorInput.value = defaultColor;
            document.getElementById('settings-accent-color-value').textContent = defaultColor;
            this.applyTheme(defaultColor);
            this.savePreferences({ theme_color: defaultColor });
        });

        // Fullscreen Mode Setting (Discord radio button style)
        document.querySelectorAll('.settings-radio-item').forEach(item => {
            item.addEventListener('click', () => {
                const group = item.closest('.settings-radio-group');
                group.querySelectorAll('.settings-radio-item').forEach(i => i.classList.remove('selected'));
                item.classList.add('selected');
                const value = item.dataset.value;
                this.savePreferences({ fullscreen_mode: value });
            });
        });

        document.getElementById('settings-fullscreen-swap')?.addEventListener('change', (e) => {
            this.savePreferences({ fullscreen_swap_sides: e.target.checked });
        });

        // Change Password
        document.getElementById('change-password-form')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const currentPass = document.getElementById('current-password').value;
            const newPass = document.getElementById('new-password').value;
            const confirmPass = document.getElementById('confirm-password').value;

            if (newPass !== confirmPass) {
                this.showToast('New passwords do not match', 'error');
                return;
            }

            const data = await useAuthService().changePassword(currentPass, newPass);
            if (data.error) {
                this.showToast(data.error.error || 'Failed to change password', 'error');
                return;
            }

            this.showToast('Password updated successfully', 'success');
            document.getElementById('change-password-form').reset();
        });

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
        // User settings listener is already added at the top

        document.getElementById('menu-logout')?.addEventListener('click', () => {
            this.closeDropdown();
            this.handleLogout();
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

        // Edit Playlist Icon action
        document.getElementById('action-edit-playlist-icon')?.addEventListener('click', () => {
            document.getElementById('playlist-settings-dropdown').classList.add('hidden');
            this.openEditPlaylistIconModal();
        });

        // Edit Playlist Icon Modal
        document.getElementById('close-edit-icon-modal')?.addEventListener('click', () => {
            document.getElementById('edit-playlist-icon-modal').classList.add('hidden');
        });
        document.getElementById('cancel-edit-icon-btn')?.addEventListener('click', () => {
            document.getElementById('edit-playlist-icon-modal').classList.add('hidden');
        });
        document.getElementById('save-edit-icon-btn')?.addEventListener('click', () => {
            this.savePlaylistIcon();
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
            /** @type {import('./components/modal.js').Modal} */
            const modal = document.getElementById('delete-playlist-modal');
            modal.hide();
        });
        document.getElementById('confirm-delete-playlist')?.addEventListener('click', () => {
            this.performDeletePlaylist();
        });

        document.addEventListener('click', (e) => {
            /** @type {import('./components/contextMenu.js').ContextMenu} */
            const contextMenu = document.querySelector('rainy-song-context-menu');
            if(contextMenu && !contextMenu.contains(e.target) && !e.target.closest('.song-menu-btn')) {
                contextMenu.hide();
            }

            // Close playlist settings menu when clicking outside
            const playlistDropdown = document.getElementById('playlist-settings-dropdown');
            const playlistBtn = document.getElementById('playlist-settings-btn');
            if (playlistDropdown && !playlistDropdown.contains(e.target) && !playlistBtn?.contains(e.target)) {
                playlistDropdown.classList.add('hidden');
            }
        });

        // Add Music modal
        document.getElementById('menu-add-music')?.addEventListener('click', () => {
            this.closeDropdown();

            /** @type {import('./components/addMusicModal.js').AddMusicModal} */
            const modal = document.querySelector('rainy-add-music-modal');
            if(!modal) return;
            modal.show();
        });

        // Playlist events
        document.getElementById('sidebar-new-playlist')?.addEventListener('click', (e) => {
            e.stopPropagation(); // prevent triggering nav section collapse if we had that

            /** @type {import('./components/newPlaylistModal.js').NewPlaylistModal} */
            const modal = document.querySelector('rainy-new-playlist-modal');
            if(!modal) return;
            modal.show();
        });

        document.getElementById('nav-library')?.addEventListener('click', (e) => {
            e.preventDefault();
            this.switchToLibraryView();
        });

        // Sidebar Toggle
        document.getElementById('sidebar-toggle')?.addEventListener('click', () => {
            this.toggleSidebar();
        });
    }

    closeDropdown() {
        const userMenu = document.getElementById('user-menu');
        const userDropdown = document.getElementById('user-dropdown');
        userMenu?.classList.remove('open');
        userDropdown?.classList.add('hidden');
    }

    toggleSidebar() {
        const sidebar = document.querySelector('.app-sidebar');
        const headerLeft = document.querySelector('.header-left');
        if (sidebar) {
            sidebar.classList.toggle('collapsed');
            const isCollapsed = sidebar.classList.contains('collapsed');
            // Sync header-left width for browsers without :has() support
            if (headerLeft) {
                headerLeft.classList.toggle('collapsed', isCollapsed);
            }
            localStorage.setItem('sidebarCollapsed', isCollapsed);
        }
    }

    // Settings page is now unified - these methods redirect to the new settings page
    async openServerSettings() {
        this.openSettings('library');
    }

    closeServerSettings() {
        this.closeSettings();
    }

    async loadScanStatus() {
        const data = await useScanService().status();
        if (data.error) return Logger.error(data.error);

        const status = data.value;
        if (!status) return Logger.error('unreachable');

        const libraryCount = document.querySelector('#library-count');
        const lastScanTime = document.querySelector('#last-scan-time');

        if (libraryCount) libraryCount.textContent = `${status.library_total || 0} songs`;
        if (lastScanTime && status.has_scan) {
            if (status.scan.status === 'running') {
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
            ? useScanService().full()
            : useScanService().quick());
        if (data.error) {
            Logger.error(data.error);
            scanProgress?.classList.add('hidden');

            quickScanBtn.disabled = false;
            fullScanBtn.disabled = false;

            return;
        }

        const scan = data.value;
        if (!scan) return Logger.error('unreachable');

        scanProgress?.classList.add('hidden');
        scanResult?.classList.remove('hidden');

        if (scan.stats) {
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

        const data = await useMusicService().library();
        if (data.error) {
            Logger.error('Failed to load music libary!', data.error);
            loadingState.classList.add('hidden');
            emptyState.classList.remove('hidden');

            return;
        }

        const library = data.value;
        if (!library) throw new Error('unreachable');
        loadingState.classList.add('hidden');

        const allSongs = library.all_songs;
        if (allSongs && allSongs.length > 0) {
            this.songs = allSongs;
            this.librarySongs = [...this.songs];
            useContext().set('current-view-type', 'library');
            this.sections = library.sections || [];
            this.librarySections = JSON.parse(JSON.stringify(this.sections));
            this.filteredSongs = [...this.songs];
            this.renderSections();
            this.updateStats();

            // Restore last played song only on initial load (when player has no active playback)
            // Don't restore if player is already playing or has a song loaded
            if (!window.player ||
                (window.player.currentIndex < 0 && !window.player.audio.src)) {
                this.restorePlaybackState();
            } else if (window.player && window.player.playbackContext?.type === 'library') {
                // If player is playing from library, update the queue with new songs
                this.refreshLibraryQueue();
            }

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
            // FIXME: Why are we even passing on these methods???
            Utils.escapeHtml,
            Utils.formatDuration,
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
                    const context = useContext().get('current-view-type') === 'playlist'
                        ? { type: 'playlist', id: this.currentPlaylistId }
                        : { type: 'library', id: null };
                    window.player.playSong(index, this.songs, context);
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
            // FIXME: Why are we even passing on these methods???
            Utils.escapeHtml,
            Utils.formatDuration,
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
                const context = { type: 'search', id: null };
                window.player.playSong(index, this.filteredSongs, context);
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
            // FIXME: Why are we even passing on these methods???
            Utils.escapeHtml,
            Utils.formatDuration,
            this.coverOverride,
            this.coverVersion
        );

        // Add click listeners for play
        listContent.querySelectorAll('.song-row').forEach(row => {
            row.addEventListener('click', (e) => {
                // Don't play if clicking menu button
                if (e.target.closest('.song-menu-btn')) return;
                const index = parseInt(row.dataset.index);
                const currentViewType = useContext().get('current-view-type');
                const context = currentViewType === 'playlist'
                    ? { type: 'playlist', id: this.currentPlaylistId }
                    : currentViewType === 'library'
                        ? { type: 'library', id: null }
                        : { type: 'search', id: null };
                window.player.playSong(index, this.filteredSongs, context);
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
        await useAuthService().logout();

        this.user = null;
        this.songs = [];
        this.filteredSongs = [];

        Router.navigate(new View('login'), this);
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
        /** @type {import('./components/songContextMenu.js').SongContextMenu} */
        const songContextMenu = document.querySelector('rainy-song-context-menu');
        if(!songContextMenu) return;

        songContextMenu.setCurrentSong({
            id: songData.songId,
            title: songData.songTitle,
            artist: songData.songArtist
        });

        songContextMenu.show({ 
            x: event.clientX, 
            y: event.clientY
        });
    }

    // Playlist Methods

    async loadPlaylists() {
        const data = await usePlaylistService().all();
        // FIXME: Show toast notification
        if (data.error) return Logger.error(data.error);

        const playlists = data.value;
        if (!Array.isArray(playlists)) return Logger.error('unreachable');

        this.playlists = playlists;
        this.renderSidebarPlaylists();
    }

    renderSidebarPlaylists() {
        const container = document.getElementById('sidebar-playlists');
        Playlists.renderSidebar(
            container,
            this.playlists,
            this.currentPlaylistId,
            useContext().get('current-view-type'),
            // FIXME: Just why?
            Utils.escapeHtml,
            (id) => this.openPlaylist(id)
        );

        // Render "Liked Music" under the Library section (not in playlists list)
        const liked = (this.playlists || []).find(p => (p.name || '').toLowerCase() === 'liked music');
        const navLibrary = document.getElementById('nav-library');
        const existingLiked = document.getElementById('nav-liked');
        if(liked && navLibrary) {
            const iconId = liked.icon || 'like';
            const iconColor = liked.icon_color || '#fa586a';
            const icon = PLAYLIST_ICONS[iconId] || PLAYLIST_ICONS['like'];
            if(!existingLiked) {
                const a = document.createElement('a');
                a.className = 'nav-item';
                a.id = 'nav-liked';
                a.dataset.id = String(liked.id);
                a.innerHTML = `
                    <svg viewBox="0 0 24 24" fill="${iconColor}">
                        <path d="${icon.path}" />
                    </svg>
                    <span>Liked Music</span>
                `;
                a.addEventListener('click', (e) => {
                    e.preventDefault();
                    this.openPlaylist(liked.id);
                });
                navLibrary.parentElement?.insertBefore(a, navLibrary.nextSibling);
            } else {
                existingLiked.dataset.id = String(liked.id);
                const svg = existingLiked.querySelector('svg');
                const path = existingLiked.querySelector('path');
                if (svg) svg.setAttribute('fill', iconColor);
                if (path) path.setAttribute('d', icon.path);
            }
            // Active state
            if(useContext().get('current-view-type') === 'playlist' && this.currentPlaylistId === liked.id) {
                existingLiked ? existingLiked.classList.add('active') : null;
                navLibrary.classList.remove('active');
            } else {
                existingLiked ? existingLiked.classList.remove('active') : null;
            }
        } else if(existingLiked) {
            existingLiked.remove();
        }
    }

    initIconPicker(pickerContainerId, colorInputId, colorPresetsId, selectedIcon = 'music-note', selectedColor = '#888888', previewContainerId = null) {
        const iconPicker = document.getElementById(pickerContainerId);
        const colorInput = document.getElementById(colorInputId);
        const colorPresets = document.getElementById(colorPresetsId);
        const previewContainer = previewContainerId ? document.getElementById(previewContainerId) : null;

        if (!iconPicker) return;

        // Get the icon path for the selected icon
        const getIconPath = (iconId) => {
            const iconData = PLAYLIST_ICONS[iconId] || PLAYLIST_ICONS['music-note'];
            return iconData.path;
        };

        // Update the large preview icon
        const updatePreviewIcon = (iconId, color) => {
            if (previewContainer) {
                const path = getIconPath(iconId);
                previewContainer.innerHTML = `<svg viewBox="0 0 24 24" style="fill: ${color}"><path d="${path}"/></svg>`;
            }
        };

        // Helper function to update the selected icon's color preview
        const updateIconPreview = (color) => {
            const selectedBtn = iconPicker.querySelector('.icon-picker-btn.selected');
            if (selectedBtn) {
                const svg = selectedBtn.querySelector('svg');
                if (svg) svg.style.fill = color;
                // Also update the large preview
                updatePreviewIcon(selectedBtn.dataset.icon, color);
            }
        };

        // Initial preview
        updatePreviewIcon(selectedIcon, selectedColor);

        // Populate icons - all start grey, selected one gets the color
        iconPicker.innerHTML = Object.entries(PLAYLIST_ICONS).map(([id, icon]) => `
            <button type="button" class="icon-picker-btn ${id === selectedIcon ? 'selected' : ''}" data-icon="${id}" title="${icon.name}">
                <svg viewBox="0 0 24 24" style="fill: ${id === selectedIcon ? selectedColor : '#888888'}"><path d="${icon.path}"/></svg>
            </button>
        `).join('');

        // Icon selection handler
        iconPicker.querySelectorAll('.icon-picker-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                // Reset all icons to grey
                iconPicker.querySelectorAll('.icon-picker-btn').forEach(b => {
                    b.classList.remove('selected');
                    const svg = b.querySelector('svg');
                    if (svg) svg.style.fill = '#888888';
                });
                // Highlight selected icon with current color
                btn.classList.add('selected');
                const currentColor = colorInput?.value || '#888888';
                const svg = btn.querySelector('svg');
                if (svg) svg.style.fill = currentColor;
                // Update large preview
                updatePreviewIcon(btn.dataset.icon, currentColor);
            });
        });

        // Set color input value
        if (colorInput) {
            colorInput.value = selectedColor;

            // Live color preview when using color picker
            colorInput.addEventListener('input', (e) => {
                updateIconPreview(e.target.value);
                // Update preset selection
                colorPresets?.querySelectorAll('.color-preset').forEach(b => b.classList.remove('selected'));
            });
        }

        // Populate color presets
        if (colorPresets) {
            colorPresets.innerHTML = PLAYLIST_ICON_COLORS.map(color => `
                <button type="button" class="color-preset ${color === selectedColor ? 'selected' : ''}" data-color="${color}" style="background-color: ${color};"></button>
            `).join('');

            colorPresets.querySelectorAll('.color-preset').forEach(btn => {
                btn.addEventListener('click', () => {
                    const color = btn.dataset.color;
                    if (colorInput) colorInput.value = color;
                    colorPresets.querySelectorAll('.color-preset').forEach(b => b.classList.remove('selected'));
                    btn.classList.add('selected');
                    // Update icon preview with new color
                    updateIconPreview(color);
                });
            });
        }
    }

    getSelectedIconData(pickerContainerId, colorInputId) {
        const iconPicker = document.getElementById(pickerContainerId);
        const colorInput = document.getElementById(colorInputId);

        const selectedBtn = iconPicker?.querySelector('.icon-picker-btn.selected');
        const icon = selectedBtn?.dataset.icon || 'music-note';
        const iconColor = colorInput?.value || '#fa586a';

        return { icon, iconColor };
    }

    openEditPlaylistIconModal() {
        if (!this.currentPlaylistId) return;

        const playlist = this.playlists.find(p => p.id === this.currentPlaylistId);
        if (!playlist) return;

        const currentIcon = playlist.icon || 'music-note';
        const currentColor = playlist.icon_color || '#888888';

        document.getElementById('edit-playlist-icon-modal').classList.remove('hidden');
        this.initIconPicker('edit-playlist-icon-picker', 'edit-playlist-icon-color', 'edit-playlist-color-presets', currentIcon, currentColor, 'edit-playlist-preview-icon');
    }

    async savePlaylistIcon() {
        if (!this.currentPlaylistId) return;

        const { icon, iconColor } = this.getSelectedIconData('edit-playlist-icon-picker', 'edit-playlist-icon-color');

        const data = await usePlaylistService().updateAppearance(this.currentPlaylistId, icon, iconColor);
        if (data.error) {
            Logger.error(data.error);
            this.showToast('Failed to update playlist icon', 'error');
            return;
        }

        document.getElementById('edit-playlist-icon-modal').classList.add('hidden');
        await this.loadPlaylists();
        this.showToast('Playlist icon updated', 'success');
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
        if (!newName) return this.showToast('Playlist name cannot be empty', 'error');

        const data = await usePlaylistService().rename(this.currentPlaylistId, newName);
        if (data.error) {
            Logger.error(data.error);
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

        /** @type {import('./components/modal.js').Modal} */
        const modal = document.getElementById('delete-playlist-modal');
        modal.show();
    }

    async performDeletePlaylist() {
        const data = await usePlaylistService().delete(this.currentPlaylistId);
        if (data.error) {
            Logger.error(data.error);
            this.showToast('Failed to delete playlist', 'error');

            return;
        }

        /** @type {import('./components/modal.js').Modal} */
        const modal = document.getElementById('delete-playlist-modal');
        modal.hide();

        await this.loadPlaylists();
        this.switchToLibraryView();
        this.showToast('Playlist deleted', 'success');
    }

    async openPlaylist(playlistId) {
        const data = await usePlaylistService().fetch(playlistId);
        // FIXME: Show toast notification
        if (data.error) return Logger.error(data.error);

        const playlist = data.value;
        if (!playlist) return Logger.error('unreachable');

        useContext().set('current-view-type', 'playlist');
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

        // Disable playlist actions for "Liked Music"
        const isLiked = (playlist.name || '').toLowerCase() === 'liked music';
        const container = document.getElementById('playlist-menu-container');
        if(isLiked && container) {
            container?.classList.add('hidden');
        } else {
            container?.classList.remove('hidden');
        }
    }

    switchToLibraryView() {
        if (useContext().get('current-view-type') === 'library') return;

        useContext().set('current-view-type', 'library')
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

    /**
     * Refresh the player queue if we're currently playing a specific playlist
     * Called when songs are added/removed from a playlist
     * @param {number} playlistId - The playlist that was modified
     */
    async refreshPlayerQueueIfNeeded(playlistId) {
        try {
            // Early exit checks - be very defensive
            if (!window.player) return;
            if (!window.player.playbackContext) return;
            if (!playlistId) return;

            const context = window.player.playbackContext;
            // Only refresh if we're playing this specific playlist
            if (context.type !== 'playlist' || context.id !== playlistId) return;

            // Get current song to preserve position
            const currentSong = window.player.getCurrentSong();
            if (!currentSong) return;

            // Fetch the updated playlist
            const data = await usePlaylistService().fetch(playlistId);
            if (data.error || !data.value || !data.value.songs) return;

            const newQueue = data.value.songs;

            // Find current song in new queue
            const newIndex = newQueue.findIndex(s => s.id === currentSong.id);

            if (newIndex >= 0) {
                // Update the player's playlist while preserving current playback
                window.player.playlist = newQueue;
                window.player.currentIndex = newIndex;

                // Update fullscreen queue if visible
                if (window.player.fsQueueList) {
                    window.player.renderFullscreenQueue();
                }

                Logger.log('Player queue refreshed for playlist:', playlistId);
            } else {
                // Current song was removed - let it finish, queue will use new songs for next
                window.player.playlist = newQueue;
                // Reset index to 0 if current song no longer exists
                window.player.currentIndex = 0;
                Logger.log('Current song removed from playlist, queue updated');
            }
        } catch (e) {
            // Silently ignore errors - this is a non-critical operation
            Logger.warn('Failed to refresh player queue:', e);
        }
    }

    /**
     * Refresh the player queue when playing from library and library is reloaded
     * This updates the queue to include newly added songs
     */
    refreshLibraryQueue() {
        try {
            if (!window.player) return;
            if (!window.player.playbackContext) return;
            if (window.player.playbackContext.type !== 'library') return;

            // Get current song to preserve position
            const currentSong = window.player.getCurrentSong();
            if (!currentSong) return;

            // Use the updated library songs
            const newQueue = this.songs;
            if (!newQueue || !newQueue.length) return;

            // Find current song in new queue
            const newIndex = newQueue.findIndex(s => s.id === currentSong.id);

            if (newIndex >= 0) {
                // Update the player's playlist while preserving current playback
                window.player.playlist = newQueue;
                window.player.currentIndex = newIndex;

                // Update fullscreen queue if visible
                if (window.player.fsQueueList) {
                    window.player.renderFullscreenQueue();
                }

                Logger.log('Library queue refreshed, now contains', newQueue.length, 'songs');
            }
        } catch (e) {
            Logger.warn('Failed to refresh library queue:', e);
        }
    }

    /**
     * Restore playback state from localStorage
     * Called after library is loaded to resume last played song
     */
    async restorePlaybackState() {
        if (!window.player) return;

        const state = window.player.getStoredPlaybackState();
        if (!state || !state.songId) return;

        let queue = null;
        let hasOperations = false;

        // First, get the base queue based on context
        if (state.context && state.context.type === 'playlist' && state.context.id) {
            // Fetch the playlist to get its songs
            try {
                const data = await usePlaylistService().fetch(state.context.id);
                if (!data.error && data.value && data.value.songs) {
                    queue = [...data.value.songs]; // Clone to allow modifications
                }
            } catch (e) {
                Logger.warn('Failed to fetch playlist for restore:', e);
            }
        }

        // Fallback to library if playlist fetch failed or context is library
        if (!queue) {
            queue = [...this.songs]; // Clone to allow modifications
        }

        // Apply queue operations if they exist
        if (state.queueOperations && state.queueOperations.length > 0) {
            queue = this.applyQueueOperations(queue, state.queueOperations);
            if (queue) {
                hasOperations = true;
                window.player.queueModified = true;
                window.player.queueOperations = [...state.queueOperations]; // Restore operations
            }
        }
        // Legacy support: check for old queueSongIds format
        else if (state.queueSongIds && state.queueSongIds.length > 0) {
            queue = this.reconstructQueueFromIds(state.queueSongIds);
            if (queue && queue.length > 0) {
                window.player.queueModified = true;
            } else {
                queue = [...this.songs];
            }
        }
        // Legacy support: check for old modifiedQueue format
        else if (state.modifiedQueue && state.modifiedQueue.length > 0) {
            queue = state.modifiedQueue;
            window.player.queueModified = true;
        }

        if (!queue || !queue.length) {
            queue = [...this.songs];
        }

        // Validate that the song still exists in the queue
        const songExists = queue.some(s => s.id === state.songId);
        if (!songExists) {
            // Song no longer exists, clear the state
            window.player.clearPlaybackState();
            return;
        }

        // Restore the playback state (without auto-playing)
        window.player.restoreFromState(state, queue, false);

        Logger.log('Restored last played song:', state.songId, hasOperations ? `(with ${state.queueOperations.length} operations)` : '');
    }

    /**
     * Reconstruct a queue from an array of song IDs
     * @param {Array<number>} songIds - Array of song IDs
     * @returns {Array|null} - Array of song objects, or null if failed
     */
    reconstructQueueFromIds(songIds) {
        if (!songIds || !songIds.length) return null;
        if (!this.songs || !this.songs.length) return null;

        // Create a map for fast lookup
        const songMap = new Map();
        this.songs.forEach(s => songMap.set(s.id, s));

        // Reconstruct queue in the correct order
        const queue = [];
        for (const id of songIds) {
            const song = songMap.get(id);
            if (song) {
                queue.push(song);
            }
            // If song not found, skip it (may have been deleted)
        }

        return queue.length > 0 ? queue : null;
    }

    /**
     * Apply queue operations to a base queue to reconstruct the modified queue
     * @param {Array} baseQueue - The original queue (playlist or library songs)
     * @param {Array} operations - Array of operations to apply
     * @returns {Array|null} - The modified queue, or null if failed
     */
    applyQueueOperations(baseQueue, operations) {
        if (!baseQueue || !baseQueue.length) return null;
        if (!operations || !operations.length) return baseQueue;

        // Clone the base queue
        const queue = [...baseQueue];

        // Create a map for fast song lookup
        const songMap = new Map();
        this.songs.forEach(s => songMap.set(s.id, s));

        // Apply each operation in order
        for (const op of operations) {
            if (op.action === 'add') {
                const song = songMap.get(op.songId);
                if (song) {
                    // Insert at position (or end if position is out of bounds)
                    const pos = Math.min(op.position, queue.length);
                    queue.splice(pos, 0, song);
                }
            } else if (op.action === 'remove') {
                // Find and remove the song at approximately the right position
                // We search around the position since prior operations may have shifted indices
                const searchStart = Math.max(0, op.position - 5);
                const searchEnd = Math.min(queue.length, op.position + 5);

                for (let i = searchStart; i < searchEnd; i++) {
                    if (queue[i] && queue[i].id === op.songId) {
                        queue.splice(i, 1);
                        break;
                    }
                }
            } else if (op.action === 'move') {
                // Find the song (may have shifted from original position)
                const songIndex = queue.findIndex(s => s.id === op.songId);
                if (songIndex !== -1) {
                    const [song] = queue.splice(songIndex, 1);
                    // Adjust target position if needed
                    const targetPos = Math.min(op.toPosition, queue.length);
                    queue.splice(targetPos, 0, song);
                }
            }
        }

        return queue.length > 0 ? queue : null;
    }

    // User Settings & Theming Methods

    applyTheme(color) {
        if (!color) return;
        const root = document.documentElement;
        root.style.setProperty('--accent-primary', color);
        root.style.setProperty('--accent-secondary', color); // Simple fallback
        // Create a simple gradient
        root.style.setProperty('--accent-gradient', `linear-gradient(135deg, ${color} 0%, ${color} 100%)`);
        // Calculate glow (hex + opacity)
        root.style.setProperty('--accent-glow', `${color}4D`); // ~30% opacity
        // Calculate subtle bg (hex + opacity)
        root.style.setProperty('--accent-bg-subtle', `${color}14`); // ~8% opacity
    }

    applyThemeFromPreferences() {
        if (this.user && this.user.preferences) {
            let prefs = this.user.preferences;
            if (typeof prefs === 'string') {
                try {
                    prefs = JSON.parse(prefs);
                } catch (e) {
                    Logger.error('Failed to parse preferences', e);
                    return;
                }
            }
            if (prefs && prefs.theme_color) {
                this.applyTheme(prefs.theme_color);
            }
        }
    }

    // Discord-style Settings Page Methods
    openSettings(section = 'appearance') {
        const settingsPage = document.getElementById('settings-page');
        settingsPage?.classList.remove('hidden');

        // Update user profile in settings sidebar
        if (this.user) {
            const avatar = document.getElementById('settings-user-avatar');
            const username = document.getElementById('settings-username');
            const role = document.getElementById('settings-user-role');
            if (avatar) avatar.textContent = this.user.username?.charAt(0).toUpperCase() || 'U';
            if (username) username.textContent = this.user.username || 'User';
            if (role) role.textContent = this.user.role === 'sysadmin' ? 'Administrator' : 'User';

            // Show/hide server settings for sysadmin
            const serverCategory = document.getElementById('settings-nav-server-category');
            const libraryNav = document.getElementById('settings-nav-library');
            if (this.user.role === 'sysadmin') {
                serverCategory?.classList.remove('hidden');
                libraryNav?.classList.remove('hidden');
            } else {
                serverCategory?.classList.add('hidden');
                libraryNav?.classList.add('hidden');
            }
        }

        // Reset password form
        document.getElementById('change-password-form')?.reset();

        // Set current color in picker
        let currentColor = '#fa586a';
        let currentFsMode = 'standard';
        let swap = false;

        if (this.user && this.user.preferences) {
            let prefs = this.user.preferences;
            if (typeof prefs === 'string') {
                try {
                    prefs = JSON.parse(prefs);
                } catch (e) { }
            }
            if (prefs) {
                if (prefs.theme_color) currentColor = prefs.theme_color;
                if (prefs.fullscreen_mode) currentFsMode = prefs.fullscreen_mode;
                if (typeof prefs.fullscreen_swap_sides !== 'undefined') swap = !!prefs.fullscreen_swap_sides;
            }
        }

        // Set color picker
        const colorInput = document.getElementById('settings-accent-color');
        const colorValue = document.getElementById('settings-accent-color-value');
        if (colorInput) colorInput.value = currentColor;
        if (colorValue) colorValue.textContent = currentColor;

        // Set fullscreen mode radio buttons
        document.querySelectorAll('.settings-radio-item').forEach(item => {
            item.classList.toggle('selected', item.dataset.value === currentFsMode);
        });

        // Set swap toggle
        const fsSwapToggle = document.getElementById('settings-fullscreen-swap');
        if (fsSwapToggle) fsSwapToggle.checked = swap;

        // Load scan status if going to library section
        if (section === 'library') {
            this.loadScanStatus();
        }

        // Switch to the requested section
        this.switchSettingsSection(section);
    }

    closeSettings() {
        const settingsPage = document.getElementById('settings-page');
        if (settingsPage) {
            settingsPage.classList.add('closing');
            setTimeout(() => {
                settingsPage.classList.add('hidden');
                settingsPage.classList.remove('closing');
            }, 200);
        }
    }

    switchSettingsSection(sectionName) {
        // Update navigation active state
        document.querySelectorAll('.settings-nav-item').forEach(item => {
            item.classList.toggle('active', item.dataset.section === sectionName);
        });

        // Update title
        const titleMap = {
            'appearance': 'Appearance',
            'player': 'Player',
            'account': 'Account',
            'library': 'Library Scanning'
        };
        const title = document.getElementById('settings-page-title');
        if (title) title.textContent = titleMap[sectionName] || 'Settings';

        // Show/hide sections
        document.querySelectorAll('.settings-section').forEach(section => {
            section.classList.remove('active');
        });
        document.getElementById(`settings-section-${sectionName}`)?.classList.add('active');

        // Load scan status when switching to library section
        if (sectionName === 'library') {
            this.loadScanStatus();
        }
    }

    handleSettingsSearch(query) {
        const searchTerm = query.toLowerCase().trim();
        const navItems = document.querySelectorAll('.settings-nav-item');

        // Define searchable content for each section
        const sectionKeywords = {
            'appearance': ['appearance', 'theme', 'color', 'accent', 'color picker', 'preset', 'reset', 'style', 'look'],
            'player': ['player', 'fullscreen', 'mode', 'standard', 'modern', 'swap', 'queue', 'image', 'album art'],
            'account': ['account', 'password', 'change password', 'security', 'login', 'credentials'],
            'library': ['library', 'scanning', 'scan', 'quick scan', 'full scan', 'rescan', 'files', 'music', 'server']
        };

        if (!searchTerm) {
            // Reset - show all nav items and remove highlights
            navItems.forEach(item => {
                if (!item.classList.contains('sysadmin-only') ||
                    (this.user && this.user.role === 'sysadmin')) {
                    item.style.display = '';
                }
            });
            document.querySelectorAll('.settings-nav-category').forEach(cat => {
                if (!cat.classList.contains('sysadmin-only') ||
                    (this.user && this.user.role === 'sysadmin')) {
                    cat.style.display = '';
                }
            });
            // Remove any search highlights
            document.querySelectorAll('.settings-search-highlight').forEach(el => {
                el.classList.remove('settings-search-highlight');
            });
            return;
        }

        let firstMatch = null;
        let hasUserMatch = false;
        let hasServerMatch = false;

        // Filter nav items based on search
        navItems.forEach(item => {
            const section = item.dataset.section;
            const keywords = sectionKeywords[section] || [];
            const itemText = item.textContent.toLowerCase();

            const matches = keywords.some(kw => kw.includes(searchTerm)) ||
                itemText.includes(searchTerm);

            // Check if sysadmin-only section
            const isSysadminOnly = item.classList.contains('sysadmin-only');
            const canShow = !isSysadminOnly || (this.user && this.user.role === 'sysadmin');

            if (matches && canShow) {
                item.style.display = '';
                if (!firstMatch) firstMatch = section;
                if (section === 'library') {
                    hasServerMatch = true;
                } else {
                    hasUserMatch = true;
                }
            } else {
                item.style.display = 'none';
            }
        });

        // Show/hide category headers based on matches
        const userCategory = document.querySelector('.settings-nav-category:not(.sysadmin-only)');
        const serverCategory = document.getElementById('settings-nav-server-category');

        if (userCategory) userCategory.style.display = hasUserMatch ? '' : 'none';
        if (serverCategory && this.user?.role === 'sysadmin') {
            serverCategory.style.display = hasServerMatch ? '' : 'none';
        }

        // Navigate to first matching section
        if (firstMatch) {
            this.switchSettingsSection(firstMatch);
        }
    }

    // Legacy methods for backward compatibility
    openUserSettings() {
        this.openSettings('appearance');
    }

    closeUserSettings() {
        this.closeSettings();
    }

    switchSettingsTab(tabName) {
        this.switchSettingsSection(tabName);
    }

    async savePreferences(newPrefs) {
        // Merge with existing
        let currentPrefs = {};
        if (this.user) {
            if (this.user.preferences) {
                if (typeof this.user.preferences === 'string') {
                    try {
                        currentPrefs = JSON.parse(this.user.preferences);
                    } catch (e) { }
                } else {
                    currentPrefs = this.user.preferences;
                }
            }

            const updatedPrefs = { ...currentPrefs, ...newPrefs };

            // Update local user object immediately
            this.user.preferences = updatedPrefs;

            // Save to server
            await useAuthService().updatePreferences(updatedPrefs);
        }
    }
}
