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
import { useUsersService } from './services/users.js';
import * as AppView from "./view/app.js";
import * as LoginView from "./view/login.js";
import * as SetupView from "./view/setup.js";

const DEFAULT_COVER_BASE64 = `data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHZpZXdCb3g9JzAgMCAyNCAyNCcgZmlsbD0nIzZlNmU2ZSc+PHBhdGggZD0nTTEyIDN2MTAuNTVjLS41OS0uMzQtMS4yNy0uNTUtMi0uNTUtMi4yMSAwLTQgMS43OS00IDRzMS43OSA0IDQgNCA0LTEuNzkgNC00VjdoNFYzaC02eicvPjwvc3ZnPg==`;

const getInitials = (name) => {
    const parts = name.split(' ').filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

const getGradientForName = (name) => {
    const colors = [
        ['#ec4899', '#8b5cf6'], // pink to purple
        ['#3b82f6', '#10b981'], // blue to emerald
        ['#f59e0b', '#ef4444'], // amber to red
        ['#6366f1', '#a855f7'], // indigo to purple
        ['#14b8a6', '#06b6d4'], // teal to cyan
        ['#f43f5e', '#ec4899'], // rose to pink
        ['#06b6d4', '#3b82f6'], // cyan to blue
    ];
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const index = Math.abs(hash) % colors.length;
    return colors[index];
};

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
                const createGroup = document.getElementById('users-create-group');
                if (createGroup && !createGroup.classList.contains('hidden')) {
                    this.setCreateUserFormOpen(false);
                    return;
                }

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

        // Radio button groups (Fullscreen Mode, Lyrics Effect, …)
        document.querySelectorAll('.settings-radio-item').forEach(item => {
            item.addEventListener('click', () => {
                const group = item.closest('.settings-radio-group');
                group.querySelectorAll('.settings-radio-item').forEach(i => i.classList.remove('selected'));
                item.classList.add('selected');
                const pref = group.dataset.pref || 'fullscreen_mode';
                const value = item.dataset.value;
                this.savePreferences({ [pref]: value });
                if (pref === 'lyrics_effect') {
                    this._updateLyricsAudioSyncState(value);
                    if (window.player) window.player.setLyricsEffect(value);
                }
            });
        });

        document.getElementById('settings-fullscreen-swap')?.addEventListener('change', (e) => {
            this.savePreferences({ fullscreen_swap_sides: e.target.checked });
        });

        document.getElementById('settings-lyrics-audio-sync')?.addEventListener('change', (e) => {
            this.savePreferences({ lyrics_audio_sync: e.target.checked });
            if (window.player) window.player.setLyricsAudioSync(e.target.checked);
        });

        document.getElementById('settings-disable-lasers')?.addEventListener('change', (e) => {
            this.savePreferences({ disable_lasers: e.target.checked });
        });

        document.getElementById('settings-show-bg-blur')?.addEventListener('change', (e) => {
            this.savePreferences({ show_bg_blur: e.target.checked });
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

        // Create User (admin)
        document.getElementById('create-user-form')?.addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleCreateUser();
        });

        // Toggle the Add User panel
        document.getElementById('add-user-toggle-btn')?.addEventListener('click', () => {
            const group = document.getElementById('users-create-group');
            this.setCreateUserFormOpen(group.classList.contains('hidden'));
        });

        document.getElementById('cancel-create-user')?.addEventListener('click', () => {
            this.setCreateUserFormOpen(false);
        });

        // Reset User Password modal
        document.getElementById('close-reset-user-password-modal')?.addEventListener('click', () => {
            document.getElementById('reset-user-password-modal').classList.add('hidden');
        });
        document.getElementById('cancel-reset-user-password')?.addEventListener('click', () => {
            document.getElementById('reset-user-password-modal').classList.add('hidden');
        });
        document.getElementById('confirm-reset-user-password')?.addEventListener('click', () => {
            this.performResetUserPassword();
        });

        // Delete User modal
        document.getElementById('close-delete-user-modal')?.addEventListener('click', () => {
            document.getElementById('delete-user-modal').classList.add('hidden');
        });
        document.getElementById('cancel-delete-user')?.addEventListener('click', () => {
            document.getElementById('delete-user-modal').classList.add('hidden');
        });
        document.getElementById('confirm-delete-user')?.addEventListener('click', () => {
            this.performDeleteUser();
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

        document.getElementById('scrape-artists-btn')?.addEventListener('click', () => {
            this.runScrapeArtists();
        });

        document.getElementById('scrape-descriptions-btn')?.addEventListener('click', () => {
            this.runScrapeDescriptions();
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

        // Playlist Settings action download
        document.getElementById('action-download-playlist')?.addEventListener('click', () => {
            document.getElementById('playlist-settings-dropdown').classList.add('hidden');
            if (this.currentPlaylistId) {
                window.location.href = `/api/playlists/${this.currentPlaylistId}/download`;
            }
        });

        // Discover Music click
        document.getElementById('nav-discover')?.addEventListener('click', (e) => {
            e.preventDefault();
            this.switchToDiscoverView();
        });

        // Artists click
        document.getElementById('nav-artists')?.addEventListener('click', (e) => {
            e.preventDefault();
            this.switchToArtistsView();
        });

        // Global song artist link click delegation
        document.addEventListener('click', (e) => {
            const artistLink = e.target.closest('.song-artist-link');
            if (artistLink) {
                e.preventDefault();
                e.stopPropagation();
                const artistName = artistLink.dataset.artist;
                this.switchToArtistsView(artistName);
            }
        });

        this.initDiscoverView();
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

    async runScrapeArtists() {
        const btn = document.getElementById('scrape-artists-btn');
        const progress = document.getElementById('scrape-artists-progress');
        const progressBar = document.getElementById('scrape-artists-progress-bar');
        const progressText = document.getElementById('scrape-artists-progress-text');
        const result = document.getElementById('scrape-artists-result');

        btn.disabled = true;
        btn.textContent = 'Running...';
        progress?.classList.remove('hidden');
        result?.classList.add('hidden');
        progressBar.style.width = '0%';
        progressText.textContent = 'Starting...';

        try {
            const res = await fetch('/api/music/artists/scrape-all', { method: 'POST' });
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });

                const lines = buffer.split('\n');
                buffer = lines.pop();

                for (const line of lines) {
                    if (!line.trim()) continue;
                    const msg = JSON.parse(line);

                    if (msg.type === 'start') {
                        progressText.textContent = msg.total === 0
                            ? 'All artists already have images!'
                            : `Scraping 0 / ${msg.total} artists...`;
                    } else if (msg.type === 'progress') {
                        const pct = Math.round((msg.current / msg.total) * 100);
                        progressBar.style.width = `${pct}%`;
                        progressText.textContent = `Scraping ${msg.current} / ${msg.total} — ${msg.artist}`;
                    } else if (msg.type === 'done') {
                        progress?.classList.add('hidden');
                        document.getElementById('scrape-artists-scraped').textContent = msg.scraped;
                        document.getElementById('scrape-artists-skipped').textContent = msg.skipped;
                        document.getElementById('scrape-artists-failed').textContent = msg.failed;
                        result?.classList.remove('hidden');
                        this.showToast(`Scraped ${msg.scraped} artist image${msg.scraped === 1 ? '' : 's'}`, 'success');
                    } else if (msg.type === 'error') {
                        progressText.textContent = 'Error: ' + msg.error;
                        this.showToast('Scrape failed: ' + msg.error, 'error');
                    }
                }
            }
        } catch (e) {
            progressText.textContent = 'Error: ' + e.message;
            this.showToast('Scrape failed: ' + e.message, 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Run';
        }
    }

    async runScrapeDescriptions() {
        const btn = document.getElementById('scrape-descriptions-btn');
        const progress = document.getElementById('scrape-descriptions-progress');
        const progressBar = document.getElementById('scrape-descriptions-progress-bar');
        const progressText = document.getElementById('scrape-descriptions-progress-text');
        const result = document.getElementById('scrape-descriptions-result');

        btn.disabled = true;
        btn.textContent = 'Running...';
        progress?.classList.remove('hidden');
        result?.classList.add('hidden');
        progressBar.style.width = '0%';
        progressText.textContent = 'Starting...';

        try {
            const res = await fetch('/api/music/artists/scrape-descriptions', { method: 'POST' });
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });

                const lines = buffer.split('\n');
                buffer = lines.pop();

                for (const line of lines) {
                    if (!line.trim()) continue;
                    const msg = JSON.parse(line);

                    if (msg.type === 'start') {
                        progressText.textContent = msg.total === 0
                            ? 'All artists already have descriptions!'
                            : `Scraping 0 / ${msg.total} artists...`;
                    } else if (msg.type === 'progress') {
                        const pct = Math.round((msg.current / msg.total) * 100);
                        progressBar.style.width = `${pct}%`;
                        progressText.textContent = `Scraping ${msg.current} / ${msg.total} — ${msg.artist}`;
                    } else if (msg.type === 'done') {
                        progress?.classList.add('hidden');
                        document.getElementById('scrape-descriptions-scraped').textContent = msg.scraped;
                        document.getElementById('scrape-descriptions-skipped').textContent = msg.skipped;
                        document.getElementById('scrape-descriptions-failed').textContent = msg.failed;
                        result?.classList.remove('hidden');
                        this.showToast(`Scraped ${msg.scraped} artist bio${msg.scraped === 1 ? '' : 's'}`, 'success');
                    } else if (msg.type === 'error') {
                        progressText.textContent = 'Error: ' + msg.error;
                        this.showToast('Scrape failed: ' + msg.error, 'error');
                    }
                }
            }
        } catch (e) {
            progressText.textContent = 'Error: ' + e.message;
            this.showToast('Scrape failed: ' + e.message, 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Run';
        }
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
        if (useContext().get('current-view-type') === 'discover') {
            return;
        }

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
                if (e.target.closest('.song-artist-link')) return;
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

        this.bindRightClickEvents(songsGrid);
    }

    bindRightClickEvents(container) {
        if (!container) return;

        container.addEventListener('contextmenu', (e) => {
            const songElement = e.target.closest('.song-card, .song-card-horizontal, .song-row, .artist-track-row');
            if (!songElement) return;

            if (e.target.closest('.song-menu-btn')) return;

            e.preventDefault();

            const menuBtn = songElement.querySelector('.song-menu-btn');
            const songData = menuBtn ? menuBtn.dataset : {
                songId: songElement.dataset.id,
                songTitle: songElement.querySelector('.song-title, .track-title')?.textContent || '',
                songArtist: songElement.querySelector('.song-artist, .track-artists')?.textContent || ''
            };

            this.showContextMenu(e, songData);
        });
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

        this.bindRightClickEvents(songsGrid);
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
                // Don't play if clicking menu button or artist links
                if (e.target.closest('.song-menu-btn')) return;
                if (e.target.closest('.song-artist-link')) return;
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

        this.bindRightClickEvents(listContent);
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
        const artistSet = new Set();
        songs.forEach(song => {
            const rawArtist = song.artist || 'Unknown Artist';
            rawArtist.split(',').forEach(part => {
                const trimmed = part.trim();
                if (trimmed) artistSet.add(trimmed);
            });
        });
        const artists = artistSet.size;
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

        // Hide other views and reset
        document.getElementById('discover-view')?.classList.add('hidden');
        document.getElementById('artists-view')?.classList.add('hidden');
        document.querySelector('.view-toggle')?.classList.remove('hidden');
        
        // Show section header
        document.querySelector('.section-header')?.classList.remove('hidden');

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

        // Hide other views and reset
        document.getElementById('discover-view')?.classList.add('hidden');
        document.getElementById('artists-view')?.classList.add('hidden');
        document.querySelector('.view-toggle')?.classList.remove('hidden');
        
        // Show section header
        document.querySelector('.section-header')?.classList.remove('hidden');

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

    switchToDiscoverView(query = null) {
        // Pause discover audio preview if it exists
        const previewAudio = document.getElementById('discover-preview-audio');
        if (previewAudio) {
            previewAudio.pause();
            previewAudio.src = '';
            document.getElementById('discover-preview-bar')?.classList.add('hidden');
        }

        useContext().set('current-view-type', 'discover');
        this.currentPlaylistId = null;

        // Update Sidebar UI
        document.querySelectorAll('.app-sidebar .nav-item').forEach(el => el.classList.remove('active'));
        document.getElementById('nav-discover')?.classList.add('active');
        this.renderSidebarPlaylists();

        // Update Header
        document.querySelector('.section-title').textContent = 'Discover Music';
        document.getElementById('library-subtitle').textContent = 'Search and preview from YouTube Music';

        // Hide elements
        document.getElementById('playlist-menu-container').classList.add('hidden');
        document.getElementById('library-stats').classList.add('hidden');
        document.querySelector('.view-toggle')?.classList.add('hidden');
        document.getElementById('songs-grid').classList.add('hidden');
        document.getElementById('songs-list').classList.add('hidden');
        document.getElementById('empty-state').classList.add('hidden');
        document.getElementById('loading-state').classList.add('hidden');
        document.getElementById('artists-view')?.classList.add('hidden');

        // Show section header
        document.querySelector('.section-header')?.classList.remove('hidden');

        document.getElementById('discover-view').classList.remove('hidden');

        if (query) {
            const searchInput = document.getElementById('discover-search-input');
            if (searchInput) {
                searchInput.value = query;
                document.getElementById('discover-search-btn')?.click();
            }
        }
    }

    initDiscoverView() {
        const searchInput = document.getElementById('discover-search-input');
        const searchBtn = document.getElementById('discover-search-btn');
        const loading = document.getElementById('discover-loading');
        const empty = document.getElementById('discover-empty');
        const resultsList = document.getElementById('discover-results');

        // Preview Bar Elements
        const previewBar = document.getElementById('discover-preview-bar');
        const previewCover = document.getElementById('preview-cover');
        const previewTitle = document.getElementById('preview-title');
        const previewArtist = document.getElementById('preview-artist');
        const previewPlayBtn = document.getElementById('preview-play-btn');
        const previewCurrentTime = document.getElementById('preview-current-time');
        const previewDuration = document.getElementById('preview-duration');
        const previewProgressBar = document.getElementById('preview-progress-bar');
        const previewProgressFill = document.getElementById('preview-progress-fill');
        const previewCloseBtn = document.getElementById('preview-close-btn');
        const previewAudio = document.getElementById('discover-preview-audio');

        const performSearch = async () => {
            const query = searchInput.value.trim();
            if (!query) return;

            resultsList.innerHTML = '';
            empty.classList.add('hidden');
            loading.classList.remove('hidden');

            const data = await useMusicService().discover.search(query);
            loading.classList.add('hidden');

            if (data.error) {
                Logger.error(data.error);
                this.showToast('Search failed: ' + (data.error.error || 'Unknown error'), 'error');
                return;
            }

            const results = data.value || [];
            if (results.length === 0) {
                empty.classList.remove('hidden');
                return;
            }

            results.forEach(song => {
                const item = document.createElement('div');
                const matchedLibrarySong = this.isSongInLibrary(song);
                const alreadyDownloaded = matchedLibrarySong !== null;
                item.className = alreadyDownloaded ? 'discover-item in-library' : 'discover-item';
                
                const info = document.createElement('div');
                info.className = 'discover-item-info';

                const cover = document.createElement('img');
                cover.className = 'discover-item-cover';
                cover.referrerPolicy = 'no-referrer';
                cover.onerror = () => {
                    cover.onerror = null;
                    cover.src = DEFAULT_COVER_BASE64;
                };
                cover.src = song.cover_url || DEFAULT_COVER_BASE64;

                const meta = document.createElement('div');
                meta.className = 'discover-item-meta';

                const title = document.createElement('span');
                title.className = 'discover-item-title';
                title.textContent = song.title;

                const artistAlbum = document.createElement('span');
                artistAlbum.className = 'discover-item-artist-album';
                
                const artistSpan = document.createElement('span');
                artistSpan.className = 'discover-clickable-artist';
                artistSpan.textContent = song.artist;
                artistSpan.addEventListener('click', (e) => {
                    e.stopPropagation();
                    searchInput.value = song.artist;
                    performSearch();
                });
                
                artistAlbum.appendChild(artistSpan);
                artistAlbum.appendChild(document.createTextNode(` • ${song.album || 'Single'}`));

                meta.appendChild(title);
                meta.appendChild(artistAlbum);
                info.appendChild(cover);
                info.appendChild(meta);

                const actions = document.createElement('div');
                actions.className = 'discover-item-actions';

                const duration = document.createElement('span');
                duration.className = 'discover-item-duration';
                duration.textContent = song.duration_text || Utils.formatDuration(song.duration);

                const previewBtn = document.createElement('button');
                previewBtn.className = 'discover-btn discover-btn-preview';
                previewBtn.textContent = alreadyDownloaded ? 'Play' : 'Preview';
                previewBtn.addEventListener('click', () => {
                    const currentMatch = this.isSongInLibrary(song);
                    if (currentMatch) {
                        // Play local song in main player
                        if (window.player) {
                            if (previewAudio && !previewAudio.paused) {
                                previewAudio.pause();
                                previewAudio.src = '';
                                previewBar.classList.add('hidden');
                            }
                            window.player.playSong(0, [currentMatch], { type: 'library', id: 'library' });
                        }
                    } else {
                        this.playDiscoverPreview(song);
                    }
                });

                const downloadBtn = document.createElement('button');
                downloadBtn.className = 'discover-btn discover-btn-download';
                if (alreadyDownloaded) {
                    downloadBtn.textContent = 'In Library';
                    downloadBtn.disabled = true;
                } else {
                    downloadBtn.textContent = 'Download';
                }
                downloadBtn.addEventListener('click', () => {
                    this.downloadDiscoverSong(song, downloadBtn);
                });

                actions.appendChild(duration);
                actions.appendChild(previewBtn);
                actions.appendChild(downloadBtn);

                item.appendChild(info);
                item.appendChild(actions);

                resultsList.appendChild(item);
            });
        };

        searchBtn?.addEventListener('click', performSearch);
        searchInput?.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') performSearch();
        });

        // Preview Player audio handlers
        if (previewAudio) {
            previewAudio.addEventListener('timeupdate', () => {
                const cur = previewAudio.currentTime;
                const dur = previewAudio.duration || 0;
                previewCurrentTime.textContent = Utils.formatDuration(cur);
                if (dur > 0) {
                    previewProgressFill.style.width = `${(cur / dur) * 100}%`;
                }
            });

            previewAudio.addEventListener('loadedmetadata', () => {
                previewDuration.textContent = Utils.formatDuration(previewAudio.duration);
            });

            previewAudio.addEventListener('ended', () => {
                previewPlayBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
            });
        }

        previewPlayBtn?.addEventListener('click', () => {
            if (previewAudio.paused) {
                // Pause main player if playing
                if (window.player && !window.player.audio.paused) {
                    window.player.audio.pause();
                    window.player.updatePlayButton();
                }
                previewAudio.play();
                previewPlayBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
            } else {
                previewAudio.pause();
                previewPlayBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
            }
        });

        previewProgressBar?.addEventListener('click', (e) => {
            const rect = previewProgressBar.getBoundingClientRect();
            const pos = (e.clientX - rect.left) / rect.width;
            if (previewAudio.duration) {
                previewAudio.currentTime = pos * previewAudio.duration;
            }
        });

        previewCloseBtn?.addEventListener('click', () => {
            previewAudio.pause();
            previewAudio.src = '';
            previewBar.classList.add('hidden');
        });
    }

    async playDiscoverPreview(song) {
        const previewBar = document.getElementById('discover-preview-bar');
        const previewCover = document.getElementById('preview-cover');
        const previewTitle = document.getElementById('preview-title');
        const previewArtist = document.getElementById('preview-artist');
        const previewPlayBtn = document.getElementById('preview-play-btn');
        const previewAudio = document.getElementById('discover-preview-audio');

        if (!previewBar || !previewAudio) return;

        // Set metadata
        previewTitle.textContent = song.title;
        previewArtist.textContent = song.artist;
        previewCover.referrerPolicy = 'no-referrer';
        previewCover.onerror = () => {
            previewCover.onerror = null;
            previewCover.src = DEFAULT_COVER_BASE64;
        };
        previewCover.src = song.cover_url || DEFAULT_COVER_BASE64;

        previewBar.classList.remove('hidden');
        previewPlayBtn.innerHTML = '<svg class="spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-dasharray="40 40" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></circle></svg>';
        
        // Pause main player
        if (window.player && !window.player.audio.paused) {
            window.player.audio.pause();
            window.player.updatePlayButton();
        }

        previewAudio.src = `/api/music/discover/preview/${song.videoId}`;
        previewAudio.play().then(() => {
            previewPlayBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
        }).catch(err => {
            Logger.error(err);
            previewPlayBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
        });
    }

    isSongInLibrary(discoverSong) {
        if (!this.librarySongs || this.librarySongs.length === 0) return null;
        
        const normalize = (str) => {
            if (!str) return '';
            return str.toLowerCase().replace(/[^a-z0-9]/g, '');
        };
        
        const discTitle = normalize(discoverSong.title);
        const discArtist = normalize(discoverSong.artist);
        
        return this.librarySongs.find(libSong => {
            const libTitle = normalize(libSong.title);
            const libArtist = normalize(libSong.artist);
            
            if (libTitle === discTitle) {
                if (libArtist === discArtist || libArtist.includes(discArtist) || discArtist.includes(libArtist)) {
                    return true;
                }
            }
            return false;
        }) || null;
    }

    async downloadDiscoverSong(song, btn) {
        btn.disabled = true;
        btn.textContent = 'Downloading...';
        this.showToast(`Starting download: "${song.title}"`, 'info');

        const youtubeUrl = `https://www.youtube.com/watch?v=${song.videoId}`;
        const data = await useMusicService().YouTube.import(youtubeUrl);

        if (data.error) {
            btn.disabled = false;
            btn.textContent = 'Download';
            Logger.error(data.error);
            this.showToast('Download failed: ' + (data.error.error || 'Unknown error'), 'error');
            return;
        }

        const result = data.value;
        if (result?.success) {
            if (result.already_exists) {
                this.showToast(result.message || `"${song.title}" already exists in library`, 'info');
            } else {
                this.showToast(`Downloaded: "${song.title}" successfully!`, 'success');
            }
            btn.disabled = true;
            btn.textContent = 'In Library';
            const item = btn.closest('.discover-item');
            if (item) {
                item.classList.add('in-library');
                const previewBtn = item.querySelector('.discover-btn-preview');
                if (previewBtn) {
                    previewBtn.textContent = 'Play';
                }
            }
            
            // Reload library in background silently to update the local cache
            const libraryData = await useMusicService().library();
            if (libraryData && libraryData.value && libraryData.value.all_songs) {
                this.librarySongs = [...libraryData.value.all_songs];
            }
        } else {
            btn.disabled = false;
            btn.textContent = 'Download';
            this.showToast('Download failed: ' + (result?.message || 'unknown error'), 'error');
        }
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
            const jobsNav = document.getElementById('settings-nav-jobs');
            const usersNav = document.getElementById('settings-nav-users');
            if (this.user.role === 'sysadmin') {
                serverCategory?.classList.remove('hidden');
                libraryNav?.classList.remove('hidden');
                jobsNav?.classList.remove('hidden');
                usersNav?.classList.remove('hidden');
            } else {
                serverCategory?.classList.add('hidden');
                libraryNav?.classList.add('hidden');
                jobsNav?.classList.add('hidden');
                usersNav?.classList.add('hidden');
            }
        }

        // Reset password form
        document.getElementById('change-password-form')?.reset();

        // Set current color in picker
        let currentColor = '#fa586a';
        let currentFsMode = 'standard';
        let currentLyricsEffect = 'default';
        let swap = false;
        let disableLasers = false;
        let showBgBlur = false;
        let lyricsAudioSync = false;

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
                if (prefs.lyrics_effect) currentLyricsEffect = prefs.lyrics_effect;
                if (typeof prefs.fullscreen_swap_sides !== 'undefined') swap = !!prefs.fullscreen_swap_sides;
                if (typeof prefs.disable_lasers !== 'undefined') disableLasers = !!prefs.disable_lasers;
                if (typeof prefs.show_bg_blur !== 'undefined') showBgBlur = !!prefs.show_bg_blur;
                if (typeof prefs.lyrics_audio_sync !== 'undefined') lyricsAudioSync = !!prefs.lyrics_audio_sync;
            }
        }

        // Set color picker
        const colorInput = document.getElementById('settings-accent-color');
        const colorValue = document.getElementById('settings-accent-color-value');
        if (colorInput) colorInput.value = currentColor;
        if (colorValue) colorValue.textContent = currentColor;

        // Set radio button groups to their saved values
        const radioValues = { fullscreen_mode: currentFsMode, lyrics_effect: currentLyricsEffect };
        document.querySelectorAll('.settings-radio-group').forEach(group => {
            const pref = group.dataset.pref;
            const current = radioValues[pref];
            if (current == null) return;
            group.querySelectorAll('.settings-radio-item').forEach(item => {
                item.classList.toggle('selected', item.dataset.value === current);
            });
        });

        // Set swap toggle
        const fsSwapToggle = document.getElementById('settings-fullscreen-swap');
        if (fsSwapToggle) fsSwapToggle.checked = swap;

        // Set lyrics audio-sync toggle + availability (only for Word by word)
        const lyricsAudioSyncToggle = document.getElementById('settings-lyrics-audio-sync');
        if (lyricsAudioSyncToggle) lyricsAudioSyncToggle.checked = lyricsAudioSync;
        this._updateLyricsAudioSyncState(currentLyricsEffect);

        // Set show animation toggles
        const disableLasersToggle = document.getElementById('settings-disable-lasers');
        if (disableLasersToggle) disableLasersToggle.checked = disableLasers;

        const showBgBlurToggle = document.getElementById('settings-show-bg-blur');
        if (showBgBlurToggle) showBgBlurToggle.checked = showBgBlur;

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

    _updateLyricsAudioSyncState(effect) {
        const row = document.getElementById('lyrics-audio-sync-row');
        const cb = document.getElementById('settings-lyrics-audio-sync');
        if (!row || !cb) return;
        const available = effect === 'word';
        row.classList.toggle('is-disabled', !available);
        cb.disabled = !available;
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
            'library': 'Library Scanning',
            'jobs': 'Jobs',
            'users': 'Users'
        };
        const title = document.getElementById('settings-page-title');
        if (title) title.textContent = titleMap[sectionName] || 'Settings';

        // Show/hide sections
        document.querySelectorAll('.settings-section').forEach(section => {
            section.classList.remove('active');
        });
        document.getElementById(`settings-section-${sectionName}`)?.classList.add('active');

        // Allow data-heavy / multi-column sections to use the full content width
        const settingsContent = document.querySelector('.settings-content');
        if (settingsContent) {
            settingsContent.classList.toggle('settings-content-wide',
                sectionName === 'users' || sectionName === 'player');
        }

        // Load scan status when switching to library section
        if (sectionName === 'library') {
            this.loadScanStatus();
        }

        // Load users when switching to users section
        if (sectionName === 'users') {
            this.setCreateUserFormOpen(false);
            this.loadUsers();
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
            'library': ['library', 'scanning', 'scan', 'quick scan', 'full scan', 'rescan', 'files', 'music', 'server'],
            'jobs': ['jobs', 'scrape', 'artist images', 'background', 'task', 'batch', 'metadata'],
            'users': ['users', 'accounts', 'create user', 'manage users', 'admin', 'role', 'password reset', 'server']
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

    // ==================== User Management (Admin) ====================

    async loadUsers() {
        const list = document.getElementById('user-list');
        if (!list) return;

        const data = await useUsersService().all();
        if (data.error) {
            Logger.error(data.error);
            list.innerHTML = '<div class="user-list-empty">Failed to load users</div>';
            return;
        }

        this.renderUsers(data.value || []);
    }

    renderUsers(users) {
        const list = document.getElementById('user-list');
        if (!list) return;

        const countBadge = document.getElementById('user-count');
        if (countBadge) countBadge.textContent = String(users.length);

        if (!users.length) {
            list.innerHTML = '<div class="user-list-empty">No users yet. Click “Add User” to create the first account.</div>';
            return;
        }

        const currentUserId = this.user?.id;

        const shieldPath = 'M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z';
        const keyPath = 'M12.65 10C11.83 7.67 9.61 6 7 6c-3.31 0-6 2.69-6 6s2.69 6 6 6c2.61 0 4.83-1.67 5.65-4H17v4h4v-4h2v-4H12.65zM7 14c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z';
        const trashPath = 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z';

        list.innerHTML = users.map(user => {
            const initial = Utils.escapeHtml((user.username || '?').charAt(0).toUpperCase());
            const isAdmin = user.role === 'sysadmin';
            const isSelf = user.id === currentUserId;
            const roleTitle = isAdmin ? 'Make user' : 'Make administrator';

            return `
                <div class="user-list-item" data-id="${user.id}">
                    <div class="user-list-avatar">${initial}</div>
                    <div class="user-list-info">
                        <div class="user-list-name">
                            <span class="user-list-name-text">${Utils.escapeHtml(user.username)}</span>
                            ${isSelf ? '<span class="user-role-badge you">You</span>' : ''}
                            <span class="user-role-badge ${isAdmin ? 'admin' : ''}">${isAdmin ? 'Admin' : 'User'}</span>
                        </div>
                        <div class="user-list-email" title="${Utils.escapeHtml(user.email)}">${Utils.escapeHtml(user.email)}</div>
                    </div>
                    <div class="user-list-actions">
                        <button class="icon-btn-small user-role-toggle ${isAdmin ? 'active-admin' : ''}" data-id="${user.id}" data-role="${user.role}" title="${roleTitle}" aria-label="${roleTitle}">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="${shieldPath}"/></svg>
                        </button>
                        <button class="icon-btn-small user-reset-password" data-id="${user.id}" data-username="${Utils.escapeHtml(user.username)}" title="Reset password" aria-label="Reset password">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="${keyPath}"/></svg>
                        </button>
                        <button class="icon-btn-small user-action-delete user-delete" data-id="${user.id}" data-username="${Utils.escapeHtml(user.username)}" title="${isSelf ? 'You cannot delete yourself' : 'Delete user'}" aria-label="Delete user" ${isSelf ? 'disabled' : ''}>
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="${trashPath}"/></svg>
                        </button>
                    </div>
                </div>
            `;
        }).join('');

        list.querySelectorAll('.user-role-toggle').forEach(btn => {
            btn.addEventListener('click', () => this.handleToggleUserRole(btn.dataset.id, btn.dataset.role));
        });

        list.querySelectorAll('.user-reset-password').forEach(btn => {
            btn.addEventListener('click', () => this.openResetUserPasswordModal(btn.dataset.id, btn.dataset.username));
        });

        list.querySelectorAll('.user-delete').forEach(btn => {
            btn.addEventListener('click', () => this.openDeleteUserModal(btn.dataset.id, btn.dataset.username));
        });
    }

    setCreateUserFormOpen(open) {
        const layout = document.getElementById('users-layout');
        const group = document.getElementById('users-create-group');
        const btn = document.getElementById('add-user-toggle-btn');
        if (!layout || !group || !btn) return;

        group.classList.toggle('hidden', !open);
        layout.classList.toggle('users-layout--with-form', open);

        const label = btn.querySelector('.add-user-btn-label');
        const iconPath = btn.querySelector('svg path');
        if (open) {
            if (label) label.textContent = 'Cancel';
            if (iconPath) iconPath.setAttribute('d', 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z');
            setTimeout(() => document.getElementById('new-user-username')?.focus(), 50);
        } else {
            if (label) label.textContent = 'Add User';
            if (iconPath) iconPath.setAttribute('d', 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z');
        }
    }

    async handleCreateUser() {
        const username = document.getElementById('new-user-username').value.trim();
        const email = document.getElementById('new-user-email').value.trim();
        const password = document.getElementById('new-user-password').value;
        const role = document.getElementById('new-user-role').value;

        const data = await useUsersService().create(username, email, password, role);
        if (data.error) {
            this.showToast(data.error.error || 'Failed to create user', 'error');
            return;
        }

        this.showToast(`User "${username}" created`, 'success');
        document.getElementById('create-user-form').reset();
        this.setCreateUserFormOpen(false);
        await this.loadUsers();
    }

    async handleToggleUserRole(userId, currentRole) {
        const newRole = currentRole === 'sysadmin' ? 'user' : 'sysadmin';

        const data = await useUsersService().updateRole(userId, newRole);
        if (data.error) {
            this.showToast(data.error.error || 'Failed to update role', 'error');
            return;
        }

        this.showToast('Role updated', 'success');
        await this.loadUsers();
    }

    openResetUserPasswordModal(userId, username) {
        this._resetPasswordUserId = userId;
        document.getElementById('reset-user-password-target').textContent = `Set a new password for ${username}`;
        document.getElementById('reset-user-password-input').value = '';
        document.getElementById('reset-user-password-modal').classList.remove('hidden');
    }

    async performResetUserPassword() {
        const password = document.getElementById('reset-user-password-input').value;

        const data = await useUsersService().resetPassword(this._resetPasswordUserId, password);
        if (data.error) {
            this.showToast(data.error.error || 'Failed to reset password', 'error');
            return;
        }

        this.showToast('Password reset successfully', 'success');
        document.getElementById('reset-user-password-modal').classList.add('hidden');
    }

    openDeleteUserModal(userId, username) {
        this._deleteUserId = userId;
        document.getElementById('delete-user-target').textContent =
            `Are you sure you want to delete "${username}"? This action cannot be undone.`;
        document.getElementById('delete-user-modal').classList.remove('hidden');
    }

    async performDeleteUser() {
        const data = await useUsersService().remove(this._deleteUserId);
        if (data.error) {
            this.showToast(data.error.error || 'Failed to delete user', 'error');
            return;
        }

        this.showToast('User deleted', 'success');
        document.getElementById('delete-user-modal').classList.add('hidden');
        await this.loadUsers();
    }

    switchToArtistsView(targetArtistName = null) {
        // Pause discover audio preview if it exists
        const previewAudio = document.getElementById('discover-preview-audio');
        if (previewAudio) {
            previewAudio.pause();
            previewAudio.src = '';
            document.getElementById('discover-preview-bar')?.classList.add('hidden');
        }

        useContext().set('current-view-type', 'artists');
        this.currentPlaylistId = null;

        // Update Sidebar UI
        document.querySelectorAll('.app-sidebar .nav-item').forEach(el => el.classList.remove('active'));
        document.getElementById('nav-artists')?.classList.add('active');
        this.renderSidebarPlaylists();

        // Update Header
        document.querySelector('.section-title').textContent = 'Artists';
        document.getElementById('library-subtitle').textContent = 'Browse your music by artist';

        // Hide elements
        document.getElementById('playlist-menu-container').classList.add('hidden');
        document.getElementById('library-stats').classList.add('hidden');
        document.querySelector('.view-toggle')?.classList.add('hidden');
        document.getElementById('songs-grid').classList.add('hidden');
        document.getElementById('songs-list').classList.add('hidden');
        document.getElementById('empty-state').classList.add('hidden');
        document.getElementById('loading-state').classList.add('hidden');
        document.getElementById('discover-view').classList.add('hidden');

        // Show or hide shared section header
        if (targetArtistName) {
            document.querySelector('.section-header')?.classList.add('hidden');
        } else {
            document.querySelector('.section-header')?.classList.remove('hidden');
        }

        // Show Artists view
        const artistsView = document.getElementById('artists-view');
        artistsView.classList.remove('hidden');

        // Index and render artists
        this.renderArtistsView(targetArtistName);
    }

    renderArtistsView(targetArtistName = null) {
        const gridView = document.getElementById('artists-grid-view');
        const profileView = document.getElementById('artist-profile-view');
        const gridList = document.getElementById('artists-grid-list');
        const searchInput = document.getElementById('artists-search-input');
        const clearBtn = document.getElementById('artists-search-clear');

        if (!gridView || !profileView || !gridList) return;

        // Group library songs by split artist names (comma separation)
        const librarySongs = this.librarySongs || [];
        const artistMap = {};

        librarySongs.forEach(song => {
            const rawArtist = song.artist || 'Unknown Artist';
            const artistNames = rawArtist.split(',').map(s => s.trim()).filter(Boolean);
            
            artistNames.forEach(artistName => {
                if (!artistMap[artistName]) {
                    artistMap[artistName] = [];
                }
                artistMap[artistName].push(song);
            });
        });

        const sortedArtistNames = Object.keys(artistMap).sort((a, b) => a.localeCompare(b));

        // If targetArtistName is specified, render the profile view directly
        if (targetArtistName) {
            gridView.classList.add('hidden');
            profileView.classList.remove('hidden');
            this.renderArtistProfile(targetArtistName, artistMap[targetArtistName] || []);
            return;
        }

        // Render the grid list view
        gridView.classList.remove('hidden');
        profileView.classList.add('hidden');

        // Reset search inputs
        if (searchInput) {
            searchInput.value = '';
            if (clearBtn) clearBtn.classList.add('hidden');
        }

        const renderGrid = (filterQuery = '') => {
            const query = filterQuery.toLowerCase().trim();
            const filteredNames = sortedArtistNames.filter(name => name.toLowerCase().includes(query));

            // Update stats badge
            const countEl = document.getElementById('artists-count-badge');
            if (countEl) {
                countEl.textContent = `${filteredNames.length} Artist${filteredNames.length === 1 ? '' : 's'}`;
            }

            if (filteredNames.length === 0) {
                gridList.innerHTML = '<div class="empty-state">No artists found</div>';
                return;
            }

            gridList.innerHTML = filteredNames.map(artistName => {
                const count = artistMap[artistName].length;
                const initials = getInitials(artistName);
                const grad = getGradientForName(artistName);
                const initialsStyle = `background: linear-gradient(135deg, ${grad[0]} 0%, ${grad[1]} 100%); color: #ffffff; font-weight: 700; font-size: 2.2rem; text-shadow: 0 2px 4px rgba(0,0,0,0.15);`;
                
                return `
                    <div class="artist-circle-card" data-artist="${Utils.escapeHtml(artistName)}">
                        <div class="artist-circle-avatar" style="${initialsStyle}">
                            ${initials}
                            <div class="artist-circle-play-overlay">
                                <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M8 5v14l11-7z"/></svg>
                            </div>
                        </div>
                        <div class="artist-circle-name">${Utils.escapeHtml(artistName)}</div>
                        <div class="artist-circle-meta">${count} song${count === 1 ? '' : 's'}</div>
                    </div>
                `;
            }).join('');

            // Bind click events and fetch custom images
            const cards = gridList.querySelectorAll('.artist-circle-card');
            cards.forEach(card => {
                const artistName = card.dataset.artist;

                // Fetch custom artist metadata (bio/image) asynchronously
                fetch(`/api/music/artists/${encodeURIComponent(artistName)}`)
                    .then(res => res.json())
                    .then(data => {
                        if (data.image_url) {
                            const avatar = card.querySelector('.artist-circle-avatar');
                            if (avatar) {
                                avatar.style.background = 'none';
                                avatar.innerHTML = `<img src="${Utils.escapeHtml(data.image_url)}" alt="${Utils.escapeHtml(artistName)}" style="width:100%; height:100%; object-fit:cover;">`;
                            }
                        }
                    }).catch(err => Logger.error(err));

                card.addEventListener('click', () => {
                    gridView.classList.add('hidden');
                    profileView.classList.remove('hidden');
                    this.renderArtistProfile(artistName, artistMap[artistName]);
                });
            });
        };

        // Setup search input handlers
        if (searchInput) {
            searchInput.oninput = (e) => {
                const val = e.target.value;
                if (clearBtn) {
                    if (val) clearBtn.classList.remove('hidden');
                    else clearBtn.classList.add('hidden');
                }
                renderGrid(val);
            };

            if (clearBtn) {
                clearBtn.onclick = () => {
                    searchInput.value = '';
                    clearBtn.classList.add('hidden');
                    renderGrid('');
                };
            }
        }

        renderGrid('');
    }

    async renderArtistProfile(artistName, songs) {
        const nameText = document.getElementById('artist-profile-name-text');
        const bioText = document.getElementById('artist-profile-bio-text');
        const metaText = document.getElementById('artist-profile-meta-text');
        const heroBanner = document.getElementById('artist-hero-banner');
        const songsList = document.getElementById('artist-profile-songs-list');
        const heroAvatar = document.getElementById('artist-hero-avatar-wrap');
        const heroBlurBg = document.getElementById('artist-hero-blur-bg');

        if (!nameText || !bioText || !metaText || !heroBanner || !songsList) return;

        // Hide the shared section header when viewing a specific artist profile
        document.querySelector('.section-header')?.classList.add('hidden');

        // Set initial state / defaults
        nameText.textContent = artistName;
        bioText.textContent = 'No description available. Click Edit Profile to add one.';
        metaText.textContent = `${songs.length} song${songs.length === 1 ? '' : 's'} in library`;
        
        // Generate dynamic fallback gradient
        const grad = getGradientForName(artistName);
        const initials = getInitials(artistName);
        
        heroBanner.style.background = `linear-gradient(135deg, ${grad[0]} 0%, ${grad[1]} 100%)`;
        if (heroBlurBg) {
            heroBlurBg.style.backgroundImage = 'none';
        }
        
        if (heroAvatar) {
            heroAvatar.style.background = `linear-gradient(135deg, ${grad[0]} 0%, ${grad[1]} 100%)`;
            heroAvatar.style.color = '#ffffff';
            heroAvatar.style.fontSize = '3.5rem';
            heroAvatar.style.fontWeight = '700';
            heroAvatar.style.display = 'flex';
            heroAvatar.style.alignItems = 'center';
            heroAvatar.style.justifyContent = 'center';
            heroAvatar.textContent = initials;
        }

        // Load custom bio and image from server
        try {
            const res = await fetch(`/api/music/artists/${encodeURIComponent(artistName)}`);
            const data = await res.json();
            if (data.description) {
                bioText.textContent = data.description;
            }
            if (data.image_url) {
                if (heroBlurBg) {
                    heroBlurBg.style.backgroundImage = `url('${data.image_url}')`;
                }
                if (heroAvatar) {
                    heroAvatar.style.background = 'none';
                    heroAvatar.textContent = '';
                    heroAvatar.innerHTML = `<img src="${Utils.escapeHtml(data.image_url)}" alt="${Utils.escapeHtml(artistName)}" style="width:100%; height:100%; object-fit:cover; border-radius:inherit;">`;
                }
            }
        } catch (e) {
            Logger.error(e);
        }

        // Render matching songs
        const escapeHtml = Utils.escapeHtml;
        const coverOverrides = this.coverOverrides || {};
        const coverVersions = this.coverVersions || {};
        const songsGrid = document.getElementById('artist-profile-songs-grid');

        const renderArtistList = () => {
            songsList.classList.remove('hidden');
            songsGrid.classList.add('hidden');

            songsList.innerHTML = songs.map((song, trackIndex) => {
                const overridePath = coverOverrides[song.id] || song.cover_path;
                const bust = coverVersions[song.id] ? `?t=${coverVersions[song.id]}` : '';
                const coverHtml = overridePath
                    ? `<img src="/api/music/cover/${encodeURIComponent(overridePath)}${bust}" alt="Cover" loading="lazy" onerror="window.Utils.handleCoverError(this)">`
                    : `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>`;

                const globalIndex = this.librarySongs.findIndex(s => s.id === song.id);
                const artistNames = (song.artist || 'Unknown Artist').split(',').map(s => s.trim()).filter(Boolean);
                const artistLinksHtml = artistNames.map(name => `<span class="song-artist-link" data-artist="${escapeHtml(name)}">${escapeHtml(name)}</span>`).join(', ');

                return `
                <div class="artist-track-row fade-in" data-index="${globalIndex}" data-id="${song.id}">
                    <div class="track-number-col">
                        <span class="track-number">${trackIndex + 1}</span>
                        <button class="track-play-btn" title="Play">
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                                <path d="M8 5v14l11-7z"/>
                            </svg>
                        </button>
                    </div>
                    <div class="track-info-col">
                        <div class="track-artwork">${coverHtml}</div>
                        <div class="track-meta">
                            <div class="track-title">${escapeHtml(song.title)}</div>
                            <div class="track-artists">${artistLinksHtml}</div>
                        </div>
                    </div>
                    <div class="track-album-col">${escapeHtml(song.album || 'Single')}</div>
                    <div class="track-duration-col">${Utils.formatDuration(song.duration)}</div>
                    <div class="track-actions-col">
                        <button class="song-menu-btn" data-song-id="${song.id}" data-song-title="${escapeHtml(song.title)}" data-song-artist="${escapeHtml(song.artist)}">
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                                <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/>
                            </svg>
                        </button>
                    </div>
                </div>
                `;
            }).join('');

            songsList.querySelectorAll('.artist-track-row').forEach(row => {
                row.addEventListener('click', (e) => {
                    if (e.target.closest('.song-menu-btn')) return;
                    if (e.target.closest('.song-artist-link')) return;
                    const index = parseInt(row.dataset.index);
                    if (index >= 0) {
                        window.player.playSong(index, this.librarySongs, { type: 'library', id: null });
                    }
                });
            });

            songsList.querySelectorAll('.song-menu-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.showContextMenu(e, btn.dataset);
                });
            });

            this.bindRightClickEvents(songsList);
        };

        const renderArtistGrid = () => {
            songsGrid.classList.remove('hidden');
            songsList.classList.add('hidden');

            songsGrid.innerHTML = songs.map((song) => {
                const overridePath = coverOverrides[song.id] || song.cover_path;
                const bust = coverVersions[song.id] ? `?t=${coverVersions[song.id]}` : '';
                const coverHtml = overridePath
                    ? `<img src="/api/music/cover/${encodeURIComponent(overridePath)}${bust}" alt="Cover" loading="lazy" onerror="window.Utils.handleCoverError(this)">`
                    : `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>`;

                const globalIndex = this.librarySongs.findIndex(s => s.id === song.id);
                const artistNames = (song.artist || 'Unknown Artist').split(',').map(s => s.trim()).filter(Boolean);
                const artistLinksHtml = artistNames.map(name => `<span class="song-artist-link" data-artist="${escapeHtml(name)}">${escapeHtml(name)}</span>`).join(', ');

                return `
                <div class="song-card fade-in" data-index="${globalIndex}" data-id="${song.id}">
                    <button class="song-menu-btn" data-song-id="${song.id}" data-song-title="${escapeHtml(song.title)}" data-song-artist="${escapeHtml(song.artist)}">
                        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                            <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/>
                        </svg>
                    </button>
                    <div class="song-artwork">
                        ${coverHtml}
                        <div class="song-artwork-overlay">
                            <div class="play-btn-overlay">
                                <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M8 5v14l11-7z"/>
                                </svg>
                            </div>
                        </div>
                    </div>
                    <div class="song-info">
                        <div class="song-title">${escapeHtml(song.title)}</div>
                        <div class="song-artist">${artistLinksHtml}</div>
                        <div class="song-duration">${Utils.formatDuration(song.duration)}</div>
                    </div>
                </div>
                `;
            }).join('');

            songsGrid.querySelectorAll('.song-card').forEach(card => {
                card.addEventListener('click', (e) => {
                    if (e.target.closest('.song-menu-btn')) return;
                    if (e.target.closest('.song-artist-link')) return;
                    const index = parseInt(card.dataset.index);
                    if (index >= 0) {
                        window.player.playSong(index, this.librarySongs, { type: 'library', id: null });
                    }
                });
            });

            songsGrid.querySelectorAll('.song-menu-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.showContextMenu(e, btn.dataset);
                });
            });

            this.bindRightClickEvents(songsGrid);
        };

        const artistGridViewBtn = document.getElementById('artist-grid-view-btn');
        const artistListViewBtn = document.getElementById('artist-list-view-btn');

        if (artistGridViewBtn && artistListViewBtn) {
            artistGridViewBtn.onclick = () => {
                artistGridViewBtn.classList.add('active');
                artistListViewBtn.classList.remove('active');
                renderArtistGrid();
            };
            artistListViewBtn.onclick = () => {
                artistListViewBtn.classList.add('active');
                artistGridViewBtn.classList.remove('active');
                renderArtistList();
            };
        }

        renderArtistList();

        // Wire back button
        const backBtn = document.getElementById('artist-back-btn');
        if (backBtn) {
            backBtn.onclick = () => {
                this.switchToArtistsView();
            };
        }

        // Wire play all button
        const playAllBtn = document.getElementById('artist-play-all-btn');
        if (playAllBtn) {
            playAllBtn.onclick = () => {
                if (songs.length > 0) {
                    window.player.playSong(0, songs, { type: 'artist', id: artistName });
                }
            };
        }

        const discoverBtn = document.getElementById('artist-discover-btn');
        if (discoverBtn) {
            discoverBtn.onclick = () => {
                this.switchToDiscoverView(artistName);
            };
        }

        // Wire edit button to open modal
        const editBtn = document.getElementById('edit-artist-profile-btn');
        if (editBtn) {
            editBtn.onclick = () => {
                this.openEditArtistModal(artistName, bioText.textContent, heroBanner.style.backgroundImage || '');
            };
        }

        const bioToggle = document.getElementById('artist-bio-toggle');
        if (bioToggle) {
            bioText.classList.remove('expanded');
            bioToggle.textContent = 'more';
            bioToggle.classList.add('hidden');
            requestAnimationFrame(() => {
                if (bioText.scrollHeight > bioText.clientHeight + 2) {
                    bioToggle.classList.remove('hidden');
                }
            });
            bioToggle.onclick = () => {
                const expanded = bioText.classList.toggle('expanded');
                bioToggle.textContent = expanded ? 'less' : 'more';
            };
        }
    }

    openEditArtistModal(artistName, currentBio, currentBackgroundUrl) {
        const modal = document.getElementById('edit-artist-modal');
        const imgInput = document.getElementById('edit-artist-image-input');
        const bioInput = document.getElementById('edit-artist-bio-input');
        const cancelBtn = document.getElementById('cancel-edit-artist-btn');
        const saveBtn = document.getElementById('save-edit-artist-btn');
        const closeBtn = document.getElementById('close-edit-artist-modal');
        const scrapeBtn = document.getElementById('scrape-artist-btn');
        const scrapeBtnText = document.getElementById('scrape-btn-text');
        const scrapeResultBanner = document.getElementById('scrape-result-banner');
        const scrapeSourceLink = document.getElementById('scrape-source-link');
        const imagePreview = document.getElementById('artist-image-preview');
        const tabs = modal.querySelectorAll('.artist-modal-tab');
        const panels = modal.querySelectorAll('.artist-modal-tab-panel');
        const closeSongsBtn = document.getElementById('close-songs-tab-btn');

        if (!modal || !imgInput || !bioInput) return;

        // Update modal title
        const titleEl = document.getElementById('edit-artist-modal-title');
        if (titleEl) titleEl.textContent = `Edit: ${artistName}`;

        // Clean background image URL if set
        let bgUrl = '';
        if (currentBackgroundUrl && currentBackgroundUrl.startsWith('url("')) {
            bgUrl = currentBackgroundUrl.slice(5, -2);
        } else if (currentBackgroundUrl && currentBackgroundUrl.startsWith("url('")) {
            bgUrl = currentBackgroundUrl.slice(5, -2);
        } else if (currentBackgroundUrl && currentBackgroundUrl.startsWith('url(')) {
            bgUrl = currentBackgroundUrl.slice(4, -1);
        }

        // Populate fields
        imgInput.value = bgUrl;
        bioInput.value = currentBio.includes('No description available') ? '' : currentBio;

        // Live image preview
        const updatePreview = (url) => {
            if (imagePreview) {
                if (url) {
                    imagePreview.innerHTML = `<img src="${Utils.escapeHtml(url)}" alt="Artist" onerror="this.parentElement.innerHTML='<svg viewBox=\'0 0 24 24\' fill=\'currentColor\'><path d=\'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z\'/></svg>'">`;
                } else {
                    imagePreview.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>`;
                }
            }
        };
        updatePreview(bgUrl);

        let previewDebounce;
        const onImgInput = () => {
            clearTimeout(previewDebounce);
            previewDebounce = setTimeout(() => updatePreview(imgInput.value.trim()), 400);
        };
        imgInput.removeEventListener('input', imgInput._previewHandler);
        imgInput._previewHandler = onImgInput;
        imgInput.addEventListener('input', onImgInput);

        // Reset scrape banner + picker
        if (scrapeResultBanner) scrapeResultBanner.classList.add('hidden');
        const scrapePicker = document.getElementById('scrape-picker');
        if (scrapePicker) scrapePicker.classList.add('hidden');
        const scrapePickerList = document.getElementById('scrape-picker-list');
        if (scrapePickerList) scrapePickerList.innerHTML = '';

        let renderScrapePicker = (candidates) => {
            if (!scrapePicker || !scrapePickerList) return;
            scrapePickerList.innerHTML = '';
            candidates.forEach(c => {
                const card = document.createElement('div');
                card.className = 'scrape-candidate';
                card.innerHTML = `
                    <img class="scrape-candidate-img" src="${c.image_url || ''}" alt="" onerror="this.style.display='none'">
                    <div class="scrape-candidate-info">
                        <div class="scrape-candidate-name">${c.name}</div>
                        <div class="scrape-candidate-desc">${c.description || ''}</div>
                    </div>
                    <a class="scrape-candidate-link" href="${c.source_url}" target="_blank" rel="noopener noreferrer">View</a>
                `;
                card.onclick = (e) => {
                    if (e.target.tagName === 'A') return;
                    if (c.description) bioInput.value = c.description;
                    if (c.image_url) {
                        imgInput.value = c.image_url;
                        updatePreview(c.image_url);
                    }
                    if (scrapeResultBanner && scrapeSourceLink) {
                        scrapeSourceLink.textContent = c.name;
                        scrapeSourceLink.href = c.source_url || '#';
                        scrapeResultBanner.classList.remove('hidden');
                    }
                    scrapePicker.classList.add('hidden');
                    this.showToast(`Picked "${c.name}"`, 'success');
                };
                scrapePickerList.appendChild(card);
            });
            scrapePicker.classList.remove('hidden');
        };

        // Reset to profile tab
        tabs.forEach(t => t.classList.remove('active'));
        panels.forEach(p => p.classList.remove('active'));
        const profileTab = modal.querySelector('[data-tab="profile"]');
        const profilePanel = document.getElementById('artist-tab-profile');
        if (profileTab) profileTab.classList.add('active');
        if (profilePanel) profilePanel.classList.add('active');

        modal.classList.remove('hidden');

        // Tab switching
        tabs.forEach(tab => {
            tab.onclick = async () => {
                tabs.forEach(t => t.classList.remove('active'));
                panels.forEach(p => p.classList.remove('active'));
                tab.classList.add('active');
                const panelId = `artist-tab-${tab.dataset.tab}`;
                const panel = document.getElementById(panelId);
                if (panel) panel.classList.add('active');

                if (tab.dataset.tab === 'songs') {
                    await this._loadArtistSongsTab(artistName);
                }
            };
        });

        const closeModal = () => {
            modal.classList.add('hidden');
            if (scrapeResultBanner) scrapeResultBanner.classList.add('hidden');
        };

        if (cancelBtn) cancelBtn.onclick = closeModal;
        if (closeBtn) closeBtn.onclick = closeModal;
        if (closeSongsBtn) closeSongsBtn.onclick = closeModal;

        // Scrape handler
        if (scrapeBtn) {
            scrapeBtn.onclick = async () => {
                scrapeBtn.disabled = true;
                if (scrapeBtnText) scrapeBtnText.textContent = 'Scraping...';
                try {
                    const res = await fetch(`/api/music/artists/${encodeURIComponent(artistName)}/scrape`, {
                        method: 'POST'
                    });
                    const data = await res.json();
                    if (data.success && data.candidates) {
                        if (data.candidates.length === 1) {
                            const c = data.candidates[0];
                            if (c.description) bioInput.value = c.description;
                            if (c.image_url) {
                                imgInput.value = c.image_url;
                                updatePreview(c.image_url);
                            }
                            if (scrapeResultBanner && scrapeSourceLink) {
                                scrapeSourceLink.textContent = c.name;
                                scrapeSourceLink.href = c.source_url || '#';
                                scrapeResultBanner.classList.remove('hidden');
                            }
                            this.showToast(`Found "${c.name}" on YouTube Music`, 'success');
                        } else {
                            renderScrapePicker(data.candidates);
                            this.showToast(`Found ${data.candidates.length} candidates for "${artistName}" — pick one`, 'success');
                        }
                    } else {
                        this.showToast(data.error || 'Nothing found on YouTube Music for this artist', 'error');
                    }
                } catch (e) {
                    this.showToast('Scrape failed: ' + e.message, 'error');
                } finally {
                    scrapeBtn.disabled = false;
                    if (scrapeBtnText) scrapeBtnText.textContent = 'Scrape Info';
                }
            };
        }

        // Save handler
        if (saveBtn) {
            saveBtn.onclick = async () => {
                const bioVal = bioInput.value.trim();
                const imgVal = imgInput.value.trim();

                saveBtn.disabled = true;
                try {
                    const res = await fetch(`/api/music/artists/${encodeURIComponent(artistName)}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ description: bioVal, image_url: imgVal })
                    });
                    const data = await res.json();
                    if (data.success) {
                        this.showToast('Artist profile updated', 'success');
                        closeModal();
                        const librarySongs = this.librarySongs || [];
                        const matchedSongs = librarySongs.filter(song => {
                            const artistNames = (song.artist || '').split(',').map(s => s.trim()).filter(Boolean);
                            return artistNames.includes(artistName);
                        });
                        this.renderArtistProfile(artistName, matchedSongs);
                    } else {
                        this.showToast('Failed to save artist profile', 'error');
                    }
                } finally {
                    saveBtn.disabled = false;
                }
            };
        }
    }

    async _loadArtistSongsTab(artistName) {
        const loadingEl = document.getElementById('artist-songs-loading');
        const listEl = document.getElementById('artist-songs-list');
        const countEl = document.getElementById('artist-songs-count');
        const searchInput = document.getElementById('artist-songs-search');

        if (!listEl) return;

        if (loadingEl) loadingEl.classList.remove('hidden');
        listEl.innerHTML = '';
        if (countEl) countEl.textContent = '';
        if (searchInput) searchInput.value = '';

        let allSongs = [];
        try {
            const res = await fetch(`/api/music/artists/${encodeURIComponent(artistName)}/songs`);
            const data = await res.json();
            allSongs = data.songs || [];
        } catch (e) {
            listEl.innerHTML = '<div style="padding: 24px; color: var(--text-tertiary); text-align: center; font-size: 0.875rem;">Failed to load songs</div>';
            if (loadingEl) loadingEl.classList.add('hidden');
            return;
        }

        if (loadingEl) loadingEl.classList.add('hidden');

        const renderList = (filter = '') => {
            const lower = filter.toLowerCase();
            const filtered = filter
                ? allSongs.filter(s => s.title.toLowerCase().includes(lower) || (s.album || '').toLowerCase().includes(lower))
                : allSongs;

            if (countEl) countEl.textContent = `${filtered.length} song${filtered.length === 1 ? '' : 's'}`;

            listEl.innerHTML = filtered.map(song => `
                <div class="artist-song-row" data-song-id="${song.id}">
                    <label class="artist-song-toggle" title="${song.has_artist ? 'Remove from artist' : 'Add to artist'}">
                        <input type="checkbox" ${song.has_artist ? 'checked' : ''} data-song-id="${song.id}">
                        <span class="artist-song-slider"></span>
                    </label>
                    <div class="artist-song-meta">
                        <div class="artist-song-title">${Utils.escapeHtml(song.title)}</div>
                        <div class="artist-song-album">${Utils.escapeHtml(song.album || 'Unknown Album')}</div>
                    </div>
                </div>
            `).join('');

            listEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                cb.onchange = async () => {
                    const songId = parseInt(cb.dataset.songId);
                    const action = cb.checked ? 'add' : 'remove';
                    cb.disabled = true;
                    try {
                        const res = await fetch(`/api/music/artists/${encodeURIComponent(artistName)}/songs/${songId}`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ action })
                        });
                        const d = await res.json();
                        if (d.success) {
                            const song = allSongs.find(s => s.id === songId);
                            if (song) {
                                song.has_artist = cb.checked;
                                song.artist = d.new_artist;
                            }
                            if (this.librarySongs) {
                                const libSong = this.librarySongs.find(s => s.id === songId);
                                if (libSong) libSong.artist = d.new_artist;
                            }
                            this.showToast(action === 'add' ? `Added to ${artistName}` : `Removed from ${artistName}`, 'success');
                        } else {
                            cb.checked = !cb.checked;
                            this.showToast('Failed to update song', 'error');
                        }
                    } catch (e) {
                        cb.checked = !cb.checked;
                        this.showToast('Error updating song', 'error');
                    } finally {
                        cb.disabled = false;
                    }
                };
            });
        };

        renderList();

        if (searchInput) {
            searchInput.oninput = () => renderList(searchInput.value);
        }
    }
}
