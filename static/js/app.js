import { PLAYLIST_ICONS, PLAYLIST_ICON_COLORS } from './data/playlist-icons.js';
import { useContext } from './helper/context.js';
import { Logger } from "./helper/logger.js";
import { ResponseError } from './helper/request.js';
import { Result } from './helper/result.js';
import { Router, View } from './helper/router.js';
import { Library } from './modules/library.js';
import { LibraryWatcher } from './modules/libraryWatcher.js';
import { Playlists, playlistDisplayName } from './modules/playlists.js';
import { Utils } from './modules/utils.js';
import { browserLanguage, fillLanguageSelect, getLanguage, setLanguage, t } from './i18n/index.js';
import { useAuthService } from "./services/auth.js";
import { useEnrichmentService } from "./services/enrichment.js";
import { useImportJobsService } from "./services/importJobs.js";
import { useLightshowService } from "./services/lightshow.js";
import { useLyricsService } from "./services/lyrics.js";
import { useMusicService } from "./services/music.js";
import { usePlaylistService } from './services/playlist.js';
import { useScanService } from './services/scan.js';
import { useSetupService } from "./services/setup.js";
import { useUsersService } from './services/users.js';
import * as AppView from "./view/app.js";
import * as LoginView from "./view/login.js";
import * as SetupView from "./view/setup.js";

// Section id -> page title. Also used to label settings search results.
const SETTINGS_SECTION_TITLES = {
    appearance: 'Appearance',
    player: 'Player',
    account: 'Account',
    syncs: 'Playlist Sync',
    jobs: 'Jobs',
    server: 'Maintenance',
    users: 'Users',
    chromecast: 'Chromecast Setup',
};

// Server Settings sections only a sysadmin may open.
const ADMIN_SETTINGS_SECTIONS = new Set(['server', 'users']);

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
        const savedViewMode = localStorage.getItem('rainy_library_view_mode');
        this.currentViewMode = savedViewMode === 'list' ? 'list' : 'grid'; // 'grid' or 'list'
        this.selectedSong = null; // For context menu
        this.listSortOrder = 'none'; // 'none', 'asc', 'desc'
        this.currentSort = 'default';
        this.coverVersion = {};
        this.coverOverride = {};
        this._routingStarted = false;
        this._settingsReturnPath = null;
        // Picks up songs/playlists added elsewhere (other tabs, devices,
        // users, background imports) without a reload.
        this.libraryWatcher = new LibraryWatcher(this);

        useContext().set('app', this);

        window.addEventListener('rainy:unauthorized', () => this.handleSessionExpired());

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
        if (isCollapsed && !this.isMobileViewport()) {
            document.querySelector('.app-sidebar')?.classList.add('collapsed');
            document.querySelector('.header-left')?.classList.add('collapsed');
        }
        document.getElementById('sidebar-toggle')?.setAttribute(
            'aria-expanded',
            String(!this.isMobileViewport() && !isCollapsed)
        );

        // Restore the "More" nav section (Recently Played / Smart Mix / Discover)
        this.setMoreNavigationOpen(this.loadMoreNavigationPref());
        this.setBrowseNavigationOpen(this.loadBrowseNavigationPref());

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

        // Components rendered in the language cached from the last visit;
        // if this account uses another one, reload once in it.
        const language = user.language || browserLanguage();
        if (language !== getLanguage() && await setLanguage(language)) {
            window.location.reload();
            return;
        }

        this.user = user;
        this.applyThemeFromPreferences();
        this.applyPlayerBarPreferences();
        this.applyRoleVisibility();

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

        // Close transient surfaces and settings with Escape.
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (this.closeMobileSidebar()) return;
                if (this.closePlayerTools()) return;

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

            const settingsPage = document.getElementById('settings-page');
            if (e.key === 'Tab' && settingsPage && !settingsPage.classList.contains('hidden')) {
                this.trapFocus(settingsPage, e);
            }
        });

        window.addEventListener('popstate', () => {
            this.handleRoute();
        });

        // Settings sidebar navigation
        document.querySelectorAll('.settings-nav-item').forEach(item => {
            item.setAttribute('role', 'button');
            item.setAttribute('tabindex', '0');
            item.addEventListener('click', (e) => {
                if (!this.shouldHandleInternalClick(e)) return;
                e.preventDefault();
                const section = item.dataset.section;
                if (section) this.switchSettingsSection(section);
            });
            item.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                const section = item.dataset.section;
                if (section) this.switchSettingsSection(section);
            });
        });

        // Settings search functionality
        const settingsSearchInput = document.getElementById('settings-search-input');
        settingsSearchInput?.addEventListener('input', (e) => {
            this.handleSettingsSearch(e.target.value);
        });
        settingsSearchInput?.addEventListener('keydown', (e) => this._onSettingsSearchKeydown(e));
        document.getElementById('settings-search-clear')?.addEventListener('click', () => {
            this._clearSettingsSearch();
            settingsSearchInput?.focus();
        });

        // Header search filters the library in place.
        const searchInput = document.getElementById('search-input');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => this.handleSearch(e.target.value));
        }

        // Keyboard shortcuts cheat sheet (same overlay the ? key toggles)
        document.getElementById('shortcuts-btn')?.addEventListener('click', () => {
            window.__shortcutOverlay?.open();
        });

        // Keep the desktop collapse state separate from the mobile drawer.
        window.addEventListener('resize', () => {
            const sidebar = document.querySelector('.app-sidebar');
            const headerLeft = document.querySelector('.header-left');
            if (this.isMobileViewport()) {
                sidebar?.classList.remove('collapsed');
                headerLeft?.classList.remove('collapsed');
            } else {
                this.closeMobileSidebar();
                const isCollapsed = localStorage.getItem('sidebarCollapsed') === 'true';
                sidebar?.classList.toggle('collapsed', isCollapsed);
                headerLeft?.classList.toggle('collapsed', isCollapsed);
                document.getElementById('sidebar-toggle')?.setAttribute('aria-expanded', String(!isCollapsed));
            }
        });

        document.getElementById('sidebar-backdrop')?.addEventListener('click', () => {
            this.closeMobileSidebar();
        });

        document.getElementById('nav-more-toggle')?.addEventListener('click', (e) => {
            e.preventDefault();
            this.toggleMoreNavigation();
        });

        document.getElementById('nav-browse-toggle')?.addEventListener('click', (e) => {
            e.preventDefault();
            this.toggleBrowseNavigation();
        });

        document.getElementById('player-more-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.togglePlayerTools();
        });

        document.addEventListener('click', (e) => {
            if (!e.target.closest('#player-extra') && !e.target.closest('#player-more-btn')) {
                this.closePlayerTools();
            }
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
            const defaultColor = '#3d7dc4';
            if (colorInput) colorInput.value = defaultColor;
            document.getElementById('settings-accent-color-value').textContent = defaultColor;
            this.applyTheme(defaultColor);
            this.savePreferences({ theme_color: defaultColor });
        });

        // Interface language (saved per account)
        const languageSelect = document.getElementById('settings-language');
        if (languageSelect) {
            fillLanguageSelect(languageSelect);
            languageSelect.addEventListener('change', () => this.changeLanguage(languageSelect.value));
        }

        // No Anime mode
        document.getElementById('settings-no-anime')?.addEventListener('change', (e) => {
            this.applyNoAnime(e.target.checked);
            this.savePreferences({ no_anime: e.target.checked });
        });

        // Chromecast Setup copy origin
        document.getElementById('chromecast-copy-origin-btn')?.addEventListener('click', (e) => {
            const txt = (document.getElementById('chromecast-origin-url')?.textContent || '').trim();
            if (!txt || txt === '—') return;
            try { navigator.clipboard?.writeText(txt); } catch (err) { /* ignore */ }
            const btn = e.currentTarget;
            const old = btn.textContent;
            btn.textContent = t('Copied!');
            setTimeout(() => { btn.textContent = old; }, 1500);
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
                    if (window.player) window.player.setLyricsEffect(value);
                }
            });
        });

        document.getElementById('settings-fullscreen-swap')?.addEventListener('change', (e) => {
            this.savePreferences({ fullscreen_swap_sides: e.target.checked });
        });

        document.getElementById('settings-disable-lasers')?.addEventListener('change', (e) => {
            this.savePreferences({ disable_lasers: e.target.checked });
        });

        document.getElementById('settings-show-bg-blur')?.addEventListener('change', (e) => {
            this.savePreferences({ show_bg_blur: e.target.checked });
        });

        document.getElementById('settings-lightshow-lyrics')?.addEventListener('change', (e) => {
            this.savePreferences({ lightshow_lyrics: e.target.checked });
        });

        document.getElementById('settings-lightshow-reduce-flashing')?.addEventListener('change', (e) => {
            this.savePreferences({ lightshow_reduce_flashing: e.target.checked });
        });

        // Per device, not per account: the same user may have a desktop that runs the full show fine.
        document.getElementById('settings-lightshow-low-power')?.addEventListener('change', (e) => {
            try {
                if (e.target.checked) localStorage.setItem('rainy-ls-lowpower', '1');
                else localStorage.removeItem('rainy-ls-lowpower');
            } catch (err) { /* ignore */ }
        });

        const lightshowOffset = document.getElementById('settings-lightshow-offset');
        lightshowOffset?.addEventListener('input', (e) => this._renderLightshowOffset(Number(e.target.value)));
        lightshowOffset?.addEventListener('change', (e) => {
            this.savePreferences({ lightshow_offset_ms: Number(e.target.value) || 0 });
        });

        // Player Bar control toggles — apply instantly + persist
        document.querySelectorAll('.pb-toggle-input').forEach(input => {
            input.addEventListener('change', (e) => {
                const key = input.dataset.playerbarToggle;
                const controls = { ...(this._getPlayerPrefs().player_bar_controls || {}) };
                controls[key] = e.target.checked;
                this.savePreferences({ player_bar_controls: controls });
                this.applyPlayerBarPreferences();
            });
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
                const isOpen = userMenu.classList.toggle('open');
                userDropdown.classList.toggle('hidden', !isOpen);
                userMenuTrigger.setAttribute('aria-expanded', String(isOpen));
            });
            userMenuTrigger.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                userMenuTrigger.click();
            });
        }

        // Close dropdown when clicking outside
        document.addEventListener('click', () => {
            if (userMenu) {
                userMenu.classList.remove('open');
                userDropdown?.classList.add('hidden');
                userMenuTrigger?.setAttribute('aria-expanded', 'false');
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

        // Duplicate finder (Jobs section)
        document.getElementById('dup-scan-btn')?.addEventListener('click', () => {
            this.scanDuplicates();
        });
        document.getElementById('dup-merge-all-btn')?.addEventListener('click', () => {
            this.mergeAllDuplicates();
        });

        document.getElementById('scrape-artists-btn')?.addEventListener('click', () => {
            this.runScrapeArtists();
        });

        document.getElementById('scrape-descriptions-btn')?.addEventListener('click', () => {
            this.runScrapeDescriptions();
        });

        document.getElementById('enrich-run-btn')?.addEventListener('click', () => {
            this.runEnrichBackfill(false);
        });

        document.getElementById('enrich-force-btn')?.addEventListener('click', () => {
            this.runEnrichBackfill(true);
        });

        document.getElementById('lyrics-run-btn')?.addEventListener('click', () => {
            this.runLyricsBackfill(false);
        });

        document.getElementById('lyrics-force-btn')?.addEventListener('click', () => {
            this.runLyricsBackfill(true);
        });

        document.getElementById('import-jobs-refresh-btn')?.addEventListener('click', () => {
            this.loadImportJobs();
        });

        document.getElementById('ytdlp-update-btn')?.addEventListener('click', () => {
            this.updateYtdlp();
        });

        document.getElementById('lightshow-run-btn')?.addEventListener('click', () => {
            this.runLightshowBackfill(false);
        });

        document.getElementById('lightshow-force-btn')?.addEventListener('click', () => {
            this.runLightshowBackfill(true);
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

        // Invite a friend to collaborate on this playlist (owner only)
        document.getElementById('action-share-playlist')?.addEventListener('click', () => {
            document.getElementById('playlist-settings-dropdown').classList.add('hidden');
            const title = document.querySelector('.section-title')?.textContent || '';
            window.friendsModule?.openInviteModal(this.currentPlaylistId, title);
        });

        // Leave a shared playlist (collaborators)
        document.getElementById('action-leave-playlist')?.addEventListener('click', () => {
            document.getElementById('playlist-settings-dropdown').classList.add('hidden');
            const title = document.querySelector('.section-title')?.textContent || '';
            window.friendsModule?.leavePlaylist(this.currentPlaylistId, title);
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

        // Rainy Connect — device picker / remote control
        document.getElementById('connect-btn')?.addEventListener('click', () => {
            /** @type {import('./components/connectModal.js').ConnectModal} */
            const modal = document.querySelector('rainy-connect-modal');
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
            if (!this.shouldHandleInternalClick(e)) return;
            e.preventDefault();
            this.switchToLibraryView();
        });

        document.getElementById('nav-friends')?.addEventListener('click', (e) => {
            if (!this.shouldHandleInternalClick(e)) return;
            e.preventDefault();
            this.openFriendsView();
        });

        // Sidebar Toggle
        document.getElementById('sidebar-toggle')?.addEventListener('click', () => {
            this.toggleSidebar();
        });

        // Selecting any destination should dismiss the mobile drawer.
        document.addEventListener('click', (e) => {
            const navItem = e.target.closest('.app-sidebar .nav-item');
            if (!navItem) return;
            if (navItem.classList.contains('nav-secondary-item')) {
                this.setMoreNavigationOpen(true);
            }
            if (navItem.classList.contains('nav-browse-item')) {
                this.setBrowseNavigationOpen(true);
            }
            this.closeMobileSidebar();
        });

        // Playlist Settings action download
        document.getElementById('action-download-playlist')?.addEventListener('click', () => {
            document.getElementById('playlist-settings-dropdown').classList.add('hidden');
            if (this.currentPlaylistId) {
                window.location.href = `/api/playlists/${this.currentPlaylistId}/download`;
            }
        });

        // Playlist export as M3U
        document.getElementById('action-export-m3u')?.addEventListener('click', () => {
            document.getElementById('playlist-settings-dropdown').classList.add('hidden');
            if (this.currentPlaylistId) {
                window.location.href = `/api/playlists/${this.currentPlaylistId}/export?format=m3u`;
            }
        });

        // Playlist export as CSV
        document.getElementById('action-export-csv')?.addEventListener('click', () => {
            document.getElementById('playlist-settings-dropdown').classList.add('hidden');
            if (this.currentPlaylistId) {
                window.location.href = `/api/playlists/${this.currentPlaylistId}/export?format=csv`;
            }
        });

        // Playlist regenerate cover (auto mosaic from song covers)
        document.getElementById('action-regen-cover')?.addEventListener('click', async () => {
            document.getElementById('playlist-settings-dropdown').classList.add('hidden');
            if (!this.currentPlaylistId) return;
            try {
                window.showToast?.('Generating cover…', 'info');
                const res = await fetch(`/api/playlists/${this.currentPlaylistId}/cover`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                });
                const data = await res.json();
                if (res.ok && data.success) {
                    window.showToast?.('Cover regenerated', 'success');
                    // Re-open the playlist to refresh the displayed cover.
                    await this.openPlaylist(this.currentPlaylistId);
                    this.loadPlaylists?.();
                } else {
                    window.showToast?.(data.error || 'Failed to generate cover', 'error');
                }
            } catch (e) {
                window.showToast?.('Failed to generate cover', 'error');
            }
        });

        // Discover Music click
        document.getElementById('nav-discover')?.addEventListener('click', (e) => {
            if (!this.shouldHandleInternalClick(e)) return;
            e.preventDefault();
            this.switchToDiscoverView();
        });

        // Artists click
        document.getElementById('nav-artists')?.addEventListener('click', (e) => {
            if (!this.shouldHandleInternalClick(e)) return;
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
        this.initPlaylistSyncs();
    }

    shouldHandleInternalClick(event) {
        return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
    }

    startRouting() {
        if (!this.user || this._routingStarted) return;
        this._routingStarted = true;
        this.handleRoute().catch((error) => Logger.error('Initial route error:', error));
    }

    navigateTo(path, { replace = false } = {}) {
        const target = new URL(path, window.location.origin);
        if (target.origin !== window.location.origin) return;

        const next = `${target.pathname}${target.search}${target.hash}`;
        const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
        if (next !== current) {
            const method = replace ? 'replaceState' : 'pushState';
            window.history[method]({}, '', next);
        }

        return this.handleRoute();
    }

    async handleRoute() {
        if (!this.user || document.getElementById('app-view')?.classList.contains('hidden')) return;

        const decodeSegment = (segment) => {
            try {
                return decodeURIComponent(segment);
            } catch (error) {
                return segment;
            }
        };

        let segments = window.location.pathname
            .split('/')
            .filter(Boolean)
            .map(decodeSegment);

        if (segments.length === 0) {
            window.history.replaceState({}, '', '/library');
            segments = ['library'];
        }

        const route = segments[0].toLowerCase();
        const query = new URLSearchParams(window.location.search);
        const needsNewViews = ['albums', 'recent', 'recently-played', 'smart-mix', 'smartmix'].includes(route);
        if (['recent', 'recently-played', 'smart-mix', 'smartmix', 'discover', 'friends'].includes(route)) {
            this.setMoreNavigationOpen(true);
        }
        if (['albums', 'artists'].includes(route)) {
            this.setBrowseNavigationOpen(true);
        }
        if (needsNewViews && !window.newViews) {
            // main.js creates NewViews just after RainyApp. Keep the route
            // pending if authentication finishes during that small window.
            this._routingStarted = false;
            return;
        }

        if (route === 'settings') {
            return this.openSettings(segments[1] || 'appearance', { updateUrl: false });
        }

        const settingsPage = document.getElementById('settings-page');
        if (settingsPage && !settingsPage.classList.contains('hidden')) {
            this.closeSettings({ updateUrl: false });
        }

        switch (route) {
            case 'library':
                return this.switchToLibraryView({ updateUrl: false });
            case 'albums':
                await window.newViews.switchToAlbums({ updateUrl: false });
                if (segments[1]) {
                    await window.newViews.openAlbumDetail(
                        segments[1],
                        query.get('artist') || '',
                        { updateUrl: false }
                    );
                }
                return;
            case 'artists':
                return this.switchToArtistsView(segments[1] || null, { updateUrl: false });
            case 'friends':
                return this.openFriendsView({ updateUrl: false });
            case 'recent':
            case 'recently-played':
                return window.newViews.switchToRecent({ updateUrl: false });
            case 'smart-mix':
            case 'smartmix':
                return window.newViews.switchToSmartMix({ updateUrl: false });
            case 'discover':
                return this.switchToDiscoverView(query.get('q'), { updateUrl: false });
            case 'playlist':
            case 'playlists': {
                const playlistId = Number(segments[1]);
                if (Number.isInteger(playlistId) && playlistId > 0) {
                    return this.openPlaylist(playlistId, { updateUrl: false });
                }
                break;
            }
            default:
                break;
        }

        // Unknown frontend paths resolve to the canonical library route.
        window.history.replaceState({}, '', '/library');
        return this.switchToLibraryView({ updateUrl: false });
    }

    closeDropdown() {
        const userMenu = document.getElementById('user-menu');
        const userDropdown = document.getElementById('user-dropdown');
        userMenu?.classList.remove('open');
        userDropdown?.classList.add('hidden');
        document.getElementById('user-menu-trigger')?.setAttribute('aria-expanded', 'false');
    }

    toggleSidebar() {
        const sidebar = document.querySelector('.app-sidebar');
        const headerLeft = document.querySelector('.header-left');
        if (!sidebar) return;

        if (this.isMobileViewport()) {
            const isOpen = sidebar.classList.toggle('mobile-open');
            sidebar.classList.remove('collapsed');
            headerLeft?.classList.remove('collapsed');
            this.setSidebarBackdrop(isOpen);
            document.getElementById('sidebar-toggle')?.setAttribute('aria-expanded', String(isOpen));
            return;
        }

        sidebar.classList.toggle('collapsed');
        const isCollapsed = sidebar.classList.contains('collapsed');
        // Sync header-left width for browsers without :has() support
        if (headerLeft) {
            headerLeft.classList.toggle('collapsed', isCollapsed);
        }
        localStorage.setItem('sidebarCollapsed', isCollapsed);
        document.getElementById('sidebar-toggle')?.setAttribute('aria-expanded', String(!isCollapsed));
    }

    isMobileViewport() {
        return window.matchMedia?.('(max-width: 768px)').matches || window.innerWidth <= 768;
    }

    setSidebarBackdrop(isOpen) {
        const backdrop = document.getElementById('sidebar-backdrop');
        if (!backdrop) return;
        backdrop.classList.toggle('hidden', !isOpen);
        backdrop.setAttribute('aria-hidden', String(!isOpen));
    }

    closeMobileSidebar() {
        const sidebar = document.querySelector('.app-sidebar');
        if (!sidebar || !sidebar.classList.contains('mobile-open')) return false;
        sidebar.classList.remove('mobile-open');
        this.setSidebarBackdrop(false);
        document.getElementById('sidebar-toggle')?.setAttribute('aria-expanded', 'false');
        return true;
    }

    setMoreNavigationOpen(isOpen) {
        const sidebar = document.querySelector('.app-sidebar');
        const toggle = document.getElementById('nav-more-toggle');
        if (!sidebar) return;
        sidebar.classList.toggle('more-open', isOpen);
        toggle?.setAttribute('aria-expanded', String(isOpen));
    }

    /** Only an explicit toggle is remembered; opening it because you navigated into it is not. */
    toggleMoreNavigation() {
        const sidebar = document.querySelector('.app-sidebar');
        if (!sidebar) return;
        const isOpen = !sidebar.classList.contains('more-open');
        this.setMoreNavigationOpen(isOpen);
        try { localStorage.setItem('navMoreOpen', String(isOpen)); } catch { /* storage unavailable */ }
    }

    setBrowseNavigationOpen(isOpen) {
        const sidebar = document.querySelector('.app-sidebar');
        if (!sidebar) return;
        sidebar.classList.toggle('browse-closed', !isOpen);
        document.getElementById('nav-browse-toggle')?.setAttribute('aria-expanded', String(isOpen));
    }

    /** Browse is open unless the listener folded it; only explicit toggles are remembered. */
    toggleBrowseNavigation() {
        const sidebar = document.querySelector('.app-sidebar');
        if (!sidebar) return;
        const isOpen = sidebar.classList.contains('browse-closed');
        this.setBrowseNavigationOpen(isOpen);
        try { localStorage.setItem('navBrowseOpen', String(isOpen)); } catch { /* storage unavailable */ }
    }

    loadBrowseNavigationPref() {
        try {
            return localStorage.getItem('navBrowseOpen') !== 'false';
        } catch {
            return true;
        }
    }

    loadMoreNavigationPref() {
        try {
            return localStorage.getItem('navMoreOpen') === 'true';
        } catch {
            return false;
        }
    }

    togglePlayerTools() {
        const tools = document.getElementById('player-extra');
        const button = document.getElementById('player-more-btn');
        if (!tools) return;
        const isOpen = tools.classList.toggle('hidden') === false;
        button?.setAttribute('aria-expanded', String(isOpen));
    }

    closePlayerTools() {
        const tools = document.getElementById('player-extra');
        const button = document.getElementById('player-more-btn');
        if (!tools || tools.classList.contains('hidden')) return false;
        tools.classList.add('hidden');
        button?.setAttribute('aria-expanded', 'false');
        return true;
    }

    async loadScanStatus() {
        const data = await useScanService().status();
        if (data.error) return Logger.error(data.error);

        const status = data.value;
        if (!status) return Logger.error('unreachable');

        const libraryCount = document.querySelector('#library-count');
        const lastScanTime = document.querySelector('#last-scan-time');

        if (libraryCount) libraryCount.textContent = t('{count} songs', { count: status.library_total || 0 });
        if (lastScanTime && status.has_scan) {
            if (status.scan.status === 'running') {
                lastScanTime.textContent = t('In progress...');
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
        scanProgressText.textContent = fullScan ? t('Running full scan...') : t('Scanning for new files...');

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

    async scanDuplicates() {
        const btn = document.getElementById('dup-scan-btn');
        const results = document.getElementById('dup-results');
        const summary = document.getElementById('dup-summary');
        const mergeAllWrap = document.getElementById('dup-merge-all-wrap');

        btn.disabled = true;
        results.innerHTML = `<p class="settings-row-hint" style="padding:12px 0;">${t('Scanning library…')}</p>`;

        try {
            const res = await fetch('/api/music/duplicates', { credentials: 'same-origin' });
            const data = await res.json();
            if (!res.ok || data.error) throw new Error(data.error || 'Scan failed');

            const groups = data.groups || [];
            document.getElementById('dup-group-count').textContent = data.group_count || 0;
            document.getElementById('dup-redundant-count').textContent = data.duplicate_count || 0;
            summary.style.display = '';
            mergeAllWrap.style.display = groups.some(g => g.can_merge) ? '' : 'none';

            if (!groups.length) {
                results.innerHTML = `<p class="settings-row-hint" style="padding:12px 0;">✓ ${t('No duplicates found. Your library is clean.')}</p>`;
                return;
            }

            results.innerHTML = '';
            for (const group of groups) {
                results.appendChild(this._renderDupGroup(group));
            }
        } catch (e) {
            results.innerHTML = `<p class="settings-row-hint" style="padding:12px 0;color:#ff6b6b;">${t('Error: {message}', { message: this._esc(t(e.message)) })}</p>`;
        } finally {
            btn.disabled = false;
        }
    }

    _renderDupGroup(group) {
        const wrap = document.createElement('div');
        wrap.className = 'dup-group';
        wrap.style.cssText = 'border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:12px;margin-top:12px;';

        const songs = group.songs || [];
        // First song is the suggested keeper (already sorted by score server-side).
        songs.forEach((song, idx) => {
            const row = document.createElement('label');
            row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:6px 0;cursor:pointer;';
            const radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = `dup-keep-${group.key}`;
            radio.value = song.id;
            radio.checked = idx === 0;
            radio.style.accentColor = 'var(--accent-color, #fa586a)';

            const badges = [];
            if (song.likes > 0) badges.push(`♥ ${song.likes}`);
            if (song.dislikes > 0) badges.push(`👎 ${song.dislikes}`);
            if (song.playlist_count > 0) badges.push(`▤ ${song.playlist_count}`);
            if (song.play_count > 0) badges.push(`▶ ${song.play_count}`);

            const info = document.createElement('div');
            info.style.cssText = 'flex:1;min-width:0;';
            info.innerHTML = `
                <div style="color:#fff;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                    ${this._esc(song.title)} ${idx === 0 ? `<span style="color:var(--accent-color,#fa586a);font-size:11px;">${t('(suggested)')}</span>` : ''}
                </div>
                <div style="color:rgba(255,255,255,0.5);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                    ${this._esc(song.artist)} ${badges.length ? '· ' + badges.join(' · ') : ''}
                </div>`;

            row.appendChild(radio);
            row.appendChild(info);
            wrap.appendChild(row);
        });

        if (!group.can_merge) {
            // A merge deletes the other copies for every account, so groups
            // with songs other accounts share are left to an administrator.
            wrap.querySelectorAll('input[type="radio"]').forEach(r => { r.disabled = true; });
            const note = document.createElement('p');
            note.className = 'settings-row-hint';
            note.style.marginTop = '8px';
            note.textContent = t('Other accounts share some of these copies, so only an administrator can merge them.');
            wrap.appendChild(note);
            return wrap;
        }

        const mergeBtn = document.createElement('button');
        mergeBtn.className = 'btn btn-warning';
        mergeBtn.style.marginTop = '8px';
        mergeBtn.innerHTML = `<span>${t('Merge into selected')}</span>`;
        mergeBtn.addEventListener('click', async () => {
            const chosen = wrap.querySelector(`input[name="dup-keep-${CSS.escape(group.key)}"]:checked`);
            const keeperId = chosen ? parseInt(chosen.value, 10) : songs[0].id;
            const extra = songs.length - 1;
            if (!confirm(t('Merge into the selected copy and permanently delete the other {count} files from disk?', { count: extra }))) return;
            mergeBtn.disabled = true;
            mergeBtn.innerHTML = `<span>${t('Merging…')}</span>`;
            try {
                const res = await fetch('/api/music/duplicates/merge', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ song_ids: songs.map(s => s.id), keeper_id: keeperId })
                });
                const data = await res.json();
                if (!res.ok || !data.success) throw new Error(data.error || 'Merge failed');
                this.showToast(t('Merged {count} duplicates', { count: data.removed_count }), 'success');
                this.loadLibrary();
                this.scanDuplicates();
            } catch (e) {
                this.showToast(e.message, 'error');
                mergeBtn.disabled = false;
                mergeBtn.innerHTML = `<span>${t('Merge into selected')}</span>`;
            }
        });
        wrap.appendChild(mergeBtn);
        return wrap;
    }

    async mergeAllDuplicates() {
        const btn = document.getElementById('dup-merge-all-btn');
        if (!confirm(t('Merge every duplicate group into its suggested copy and permanently delete the other files from disk?'))) return;
        btn.disabled = true;
        btn.innerHTML = `<span>${t('Merging…')}</span>`;
        try {
            const res = await fetch('/api/music/duplicates/merge-all', {
                method: 'POST',
                credentials: 'same-origin'
            });
            const data = await res.json();
            if (!res.ok || !data.success) throw new Error(data.error || 'Merge failed');
            this.showToast(t('Merged {groups} groups, removed {songs} songs', { groups: data.groups_merged, songs: data.songs_removed }), 'success');
            this.loadLibrary();
            this.scanDuplicates();
        } catch (e) {
            this.showToast(e.message, 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = `<span>${t('Merge all automatically')}</span>`;
        }
    }

    _esc(str) {
        const div = document.createElement('div');
        div.textContent = str ?? '';
        return div.innerHTML;
    }

    async runScrapeArtists() {
        const btn = document.getElementById('scrape-artists-btn');
        const progress = document.getElementById('scrape-artists-progress');
        const progressBar = document.getElementById('scrape-artists-progress-bar');
        const progressText = document.getElementById('scrape-artists-progress-text');
        const result = document.getElementById('scrape-artists-result');

        btn.disabled = true;
        btn.textContent = t('Running...');
        progress?.classList.remove('hidden');
        result?.classList.add('hidden');
        progressBar.style.width = '0%';
        progressText.textContent = t('Starting...');

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
                            ? t('All artists already have images!')
                            : t('Scraping {current} / {total} artists...', { current: 0, total: msg.total });
                    } else if (msg.type === 'progress') {
                        const pct = Math.round((msg.current / msg.total) * 100);
                        progressBar.style.width = `${pct}%`;
                        progressText.textContent = t('Scraping {current} / {total} — {artist}', { current: msg.current, total: msg.total, artist: msg.artist });
                    } else if (msg.type === 'done') {
                        progress?.classList.add('hidden');
                        document.getElementById('scrape-artists-scraped').textContent = msg.scraped;
                        document.getElementById('scrape-artists-skipped').textContent = msg.skipped;
                        document.getElementById('scrape-artists-failed').textContent = msg.failed;
                        result?.classList.remove('hidden');
                        this.showToast(t('Scraped {count} artist images', { count: msg.scraped }), 'success');
                    } else if (msg.type === 'error') {
                        progressText.textContent = t('Error: {message}', { message: t(msg.error) });
                        this.showToast(t('Scrape failed: {message}', { message: t(msg.error) }), 'error');
                    }
                }
            }
        } catch (e) {
            progressText.textContent = t('Error: {message}', { message: e.message });
            this.showToast(t('Scrape failed: {message}', { message: e.message }), 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = t('Run');
        }
    }

    async runScrapeDescriptions() {
        const btn = document.getElementById('scrape-descriptions-btn');
        const progress = document.getElementById('scrape-descriptions-progress');
        const progressBar = document.getElementById('scrape-descriptions-progress-bar');
        const progressText = document.getElementById('scrape-descriptions-progress-text');
        const result = document.getElementById('scrape-descriptions-result');

        btn.disabled = true;
        btn.textContent = t('Running...');
        progress?.classList.remove('hidden');
        result?.classList.add('hidden');
        progressBar.style.width = '0%';
        progressText.textContent = t('Starting...');

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
                            ? t('All artists already have descriptions!')
                            : t('Scraping {current} / {total} artists...', { current: 0, total: msg.total });
                    } else if (msg.type === 'progress') {
                        const pct = Math.round((msg.current / msg.total) * 100);
                        progressBar.style.width = `${pct}%`;
                        progressText.textContent = t('Scraping {current} / {total} — {artist}', { current: msg.current, total: msg.total, artist: msg.artist });
                    } else if (msg.type === 'done') {
                        progress?.classList.add('hidden');
                        document.getElementById('scrape-descriptions-scraped').textContent = msg.scraped;
                        document.getElementById('scrape-descriptions-skipped').textContent = msg.skipped;
                        document.getElementById('scrape-descriptions-failed').textContent = msg.failed;
                        result?.classList.remove('hidden');
                        this.showToast(t('Scraped {count} artist bios', { count: msg.scraped }), 'success');
                    } else if (msg.type === 'error') {
                        progressText.textContent = t('Error: {message}', { message: t(msg.error) });
                        this.showToast(t('Scrape failed: {message}', { message: t(msg.error) }), 'error');
                    }
                }
            }
        } catch (e) {
            progressText.textContent = t('Error: {message}', { message: e.message });
            this.showToast(t('Scrape failed: {message}', { message: e.message }), 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = t('Run');
        }
    }

    // ==================== Background Import Jobs ====================

    _importJobLabel(job) {
        const source = job.source === 'spotify' ? 'Spotify' : 'YouTube';
        return job.kind === 'playlist'
            ? t('{source} playlist', { source })
            : t('{source} song', { source });
    }

    _importJobSummary(job) {
        if (job.status === 'completed' && job.result) {
            const r = job.result;
            if (job.kind === 'playlist') {
                const failed = r.failed_count ? ` ${t('({count} failed)', { count: r.failed_count })}` : '';
                return `${t('{count} songs', { count: r.song_count ?? 0 })} → "${r.playlist_name || t('playlist')}"${failed}`;
            }
            if (r.already_exists) return t('Already in library: {title}', { title: r.title || t('song') });
            return t('Imported: {title}', { title: `${r.title || t('song')}${r.artist ? ' — ' + r.artist : ''}` });
        }
        if (job.status === 'failed') return t(job.error || 'Import failed');
        if (job.status === 'cancelled') return t('Cancelled');
        return job.message || (job.status === 'queued' ? t('Waiting in queue…') : t('Working…'));
    }

    _importJobRow(job, isQueue) {
        const row = document.createElement('div');
        row.className = `import-job-row import-job-${job.status}`;

        const info = document.createElement('div');
        info.className = 'import-job-info';

        const title = document.createElement('div');
        title.className = 'import-job-title';
        title.textContent = this._importJobLabel(job);

        const badge = document.createElement('span');
        badge.className = `import-job-badge import-job-badge-${job.status}`;
        badge.textContent = t(job.status);
        title.appendChild(badge);

        const summary = document.createElement('div');
        summary.className = 'import-job-summary';
        summary.textContent = this._importJobSummary(job);

        info.appendChild(title);
        info.appendChild(summary);

        // Progress bar for running jobs
        if (job.status === 'running') {
            const bar = document.createElement('div');
            bar.className = 'import-job-progress';
            const fill = document.createElement('div');
            fill.className = 'import-job-progress-fill';
            fill.style.width = `${job.progress || 0}%`;
            bar.appendChild(fill);
            info.appendChild(bar);
        }

        row.appendChild(info);

        // Cancel button for queued jobs
        if (isQueue && job.status === 'queued') {
            const cancel = document.createElement('button');
            cancel.className = 'btn btn-secondary btn-sm import-job-cancel';
            cancel.textContent = t('Cancel');
            cancel.addEventListener('click', () => this.cancelImportJob(job.id));
            row.appendChild(cancel);
        }

        return row;
    }

    async loadImportJobs() {
        const queueEl = document.getElementById('import-jobs-queue');
        const historyEl = document.getElementById('import-jobs-history');
        if (!queueEl || !historyEl) return;

        const data = await useImportJobsService().list();
        if (data.error) {
            Logger.error('Failed to load import jobs', data.error);
            return;
        }

        const { queue = [], history = [] } = data.value || {};

        // Render queue
        queueEl.innerHTML = '';
        if (queue.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'import-jobs-empty';
            empty.textContent = t('No imports running or queued.');
            queueEl.appendChild(empty);
        } else {
            queue.forEach(job => queueEl.appendChild(this._importJobRow(job, true)));
        }

        // Render history (exclude still-active jobs to avoid duplication)
        const activeIds = new Set(queue.map(j => j.id));
        const finished = history.filter(j => !activeIds.has(j.id));
        historyEl.innerHTML = '';
        if (finished.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'import-jobs-empty';
            empty.textContent = t('No completed imports yet.');
            historyEl.appendChild(empty);
        } else {
            finished.forEach(job => historyEl.appendChild(this._importJobRow(job, false)));
        }

        // Keep polling while there's an active job and the Jobs section is open
        const jobsSection = document.getElementById('settings-section-jobs');
        const jobsOpen = jobsSection && jobsSection.classList.contains('active');
        const settingsOpen = !document.getElementById('settings-page').classList.contains('hidden');
        if (queue.length > 0 && jobsOpen && settingsOpen) {
            clearTimeout(this._importJobsPollTimer);
            this._importJobsPollTimer = setTimeout(() => this.loadImportJobs(), 1500);
        }
    }

    _renderLightshowOffset(ms) {
        const el = document.getElementById('settings-lightshow-offset-value');
        if (el) el.textContent = `${ms > 0 ? '+' : ''}${ms} ms`;
    }

    _lightshowJobSummary(job) {
        const r = job.result || {};
        if (job.status === 'completed') {
            if (job.scope === 'backfill') {
                if (!r.total) return t('Every song already had an up-to-date light show');
                return t('{done} of {count} songs analysed', { done: r.analysed ?? 0, count: r.total })
                    + (r.failed ? ` ${t('({count} failed)', { count: r.failed })}` : '');
            }
            if (r.skipped) return r.skipped === 'up to date' ? t('Already up to date') : t('Skipped (song removed)');
            return `${Math.round(r.tempo || 0)} BPM · ${r.genre || 'pop'} · ${t('{count} sections', { count: r.sections ?? 0 })}`;
        }
        if (job.status === 'failed') return t(job.error || 'Analysis failed');
        return job.message || (job.status === 'queued' ? t('Waiting in queue…') : t('Analysing…'));
    }

    _lightshowJobRow(job) {
        const title = job.scope === 'backfill'
            ? (job.force ? t('Full library re-analysis') : t('Library light shows'))
            : t('Song #{id}', { id: job.song_id });
        return this._analysisJobRow(job, title, this._lightshowJobSummary(job));
    }

    _analysisJobRow(job, titleText, summaryText, hint) {
        const row = document.createElement('div');
        row.className = `import-job-row import-job-${job.status}`;
        const info = document.createElement('div');
        info.className = 'import-job-info';
        const title = document.createElement('div');
        title.className = 'import-job-title';
        title.textContent = titleText;
        const badge = document.createElement('span');
        badge.className = `import-job-badge import-job-badge-${job.status}`;
        badge.textContent = t(job.status);
        title.appendChild(badge);
        const summary = document.createElement('div');
        summary.className = 'import-job-summary';
        summary.textContent = summaryText;
        if (hint) summary.title = hint;
        info.appendChild(title);
        info.appendChild(summary);
        if (job.status === 'running') {
            const bar = document.createElement('div');
            bar.className = 'import-job-progress';
            const fill = document.createElement('div');
            fill.className = 'import-job-progress-fill';
            fill.style.width = `${job.progress || 0}%`;
            bar.appendChild(fill);
            info.appendChild(bar);
        }
        row.appendChild(info);
        return row;
    }

    /**
     * Coverage line for an analysis card. The bar only shows while a job is
     * queued/running; once idle it gives way to a plain "all done" / "N of M" line.
     */
    _renderCoverage(id, coverage, active, { noun, note = '' }) {
        const box = document.getElementById(id);
        const bar = document.getElementById(`${id}-bar`);
        const text = document.getElementById(`${id}-text`);
        if (!box || !text) return;
        const { ready, total } = coverage;
        const pct = total ? Math.round((ready / total) * 100) : 0;
        if (bar) bar.style.width = `${pct}%`;
        bar?.parentElement.classList.toggle('hidden', !active);
        let msg;
        // noun is an English template like '{ready} / {total} songs ready'
        const counts = t(noun, { ready, total, count: total });
        if (active) msg = `${t('Analysing…')} ${counts} (${pct}%)`;
        else if (total && ready >= total) msg = `✓ ${t('Done')} — ${counts}`;
        else msg = `${counts} (${pct}%)`;
        text.textContent = note ? `${msg} · ${note}` : msg;
        text.classList.toggle('scan-progress-done', !active && total > 0 && ready >= total);
    }

    _lyricsJobSummary(job) {
        const r = job.result || {};
        if (job.status === 'completed') {
            if (job.scope === 'backfill') {
                if (!r.total) return t('Every song already has word timing');
                const parts = [t('{done} of {count} songs timed', { done: r.aligned ?? 0, count: r.total })];
                if (r.fetched) parts.push(t('{count} lyrics fetched', { count: r.fetched }));
                if (r.no_lyrics) parts.push(t('{count} without synced lyrics', { count: r.no_lyrics }));
                if (r.failed) parts.push(t('{count} failed', { count: r.failed }));
                return parts.join(' · ');
            }
            if (r.skipped) {
                return r.skipped === 'up to date' ? t('Already up to date')
                    : r.skipped === 'no synced lyrics' ? t('No synced lyrics for this song')
                        : t('Skipped (song removed)');
            }
            const parts = [t('{count} lines timed', { count: r.lines ?? 0 })];
            if (r.language) parts.push(r.language);
            if (r.re_aligned) parts.push(t('{count} re-aligned', { count: r.re_aligned }));
            if (r.estimated) parts.push(t('{count} estimated', { count: r.estimated }));
            return parts.join(' · ');
        }
        if (job.status === 'failed') return t(job.error || 'Analysis failed');
        return job.message || (job.status === 'queued' ? t('Waiting in queue…') : t('Analysing…'));
    }

    _lyricsJobRow(job) {
        const title = job.scope === 'backfill'
            ? (job.force ? t('Full library re-timing') : t('Library lyrics'))
            : t('Song #{id}', { id: job.song_id });
        const failures = job.result && job.result.failures;
        const hint = failures && failures.length
            ? failures.map(f => `${f.song}: ${f.error}`).join('\n') : undefined;
        return this._analysisJobRow(job, title, this._lyricsJobSummary(job), hint);
    }

    async loadLyricsJobs() {
        const queueEl = document.getElementById('lyrics-jobs-queue');
        const historyEl = document.getElementById('lyrics-jobs-history');
        if (!queueEl || !historyEl) return;

        const data = await useLyricsService().jobs();
        if (data.error) {
            Logger.error('Failed to load lyrics jobs', data.error);
            return;
        }
        const { queue = [], history = [], coverage = { ready: 0, total: 0, unfetched: 0 } } = data.value || {};

        this._renderCoverage('lyrics-coverage', coverage, queue.length > 0, {
            noun: '{ready} / {total} songs with synced lyrics timed',
            note: coverage.unfetched ? t('{count} not searched yet', { count: coverage.unfetched }) : '',
        });

        const fill = (el, jobs, emptyText) => {
            el.innerHTML = '';
            if (!jobs.length) {
                const empty = document.createElement('div');
                empty.className = 'import-jobs-empty';
                empty.textContent = t(emptyText);
                el.appendChild(empty);
            } else {
                jobs.forEach(job => el.appendChild(this._lyricsJobRow(job)));
            }
        };
        fill(queueEl, queue.slice(0, 6), 'No analysis running or queued.');
        if (queue.length > 6) {
            const more = document.createElement('div');
            more.className = 'import-jobs-empty';
            more.textContent = t('+ {count} more queued', { count: queue.length - 6 });
            queueEl.appendChild(more);
        }
        fill(historyEl, history, 'No lyrics jobs yet.');

        const jobsSection = document.getElementById('settings-section-jobs');
        const jobsOpen = jobsSection && jobsSection.classList.contains('active');
        const settingsOpen = !document.getElementById('settings-page').classList.contains('hidden');
        clearTimeout(this._lyricsJobsPollTimer);
        if (queue.length > 0 && jobsOpen && settingsOpen) {
            this._lyricsJobsPollTimer = setTimeout(() => this.loadLyricsJobs(), 1500);
        }
    }

    async runLyricsBackfill(force) {
        if (force && !confirm(t('Re-time the lyrics of every song? This runs in the background and can take a while on big libraries.'))) return;
        const data = await useLyricsService().backfill(force);
        if (data.error) {
            this.showToast(data.error.error || 'Could not start lyrics analysis', 'error');
            return;
        }
        this.showToast(force ? t("Re-timing every song's lyrics…") : t('Analysing lyrics…'), 'success');
        this.loadLyricsJobs();
    }

    async loadLightshowJobs() {
        const queueEl = document.getElementById('lightshow-jobs-queue');
        const historyEl = document.getElementById('lightshow-jobs-history');
        if (!queueEl || !historyEl) return;

        const data = await useLightshowService().jobs();
        if (data.error) {
            Logger.error('Failed to load light show jobs', data.error);
            return;
        }
        const { queue = [], history = [], coverage = { ready: 0, total: 0 } } = data.value || {};

        this._renderCoverage('lightshow-coverage', coverage, queue.length > 0, { noun: '{ready} / {total} songs ready' });

        const fill = (el, jobs, emptyText) => {
            el.innerHTML = '';
            if (!jobs.length) {
                const empty = document.createElement('div');
                empty.className = 'import-jobs-empty';
                empty.textContent = t(emptyText);
                el.appendChild(empty);
            } else {
                jobs.forEach(job => el.appendChild(this._lightshowJobRow(job)));
            }
        };
        // Single-song jobs from imports can be many; show the first few.
        fill(queueEl, queue.slice(0, 6), 'No analysis running or queued.');
        if (queue.length > 6) {
            const more = document.createElement('div');
            more.className = 'import-jobs-empty';
            more.textContent = t('+ {count} more queued', { count: queue.length - 6 });
            queueEl.appendChild(more);
        }
        fill(historyEl, history, 'No light show jobs yet.');

        const jobsSection = document.getElementById('settings-section-jobs');
        const jobsOpen = jobsSection && jobsSection.classList.contains('active');
        const settingsOpen = !document.getElementById('settings-page').classList.contains('hidden');
        clearTimeout(this._lightshowJobsPollTimer);
        if (queue.length > 0 && jobsOpen && settingsOpen) {
            this._lightshowJobsPollTimer = setTimeout(() => this.loadLightshowJobs(), 1500);
        }
    }

    _enrichJobSummary(job) {
        const r = job.result || {};
        if (job.status === 'completed') {
            if (job.scope === 'backfill') {
                if (!r.total) return t('Every song was already analysed');
                return t('{done} of {count} songs analysed', { done: r.enriched ?? 0, count: r.total })
                    + (r.failed ? ` ${t('({count} failed)', { count: r.failed })}` : '');
            }
            return t('Metadata updated');
        }
        if (job.status === 'failed') return t(job.error || 'Analysis failed');
        return job.message || (job.status === 'queued' ? t('Waiting in queue…') : t('Analysing…'));
    }

    _enrichJobRow(job) {
        const title = job.scope === 'backfill'
            ? (job.force ? t('Full library re-analysis') : t('Library metadata'))
            : t('Song #{id}', { id: job.song_id });
        return this._analysisJobRow(job, title, this._enrichJobSummary(job));
    }

    async loadEnrichJobs() {
        const queueEl = document.getElementById('enrich-jobs-queue');
        const historyEl = document.getElementById('enrich-jobs-history');
        if (!queueEl || !historyEl) return;

        const data = await useEnrichmentService().status();
        if (data.error) {
            Logger.error('Failed to load metadata jobs', data.error);
            return;
        }
        const { queue = [], history = [] } = data.value || {};

        const fill = (el, jobs, emptyText) => {
            el.innerHTML = '';
            if (!jobs.length) {
                const empty = document.createElement('div');
                empty.className = 'import-jobs-empty';
                empty.textContent = t(emptyText);
                el.appendChild(empty);
            } else {
                jobs.forEach(job => el.appendChild(this._enrichJobRow(job)));
            }
        };
        // Single-song jobs from scans/imports can be many; show the first few.
        fill(queueEl, queue.slice(0, 6), 'No analysis running or queued.');
        if (queue.length > 6) {
            const more = document.createElement('div');
            more.className = 'import-jobs-empty';
            more.textContent = t('+ {count} more queued', { count: queue.length - 6 });
            queueEl.appendChild(more);
        }
        // The history endpoint also lists still-active jobs; don't show them twice.
        fill(historyEl, history.filter(j => j.status !== 'queued' && j.status !== 'running'),
            'No analysis jobs yet.');

        const jobsSection = document.getElementById('settings-section-jobs');
        const jobsOpen = jobsSection && jobsSection.classList.contains('active');
        const settingsOpen = !document.getElementById('settings-page').classList.contains('hidden');
        clearTimeout(this._enrichJobsPollTimer);
        if (queue.length > 0 && jobsOpen && settingsOpen) {
            this._enrichJobsPollTimer = setTimeout(() => this.loadEnrichJobs(), 1500);
        }
    }

    async runEnrichBackfill(force) {
        if (force && !confirm(t('Re-analyse the metadata of every song? This runs in the background and can take a long time on big libraries.'))) return;
        const data = await useEnrichmentService().backfill(force);
        if (data.error) {
            this.showToast(data.error.error || 'Could not start metadata analysis', 'error');
            return;
        }
        this.showToast(force ? t('Re-analysing every song…') : t('Analysing songs without metadata…'), 'success');
        this.loadEnrichJobs();
    }

    _renderYtdlpStatus(st) {
        const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
        if (!st) return;
        const ver = st.installed || t('not installed');
        let verText = ver;
        if (st.latest) verText += st.up_to_date ? ` ${t('(up to date)')}` : ` ${t('(latest: {version})', { version: st.latest })}`;
        if (st.updating) verText += ` · ${t('updating…')}`;
        set('ytdlp-version', verText);
        set('ytdlp-runtime', st.ejs && st.js_runtime
            ? t('Ready ({runtime})', { runtime: st.js_runtime })
            : !st.js_runtime ? t('No JS runtime found — install Deno or Node.js') : t('Solver missing — click Update now'));
        const u = st.last_update;
        if (u) {
            const when = new Date(u.at * 1000).toLocaleString();
            set('ytdlp-last-update', u.ok
                ? (u.from === u.to ? `${when} · ${t('already current')}` : `${when} · ${u.from} → ${u.to}`)
                : `${when} · ${t('failed: {message}', { message: (u.error || '').slice(0, 120) })}`);
        } else {
            set('ytdlp-last-update', st.last_check
                ? t('Checked {date}', { date: new Date(st.last_check * 1000).toLocaleString() })
                : t('Not checked yet'));
        }
    }

    async loadYtdlpStatus() {
        try {
            const res = await fetch('/api/music/ytdlp/status');
            if (!res.ok) return;
            const data = await res.json();
            this._renderYtdlpStatus(data.ytdlp);
        } catch (e) {
            Logger.error('Failed to load yt-dlp status', e);
        }
    }

    async updateYtdlp() {
        const btn = document.getElementById('ytdlp-update-btn');
        if (btn) { btn.disabled = true; btn.textContent = t('Updating…'); }
        try {
            const res = await fetch('/api/music/ytdlp/update', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            const data = await res.json().catch(() => ({}));
            this._renderYtdlpStatus(data.ytdlp);
            if (res.ok) {
                const u = data.ytdlp && data.ytdlp.last_update;
                this.showToast(u && u.from !== u.to ? t('yt-dlp updated to {version}', { version: u.to }) : t('yt-dlp is up to date'), 'success');
            } else {
                this.showToast(data.error ? t('yt-dlp update failed: {message}', { message: data.error.slice(0, 120) }) : t('yt-dlp update failed'), 'error');
            }
        } catch (e) {
            this.showToast('yt-dlp update failed', 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = t('Update now'); }
        }
    }

    async runLightshowBackfill(force) {
        if (force && !confirm(t('Re-analyse the light show of every song? This runs in the background and can take a while on big libraries.'))) return;
        const data = await useLightshowService().backfill(force);
        if (data.error) {
            this.showToast(data.error.error || 'Could not start light show analysis', 'error');
            return;
        }
        this.showToast(force ? t('Re-analysing every light show…') : t('Analysing missing light shows…'), 'success');
        this.loadLightshowJobs();
    }

    async cancelImportJob(jobId) {
        const data = await useImportJobsService().cancel(jobId);
        if (data.error) {
            this.showToast(data.error.error || 'Could not cancel job', 'error');
        } else {
            this.showToast('Import cancelled', 'success');
        }
        this.loadImportJobs();
    }

    /**
     * @param {{ silent?: boolean }} [options] - silent: background refresh
     *  (no loading state, keeps the current view, search, sort and scroll)
     * @returns {Promise<boolean>} whether the library was loaded
     */
    async loadLibrary({ silent = false } = {}) {
        const loadingState = document.getElementById('loading-state');
        const emptyState = document.getElementById('empty-state');
        const songsGrid = document.getElementById('songs-grid');

        if (!silent) {
            loadingState.classList.remove('hidden');
            emptyState.classList.add('hidden');
            songsGrid.innerHTML = '';
            document.getElementById('songs-list-content').innerHTML = '';
        }

        const data = await useMusicService().library();
        if (data.error) {
            if (silent) {
                Logger.warn('Background library refresh failed', data.error);
                return false;
            }
            Logger.error('Failed to load music libary!', data.error);
            loadingState.classList.add('hidden');
            emptyState.classList.remove('hidden');

            return;
        }

        const library = data.value;
        if (!library) throw new Error('unreachable');
        this.libraryWatcher.noteSongsVersion(library.version);
        if (silent) {
            this.applyLibraryUpdate(library);
            return true;
        }
        loadingState.classList.add('hidden');

        const allSongs = library.all_songs;
        if (allSongs && allSongs.length > 0) {
            this.songs = allSongs;
            this.librarySongs = [...this.songs];
            useContext().set('current-view-type', 'library');
            this.sections = library.sections || [];
            this.librarySections = JSON.parse(JSON.stringify(this.sections));
            this.filteredSongs = [...this.songs];
            this.updateViewModeControls();
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

            return true;
        }

        emptyState.classList.remove('hidden');
        return true;
    }

    /**
     * Swap in a library fetched in the background without the loading
     * flash. Only re-renders when the Library view is on screen, and keeps
     * the user's place there: search filter, sort and scroll position.
     * Other views pick the new songs up when the user returns to Library.
     * @param {import('./services/music.js').LibraryModel} library
     */
    applyLibraryUpdate(library) {
        const allSongs = library.all_songs || [];
        this.librarySongs = [...allSongs];
        this.librarySections = JSON.parse(JSON.stringify(library.sections || []));

        if (useContext().get('current-view-type') !== 'library') return;

        const main = document.querySelector('.app-main');
        const scrollTop = main?.scrollTop ?? 0;

        this.songs = allSongs;
        this.sections = library.sections || [];
        this.filteredSongs = [...this.songs];

        document.getElementById('loading-state').classList.add('hidden');
        document.getElementById('empty-state').classList.toggle('hidden', allSongs.length > 0);
        if (allSongs.length === 0) {
            document.getElementById('songs-grid').innerHTML = '';
            document.getElementById('songs-list-content').innerHTML = '';
        } else if (this.currentSort !== 'default') {
            this.applySortFilter(this.currentSort); // re-sorts, then renders
        } else {
            this.renderSections();
        }

        const query = document.getElementById('search-input')?.value || '';
        if (query.trim()) {
            this.handleSearch(query); // re-applies the filter and stats
        } else {
            this.updateViewModeControls();
            this.updateStats();
        }

        if (main) main.scrollTop = scrollTop;
        this.refreshLibraryQueue();
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
            card.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                if (e.target.closest('.song-menu-btn')) return;
                e.preventDefault();
                card.click();
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
            let songData = menuBtn ? menuBtn.dataset : {
                songId: songElement.dataset.id,
                songTitle: songElement.querySelector('.song-title, .track-title')?.textContent || '',
                songArtist: songElement.querySelector('.song-artist, .track-artists')?.textContent || ''
            };
            // Prefer the FULL library song object (cover, duration, album,
            // genre) — the DOM fallback is a shell and loses details the
            // context menu actions need (bug fixed Aug 2026).
            const full = this.librarySongs.find(s => String(s.id) === String(songData.songId));
            if (full) {
                songData = {
                    songId: full.id,
                    songTitle: full.title,
                    songArtist: full.artist,
                    songAlbum: full.album || '',
                    songDuration: full.duration || 0,
                    songCover: (full.cover_path || full.cover || '').replace(/\\/g, '/') || null,
                    songGenre: full.genre || null,
                };
            }

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
            title: t('Search Results'),
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
            card.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                if (e.target.closest('.song-menu-btn')) return;
                e.preventDefault();
                card.click();
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
            row.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                if (e.target.closest('.song-menu-btn')) return;
                e.preventDefault();
                row.click();
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

        // Enable drag-and-drop reordering when viewing a playlist in list mode
        // (only if the viewer may edit it — viewers get read-only rows).
        if (useContext().get('current-view-type') === 'playlist' && this.currentPlaylistId
                && this.currentPlaylistCanEdit()) {
            this.enablePlaylistDragDrop(listContent);
        }
    }

    /**
     * Enable HTML5 drag-and-drop reordering of playlist song rows.
     * @param {HTMLElement} container - The list content container with .song-row children
     */
    enablePlaylistDragDrop(container) {
        const rows = Array.from(container.querySelectorAll('.song-row'));
        let dragSrcEl = null;

        rows.forEach(row => {
            row.setAttribute('draggable', 'true');
            row.classList.add('draggable-row');

            row.addEventListener('dragstart', (e) => {
                dragSrcEl = row;
                row.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', row.dataset.index || '');
            });

            row.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const target = e.currentTarget;
                if (target === dragSrcEl) return;
                const rect = target.getBoundingClientRect();
                const midpoint = rect.top + rect.height / 2;
                if (e.clientY < midpoint) {
                    container.insertBefore(dragSrcEl, target);
                } else {
                    container.insertBefore(dragSrcEl, target.nextSibling);
                }
            });

            row.addEventListener('dragend', () => {
                row.classList.remove('dragging');
                rows.forEach(r => r.classList.remove('drag-over'));
                this.persistPlaylistOrder(container);
            });
        });
    }

    /**
     * Read the current DOM order of song rows and persist it to the backend.
     * @param {HTMLElement} container
     */
    async persistPlaylistOrder(container) {
        const orderedIds = Array.from(container.querySelectorAll('.song-row'))
            .map(row => parseInt(row.dataset.id))
            .filter(id => !isNaN(id));

        if (!orderedIds.length || !this.currentPlaylistId) return;

        try {
            const res = await usePlaylistService().reorder(this.currentPlaylistId, orderedIds);
            if (res.error) {
                Logger.error('Failed to reorder playlist:', res.error);
                window.showToast?.(res.error?.error || res.error?.message || 'Failed to save order', 'error');
            } else {
                window.showToast?.('Playlist order saved', 'success');
            }
        } catch (e) {
            Logger.error('Reorder error:', e);
        }
    }

    setViewMode(mode) {
        if (mode !== 'grid' && mode !== 'list') return;
        this.currentViewMode = mode;
        localStorage.setItem('rainy_library_view_mode', mode);

        this.updateViewModeControls();

        // Re-render with sections
        if (this.sections && this.sections.length > 0) {
            this.renderSections();
        } else {
            this.renderSongs();
        }
    }

    updateViewModeControls() {
        const gridViewBtn = document.getElementById('grid-view-btn');
        const listViewBtn = document.getElementById('list-view-btn');
        const isGrid = this.currentViewMode === 'grid';

        // Update toggle buttons
        gridViewBtn?.classList.toggle('active', isGrid);
        listViewBtn?.classList.toggle('active', !isGrid);
        gridViewBtn?.setAttribute('aria-pressed', String(isGrid));
        listViewBtn?.setAttribute('aria-pressed', String(!isGrid));
    }

    handleSearch(query) {
        const searchTerm = query.toLowerCase().trim();
        if (!searchTerm && useContext().get('current-view-type') !== 'library') return;

        // The header search belongs to Library, never to the currently open
        // feature panel or playlist. Route first to hide it and restore all songs.
        if (searchTerm && useContext().get('current-view-type') !== 'library') {
            this.switchToLibraryView();
            // Library navigation normally clears the header search.
            document.getElementById('search-input').value = query;
        }

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
                // Normalize by lowercasing so casing variants (e.g. "Radiohead"
                // / "radiohead") count as one artist, matching the artists grid.
                if (trimmed) artistSet.add(trimmed.toLowerCase());
            });
        });
        const artists = artistSet.size;
        const albums = new Set(songs.map(s => s.album)).size;

        document.getElementById('stat-songs').textContent = songs.length;
        document.getElementById('stat-artists').textContent = artists;
        document.getElementById('stat-albums').textContent = albums;

        document.getElementById('library-subtitle').textContent =
            this.filteredSongs.length === this.songs.length
                ? t('All your music in one place')
                : t('Showing {shown} of {count} songs', { shown: this.filteredSongs.length, count: this.songs.length });
    }

    /** Stop playback and background polling tied to the current session. */
    teardownSession() {
        window.player?.shutdownSession();
        this.libraryWatcher.stop();
        window.friendsModule?.stop();
        this.user = null;
        this.songs = [];
        this.filteredSongs = [];
    }

    async handleLogout() {
        const result = await useAuthService().logout();
        if (result?.error) {
            // The server-side session may still be alive; tell the user
            // rather than pretending they are signed out.
            this.showToast('Could not log out. Please try again.', 'error');
            return;
        }

        this.teardownSession();
        Router.navigate(new View('login'), this);
    }

    /** A request came back 401 while signed in: the session expired. */
    handleSessionExpired() {
        if (!this.user) return;
        this.teardownSession();
        this.showToast('Your session expired. Please sign in again.', 'error');
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
            artist: songData.songArtist,
            album: songData.songAlbum || '',
            duration: Number(songData.songDuration) || 0,
            cover_path: songData.songCover || null,
            genre: songData.songGenre || null,
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
        return true;
    }

    /**
     * Background refresh after playlists changed elsewhere: update the
     * sidebar and the open playlist, if any.
     * @returns {Promise<boolean>} whether the playlists were refreshed
     */
    async refreshPlaylists() {
        if (!(await this.loadPlaylists())) return false;
        await this.refreshOpenPlaylist();
        return true;
    }

    /** Re-fetch the open playlist and re-render it in place if it changed. */
    async refreshOpenPlaylist() {
        const playlistId = this.currentPlaylistId;
        const isOpen = () => useContext().get('current-view-type') === 'playlist' &&
            this.currentPlaylistId === playlistId;
        if (playlistId == null || !isOpen()) return;

        const data = await usePlaylistService().fetch(playlistId);
        if (!isOpen()) return; // the user navigated away meanwhile
        if (data.error) {
            // Deleted, or access revoked, from another device/user.
            if (this.user && !(data.error instanceof ResponseError)) {
                this.showToast('This playlist is no longer available', 'error');
                this.switchToLibraryView();
            }
            return;
        }

        const playlist = data.value;
        if (!playlist) return;

        const title = document.querySelector('.section-title');
        const sameSongs = playlist.songs.length === this.songs.length &&
            playlist.songs.every((song, i) => song.id === this.songs[i]?.id);
        if (sameSongs && title?.textContent === playlistDisplayName(playlist.name)) return;

        const main = document.querySelector('.app-main');
        const scrollTop = main?.scrollTop ?? 0;

        if (title) title.textContent = playlistDisplayName(playlist.name);
        document.getElementById('library-subtitle').textContent = t('{count} songs', { count: playlist.songs.length });

        this.songs = playlist.songs;
        this.filteredSongs = [...playlist.songs];
        this.sections = [{
            type: 'grid',
            title: t('Playlist Songs'),
            songs: this.songs
        }];
        this.renderSections();

        if (main) main.scrollTop = scrollTop;
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
            <button type="button" class="icon-picker-btn ${id === selectedIcon ? 'selected' : ''}" data-icon="${id}" title="${Utils.escapeHtml(t(icon.name))}">
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
            this.showToast(data.error.error || data.error.message || 'Failed to update playlist icon', 'error');
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
            this.showToast(data.error.error || data.error.message || 'Failed to rename playlist', 'error');

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
            this.showToast(data.error.error || data.error.message || 'Failed to delete playlist', 'error');

            return;
        }

        /** @type {import('./components/modal.js').Modal} */
        const modal = document.getElementById('delete-playlist-modal');
        modal.hide();

        await this.loadPlaylists();
        this.switchToLibraryView();
        this.showToast('Playlist deleted', 'success');
    }

    async openPlaylist(playlistId, { updateUrl = true } = {}) {
        if (updateUrl) {
            return this.navigateTo(`/playlists/${encodeURIComponent(playlistId)}`);
        }

        const data = await usePlaylistService().fetch(playlistId);
        if (data.error) {
            this.showToast(data.error.error || data.error.message || 'Could not open playlist', 'error');
            return Logger.error(data.error);
        }

        const playlist = data.value;
        if (!playlist) return Logger.error('unreachable');

        useContext().set('current-view-type', 'playlist');
        this.currentPlaylistId = playlistId;

        // Hide other views and reset
        document.getElementById('discover-view')?.classList.add('hidden');
        document.getElementById('artists-view')?.classList.add('hidden');
        document.getElementById('friends-view')?.classList.add('hidden');
        window.newViews?.hideNewViews();
        document.querySelector('.view-toggle')?.classList.remove('hidden');
        
        // Show section header
        document.querySelector('.section-header')?.classList.remove('hidden');

        document.querySelectorAll('.app-sidebar .nav-item').forEach(el => el.classList.remove('active'));
        this.renderSidebarPlaylists();

        document.querySelector('.section-title').textContent = playlistDisplayName(playlist.name);
        document.getElementById('library-subtitle').textContent = t('{count} songs', { count: playlist.songs.length });
        document.getElementById('library-stats').classList.add('hidden');

        document.getElementById('playlist-menu-container').classList.remove('hidden');

        this.songs = playlist.songs;
        this.filteredSongs = [...playlist.songs];

        this.sections = [{
            type: 'grid',
            title: t('Playlist Songs'),
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

        // Sharing actions depend on the viewer's role:
        // owner → invite/revoke friends + delete; admin → edit content
        // + leave; viewer → leave only, no edit controls.
        const role = playlist.role || null;
        const ownerId = playlist.owner_user_id ?? null;
        this.currentPlaylistRole = role;
        this.currentPlaylistOwnerId = ownerId;
        const canEdit = role === 'owner' || role === 'admin' ||
            (role === null && ownerId === null); // legacy ownerless playlists stay editable
        const isSysadmin = this.user?.role === 'sysadmin';
        document.getElementById('action-share-playlist')?.classList.toggle('hidden', role !== 'owner');
        document.getElementById('action-leave-playlist')?.classList.toggle('hidden', !(role && role !== 'owner'));
        ['action-edit-playlist-icon', 'action-rename-playlist', 'action-regen-cover'].forEach(id => {
            document.getElementById(id)?.classList.toggle('hidden', !canEdit);
        });
        document.getElementById('action-delete-playlist')?.classList.toggle(
            'hidden', !(role === 'owner' || (ownerId === null && isSysadmin)));
        if (isLiked) {
            document.getElementById('action-share-playlist')?.classList.add('hidden');
            document.getElementById('action-leave-playlist')?.classList.add('hidden');
        }
    }

    /**
     * Can the current user edit the playlist currently open? Mirrors the
     * backend's can_edit: owner/admin yes, viewer no, legacy ownerless yes.
     */
    currentPlaylistCanEdit() {
        const role = this.currentPlaylistRole ?? null;
        const ownerId = this.currentPlaylistOwnerId ?? null;
        return role === 'owner' || role === 'admin' ||
            (role === null && ownerId === null);
    }

    /**
     * Friends view — the social layer (friend requests, playlist invites).
     */
    openFriendsView({ updateUrl = true } = {}) {
        if (updateUrl) {
            return this.navigateTo('/friends');
        }

        if (useContext().get('current-view-type') === 'friends') {
            // Re-entry: still refresh data so invites/requests stay current.
            window.friendsModule?.refresh();
            return;
        }

        useContext().set('current-view-type', 'friends');
        this.currentPlaylistId = null;

        // Hide other views and reset (order matters: hideNewViews also
        // hides friends-view, so it must run BEFORE we show ours)
        window.newViews?.hideNewViews();
        document.getElementById('discover-view')?.classList.add('hidden');
        document.getElementById('artists-view')?.classList.add('hidden');
        document.getElementById('friends-view')?.classList.remove('hidden');
        document.querySelector('.view-toggle')?.classList.add('hidden');

        // Hide playback chrome / list states
        document.getElementById('songs-grid')?.classList.add('hidden');
        document.getElementById('songs-list')?.classList.add('hidden');
        document.getElementById('empty-state')?.classList.add('hidden');
        document.getElementById('loading-state')?.classList.add('hidden');

        // Show section header
        document.querySelector('.section-header')?.classList.remove('hidden');
        document.querySelector('.section-title').textContent = t('Friends');
        document.getElementById('library-subtitle').textContent = t('Collaborate on playlists together');
        document.getElementById('library-stats').classList.add('hidden');
        document.getElementById('playlist-menu-container').classList.add('hidden');

        // Update Sidebar UI
        document.querySelectorAll('.app-sidebar .nav-item').forEach(el => el.classList.remove('active'));
        document.getElementById('nav-friends')?.classList.add('active');
        this.renderSidebarPlaylists();

        // Refresh the data behind the view
        window.friendsModule?.refresh();
    }

    switchToLibraryView({ updateUrl = true } = {}) {
        if (updateUrl) {
            return this.navigateTo('/library');
        }

        if (useContext().get('current-view-type') === 'library') return;

        useContext().set('current-view-type', 'library')
        this.currentPlaylistId = null;

        // Hide other views and reset
        document.getElementById('discover-view')?.classList.add('hidden');
        document.getElementById('artists-view')?.classList.add('hidden');
        document.getElementById('friends-view')?.classList.add('hidden');
        window.newViews?.hideNewViews();
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
        document.querySelector('.section-title').textContent = t('Your Library');
        const totalSongs = this.songs.length;
        document.getElementById('library-subtitle').textContent = t('All your music in one place');

        // Hide playlist settings menu
        document.getElementById('playlist-menu-container').classList.add('hidden');

        // Show Stats
        document.getElementById('library-stats').classList.remove('hidden');
        document.getElementById('stat-songs').textContent = totalSongs;

        // Clear search
        document.getElementById('search-input').value = '';

        this.renderSections();
    }

    switchToDiscoverView(query = null, { updateUrl = true } = {}) {
        if (updateUrl) {
            const params = new URLSearchParams();
            if (query) params.set('q', query);
            const suffix = params.toString() ? `?${params.toString()}` : '';
            return this.navigateTo(`/discover${suffix}`);
        }

        // Pause discover audio preview if it exists
        const previewAudio = document.getElementById('discover-preview-audio');
        if (previewAudio) {
            previewAudio.pause();
            previewAudio.src = '';
            document.getElementById('discover-preview-bar')?.classList.add('hidden');
        }

        useContext().set('current-view-type', 'discover');
        this.currentPlaylistId = null;

        // Hide new-feature views so they don't linger
        window.newViews?.hideNewViews();
        document.getElementById('friends-view')?.classList.add('hidden');

        // Update Sidebar UI
        document.querySelectorAll('.app-sidebar .nav-item').forEach(el => el.classList.remove('active'));
        document.getElementById('nav-discover')?.classList.add('active');
        this.renderSidebarPlaylists();

        // Update Header
        document.querySelector('.section-title').textContent = t('Discover Music');
        document.getElementById('library-subtitle').textContent = t('Search and preview from YouTube Music');

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
                this.showToast(t('Search failed: {message}', { message: t(data.error.error || 'Unknown error') }), 'error');
                return;
            }

            const results = data.value || [];
            if (results.length === 0) {
                empty.classList.remove('hidden');
                return;
            }

            this.renderDiscoverResults(results);
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

    /** Render a list of discover search results. */
    renderDiscoverResults(songs) {
        const resultsList = document.getElementById('discover-results');
        const empty = document.getElementById('discover-empty');
        const searchInput = document.getElementById('discover-search-input');
        if (!resultsList) return;

        resultsList.innerHTML = '';
        empty.classList.add('hidden');

        if (!songs || songs.length === 0) {
            empty.classList.remove('hidden');
            return;
        }

        songs.forEach(song => {
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
                if (searchInput) {
                    searchInput.value = song.artist;
                    document.getElementById('discover-search-btn')?.click();
                }
            });

            artistAlbum.appendChild(artistSpan);
            artistAlbum.appendChild(document.createTextNode(` • ${song.album || t('Single')}`));

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
            previewBtn.textContent = alreadyDownloaded ? t('Play') : t('Preview');
            previewBtn.addEventListener('click', () => {
                const currentMatch = this.isSongInLibrary(song);
                if (currentMatch) {
                    if (window.player) {
                        const previewAudio = document.getElementById('discover-preview-audio');
                        const previewBar = document.getElementById('discover-preview-bar');
                        if (previewAudio && !previewAudio.paused) {
                            previewAudio.pause();
                            previewAudio.src = '';
                            previewBar?.classList.add('hidden');
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
                downloadBtn.textContent = t('In Library');
                downloadBtn.disabled = true;
            } else {
                downloadBtn.textContent = t('Download');
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
    }

    // ==================== Playlist Sync (Settings -> Playlist Sync) ====================

    initPlaylistSyncs() {
        const refreshBtn = document.getElementById('syncs-refresh-btn');
        const createBtn = document.getElementById('sync-create-btn');
        const sourceGroup = document.getElementById('sync-source-group');
        const histRefresh = document.getElementById('syncs-history-refresh-btn');
        refreshBtn?.addEventListener('click', () => { this.loadPlaylistSyncs(); this.loadSyncHistory(); });
        histRefresh?.addEventListener('click', () => this.loadSyncHistory());
        createBtn?.addEventListener('click', () => this.createPlaylistSync());
        sourceGroup?.querySelectorAll('.settings-radio-item').forEach(item => {
            item.addEventListener('click', () => {
                sourceGroup.querySelectorAll('.settings-radio-item').forEach(i => i.classList.remove('selected'));
                item.classList.add('selected');
            });
        });
    }

    async loadPlaylistSyncs() {
        const listEl = document.getElementById('syncs-list');
        const emptyEl = document.getElementById('syncs-empty');
        const selectEl = document.getElementById('sync-playlist-select');
        if (!listEl) return;

        // Populate playlist dropdown
        try {
            const plData = await usePlaylistService().all();
            if (selectEl && !plData.error && plData.value) {
                const currentVal = selectEl.value;
                selectEl.innerHTML = '';
                const playlists = Array.isArray(plData.value) ? plData.value : (plData.value.playlists || []);
                playlists.forEach(p => {
                    const opt = document.createElement('option');
                    opt.value = p.id;
                    opt.textContent = playlistDisplayName(p.name)
                        + (p.song_count != null ? ` (${t('{count} tracks', { count: p.song_count })})` : '');
                    selectEl.appendChild(opt);
                });
                if (currentVal) selectEl.value = currentVal;
                if (!selectEl.value && playlists.length === 0) {
                    const opt = document.createElement('option');
                    opt.value = '';
                    opt.textContent = t('No playlists yet — create one first');
                    opt.disabled = true;
                    opt.selected = true;
                    selectEl.appendChild(opt);
                }
            }
        } catch (_) {}

        listEl.innerHTML = `<div class="import-jobs-empty">${t('Loading syncs…')}</div>`;
        if (emptyEl) emptyEl.style.display = 'none';

        try {
            const res = await fetch('/api/playlist-syncs', { credentials: 'same-origin' });
            const data = await res.json();
            if (!res.ok || !data.success) throw new Error(data.error || 'Failed to load syncs');
            const syncs = data.syncs || [];
            if (syncs.length === 0) {
                listEl.innerHTML = '';
                if (emptyEl) emptyEl.style.display = '';
                return;
            }
            if (emptyEl) emptyEl.style.display = 'none';
            listEl.innerHTML = '';
            syncs.forEach(s => listEl.appendChild(this._renderSyncRow(s)));
        } catch (e) {
            listEl.innerHTML = `<div class="import-jobs-empty" style="color:#f87171;">${this._esc(t('Error: {message}', { message: t(e.message) }))}</div>`;
        }
    }

    _renderSyncRow(s) {
        const wrap = document.createElement('div');
        wrap.className = 'import-job-row';
        wrap.style.flexDirection = 'column';
        wrap.style.alignItems = 'stretch';
        wrap.style.gap = '0';

        const intervalLabel = (() => {
            const h = parseInt(s.interval_hours, 10);
            if (h === 1) return t('Every hour');
            if (h < 24) return t('Every {count} hours', { count: h });
            if (h === 24) return t('Daily');
            if (h === 48) return t('Every 2 days');
            if (h === 72) return t('Every 3 days');
            if (h === 168) return t('Weekly');
            return t('Every {count} hours', { count: h });
        })();
        const sourceBadge = s.source === 'spotify' ? 'Spotify' : 'YouTube';
        const modeBadge = s.sync_mode === 'mirror' ? t('Mirror') : t('Add only');
        const statusColor = s.last_status === 'success' ? '#4ade80' : s.last_status === 'failed' ? '#f87171' : s.last_status === 'running' ? '#60a5fa' : 'var(--text-tertiary)';
        const enabled = !!s.enabled;
        const nextSync = s.next_sync_at ? new Date(s.next_sync_at).toLocaleString() : '—';
        const lastSync = s.last_synced_at ? new Date(s.last_synced_at).toLocaleString() : t('Never');

        wrap.innerHTML = `
            <div class="sync-row-layout">
                <div class="sync-row-info">
                    <div class="sync-row-title">
                        <span>${this._esc(playlistDisplayName(s.playlist_name) || t('Playlist #{id}', { id: s.playlist_id }))}</span>
                        <span class="import-job-badge" style="background:rgba(61,125,196,0.12); color:var(--accent-primary);">${sourceBadge}</span>
                        <span class="import-job-badge">${modeBadge}</span>
                        <span class="import-job-badge" style="color:${statusColor}; border:1px solid ${statusColor}33; background:${statusColor}14;">${this._esc(t(s.last_status || 'pending'))}</span>
                    </div>
                    <div class="sync-row-meta">
                        <span>${this._esc(intervalLabel)}</span> · ${this._esc(t('Next: {date}', { date: nextSync }))} · ${this._esc(t('Last: {date}', { date: lastSync }))}
                    </div>
                    ${s.last_message ? `<div class="sync-row-message">${this._esc(s.last_message)}</div>` : ''}
                    <div class="sync-row-url">${this._esc(s.url)}</div>
                </div>
                <div class="sync-row-actions">
                    <label class="toggle-switch" title="${this._esc(t('Enabled'))}">
                        <input type="checkbox" class="sync-enabled-toggle" data-sync-id="${s.id}" ${enabled ? 'checked' : ''}>
                        <span class="toggle-slider"></span>
                    </label>
                    <button class="btn btn-secondary btn-sm sync-run-btn" data-sync-id="${s.id}">${t('Run now')}</button>
                    <button class="btn btn-secondary btn-sm sync-delete-btn" data-sync-id="${s.id}" style="color:var(--error);">${t('Delete')}</button>
                </div>
            </div>
            <div class="sync-row-fields">
                <select class="form-input sync-interval-select" data-sync-id="${s.id}">
                    <option value="1" ${s.interval_hours==1?'selected':''}>${t('1 hour')}</option>
                    <option value="3" ${s.interval_hours==3?'selected':''}>${t('3 hours')}</option>
                    <option value="6" ${s.interval_hours==6?'selected':''}>${t('6 hours')}</option>
                    <option value="12" ${s.interval_hours==12?'selected':''}>${t('12 hours')}</option>
                    <option value="24" ${s.interval_hours==24?'selected':''}>${t('24 hours (daily)')}</option>
                    <option value="48" ${s.interval_hours==48?'selected':''}>${t('48 hours')}</option>
                    <option value="72" ${s.interval_hours==72?'selected':''}>${t('3 days')}</option>
                    <option value="168" ${s.interval_hours==168?'selected':''}>${t('7 days (weekly)')}</option>
                </select>
                <select class="form-input sync-mode-select" data-sync-id="${s.id}">
                    <option value="mirror" ${s.sync_mode==='mirror'?'selected':''}>${this._esc(t('Mirror — add & remove'))}</option>
                    <option value="add_only" ${s.sync_mode==='add_only'?'selected':''}>${t('Add only')}</option>
                </select>
            </div>
        `;

        // Wire events
        const toggle = wrap.querySelector('.sync-enabled-toggle');
        toggle?.addEventListener('change', async (e) => {
            const id = parseInt(e.target.dataset.syncId, 10);
            try {
                const res = await fetch(`/api/playlist-syncs/${id}`, {
                    method: 'PUT', credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled: e.target.checked })
                });
                const d = await res.json();
                if (!res.ok) throw new Error(d.error || 'Update failed');
                this.showToast(e.target.checked ? t('Sync enabled') : t('Sync disabled'), 'success');
            } catch (err) {
                this.showToast(err.message, 'error');
                e.target.checked = !e.target.checked;
            }
        });

        const runBtn = wrap.querySelector('.sync-run-btn');
        runBtn?.addEventListener('click', async (e) => {
            const id = parseInt(e.target.dataset.syncId, 10);
            e.target.disabled = true;
            e.target.textContent = t('Syncing…');
            try {
                const res = await fetch(`/api/playlist-syncs/${id}/run`, { method: 'POST', credentials: 'same-origin' });
                const d = await res.json();
                if (!res.ok || !d.success) throw new Error(d.error || 'Sync failed');
                this.showToast(t('Synced: +{added} -{removed}', { added: d.result.added, removed: d.result.removed }), 'success');
                this.loadPlaylistSyncs();
                this.loadSyncHistory();
                this.loadPlaylists?.();
            } catch (err) {
                this.showToast(err.message, 'error');
                e.target.disabled = false;
                e.target.textContent = t('Run now');
            }
        });

        const delBtn = wrap.querySelector('.sync-delete-btn');
        delBtn?.addEventListener('click', async (e) => {
            const id = parseInt(e.target.dataset.syncId, 10);
            if (!confirm(t('Delete this sync? The playlist itself will not be deleted.'))) return;
            try {
                const res = await fetch(`/api/playlist-syncs/${id}`, { method: 'DELETE', credentials: 'same-origin' });
                const d = await res.json();
                if (!res.ok) throw new Error(d.error || 'Delete failed');
                this.showToast('Sync deleted', 'success');
                this.loadPlaylistSyncs();
            } catch (err) {
                this.showToast(err.message, 'error');
            }
        });

        const intervalSel = wrap.querySelector('.sync-interval-select');
        intervalSel?.addEventListener('change', async (e) => {
            const id = parseInt(e.target.dataset.syncId, 10);
            try {
                const res = await fetch(`/api/playlist-syncs/${id}`, {
                    method: 'PUT', credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ interval_hours: parseInt(e.target.value, 10) })
                });
                const d = await res.json();
                if (!res.ok) throw new Error(d.error || 'Update failed');
                this.showToast('Interval updated', 'success');
                this.loadPlaylistSyncs();
            } catch (err) {
                this.showToast(err.message, 'error');
            }
        });

        const modeSel = wrap.querySelector('.sync-mode-select');
        modeSel?.addEventListener('change', async (e) => {
            const id = parseInt(e.target.dataset.syncId, 10);
            try {
                const res = await fetch(`/api/playlist-syncs/${id}`, {
                    method: 'PUT', credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sync_mode: e.target.value })
                });
                const d = await res.json();
                if (!res.ok) throw new Error(d.error || 'Update failed');
                this.showToast('Sync mode updated', 'success');
            } catch (err) {
                this.showToast(err.message, 'error');
            }
        });

        return wrap;
    }

    async createPlaylistSync() {
        const selectEl = document.getElementById('sync-playlist-select');
        const urlEl = document.getElementById('sync-url-input');
        const intervalEl = document.getElementById('sync-interval-select');
        const modeEl = document.getElementById('sync-mode-select');
        const enabledEl = document.getElementById('sync-enabled-check');
        const errorEl = document.getElementById('sync-create-error');
        const createBtn = document.getElementById('sync-create-btn');
        const sourceGroup = document.getElementById('sync-source-group');

        const playlistId = parseInt(selectEl?.value, 10);
        const url = (urlEl?.value || '').trim();
        const interval_hours = parseInt(intervalEl?.value || '24', 10);
        const sync_mode = modeEl?.value || 'mirror';
        const enabled = !!enabledEl?.checked;
        const selectedSource = sourceGroup?.querySelector('.settings-radio-item.selected')?.dataset.value || 'spotify';

        if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }

        if (!playlistId) {
            if (errorEl) { errorEl.textContent = t('Select a local playlist.'); errorEl.style.display = ''; }
            return;
        }
        if (!url) {
            if (errorEl) { errorEl.textContent = t('Paste a playlist URL.'); errorEl.style.display = ''; }
            return;
        }

        if (createBtn) { createBtn.disabled = true; createBtn.textContent = t('Creating…'); }

        try {
            const res = await fetch('/api/playlist-syncs', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ playlist_id: playlistId, source: selectedSource, url, interval_hours, sync_mode, enabled })
            });
            const data = await res.json();
            if (!res.ok || !data.success) throw new Error(data.error || 'Failed to create sync');
            this.showToast('Playlist sync created', 'success');
            if (urlEl) urlEl.value = '';
            await this.loadPlaylistSyncs();
        } catch (e) {
            if (errorEl) { errorEl.textContent = t(e.message); errorEl.style.display = ''; }
            this.showToast(e.message, 'error');
        } finally {
            if (createBtn) { createBtn.disabled = false; createBtn.textContent = t('Create sync'); }
        }
    }

    async loadSyncHistory() {
        const listEl = document.getElementById('syncs-history-list');
        const emptyEl = document.getElementById('syncs-history-empty');
        if (!listEl) return;
        listEl.innerHTML = `<div class="import-jobs-empty">${t('Loading history…')}</div>`;
        if (emptyEl) emptyEl.style.display = 'none';
        try {
            const res = await fetch('/api/playlist-syncs/history?limit=30', { credentials: 'same-origin' });
            const data = await res.json();
            if (!res.ok || !data.success) throw new Error(data.error || 'Failed to load history');
            const rows = data.history || [];
            if (rows.length === 0) {
                listEl.innerHTML = '';
                if (emptyEl) emptyEl.style.display = '';
                return;
            }
            if (emptyEl) emptyEl.style.display = 'none';
            listEl.innerHTML = '';
            rows.forEach(r => {
                const when = r.ran_at ? new Date(r.ran_at).toLocaleString() : '—';
                const statusColor = r.status === 'success' ? '#4ade80' : r.status === 'failed' ? '#f87171' : 'var(--text-tertiary)';
                const details = r.details || {};
                const added = details.added || [];
                const removed = details.removed || [];
                const card = document.createElement('div');
                card.className = 'import-job-row';
                card.style.flexDirection = 'column';
                card.style.alignItems = 'stretch';
                card.innerHTML = `
                    <div style="display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap; align-items:center;">
                        <div style="font-weight:600; color:var(--text-primary);">${this._esc(playlistDisplayName(r.playlist_name) || t('Playlist #{id}', { id: r.playlist_id }))} <span style="font-weight:400; color:var(--text-tertiary); font-size:0.85rem;">· ${this._esc(when)}</span></div>
                        <span class="import-job-badge" style="color:${statusColor}; border:1px solid ${statusColor}33; background:${statusColor}14;">${this._esc(t(r.status))}</span>
                    </div>
                    <div style="font-size:0.8rem; color:var(--text-secondary); margin-top:4px;">
                        ${this._esc(t('+{added} added · -{removed} removed · {kept} kept · {failed} failed · {remote} remote', {
                            added: r.added_count, removed: r.removed_count, kept: r.kept_count,
                            failed: r.failed_count, remote: r.total_remote,
                        }))}
                    </div>
                    ${r.message ? `<div style="font-size:0.78rem; color:var(--text-tertiary); margin-top:2px;">${this._esc(r.message)}</div>` : ''}
                    ${(added.length || removed.length) ? `
                        <details style="margin-top:8px;">
                            <summary style="cursor:pointer; font-size:0.8rem; color:var(--accent-primary);">${t('Details')}</summary>
                            <div style="margin-top:8px; display:grid; gap:8px;">
                                ${added.length ? `<div><div style="font-size:0.78rem; font-weight:600; color:#4ade80;">${t('Added ({count}):', { count: added.length })}</div><div style="font-size:0.78rem; color:var(--text-secondary); max-height:120px; overflow:auto;">${added.map(x => this._esc(x)).join('<br>')}</div></div>` : ''}
                                ${removed.length ? `<div><div style="font-size:0.78rem; font-weight:600; color:#f87171;">${t('Removed ({count}):', { count: removed.length })}</div><div style="font-size:0.78rem; color:var(--text-secondary); max-height:120px; overflow:auto;">${removed.map(x => this._esc(x)).join('<br>')}</div></div>` : ''}
                            </div>
                        </details>
                    ` : ''}
                `;
                listEl.appendChild(card);
            });
        } catch (e) {
            listEl.innerHTML = `<div class="import-jobs-empty" style="color:#f87171;">${this._esc(t('Error: {message}', { message: t(e.message) }))}</div>`;
        }
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
        btn.textContent = t('Downloading...');
        this.showToast(t('Starting download: "{title}"', { title: song.title }), 'info');

        const youtubeUrl = `https://www.youtube.com/watch?v=${song.videoId}`;
        const data = await useMusicService().YouTube.import(youtubeUrl);

        if (data.error) {
            btn.disabled = false;
            btn.textContent = t('Download');
            Logger.error(data.error);
            this.showToast(t('Download failed: {message}', { message: t(data.error.error || 'Unknown error') }), 'error');
            return;
        }

        const result = data.value;
        if (result?.success) {
            if (result.already_exists) {
                this.showToast(t('"{title}" already exists in library', { title: song.title }), 'info');
            } else {
                this.showToast(t('Downloaded: "{title}" successfully!', { title: song.title }), 'success');
            }
            btn.disabled = true;
            btn.textContent = t('In Library');
            const item = btn.closest('.discover-item');
            if (item) {
                item.classList.add('in-library');
                const previewBtn = item.querySelector('.discover-btn-preview');
                if (previewBtn) {
                    previewBtn.textContent = t('Play');
                }
            }
            
            // Reload library in background silently to update the local cache
            const libraryData = await useMusicService().library();
            if (libraryData && libraryData.value && libraryData.value.all_songs) {
                this.librarySongs = [...libraryData.value.all_songs];
            }
        } else {
            btn.disabled = false;
            btn.textContent = t('Download');
            this.showToast(t('Download failed: {message}', { message: t(result?.message || 'Unknown error') }), 'error');
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
        try { localStorage.setItem('rainy-accent', color); } catch (e) { /* ignore */ }
        root.style.setProperty('--accent-secondary', color); // Simple fallback
        // Create a simple gradient
        root.style.setProperty('--accent-gradient', `linear-gradient(135deg, ${color} 0%, ${color} 100%)`);
        // Calculate glow (hex + opacity)
        root.style.setProperty('--accent-glow', `${color}4D`); // ~30% opacity
        // Calculate subtle bg (hex + opacity)
        root.style.setProperty('--accent-bg-subtle', `${color}14`); // ~8% opacity
    }

    /** Hide the anime logo everywhere and show the animated Rainy wordmark instead. */
    applyNoAnime(enabled) {
        document.documentElement.classList.toggle('no-anime', !!enabled);
        // Mirrored locally so the boot splash and login screen match before the user is loaded
        try {
            if (enabled) localStorage.setItem('rainy-no-anime', '1');
            else localStorage.removeItem('rainy-no-anime');
        } catch (e) { /* ignore */ }
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
            if (prefs && typeof prefs.no_anime !== 'undefined') {
                this.applyNoAnime(prefs.no_anime);
            }
        }
    }

    /** Parse user preferences into an object (handles string or object form). */
    _getPlayerPrefs() {
        if (!this.user || !this.user.preferences) return {};
        let prefs = this.user.preferences;
        if (typeof prefs === 'string') {
            try { prefs = JSON.parse(prefs); } catch (e) { return {}; }
        }
        return prefs || {};
    }

    /**
     * Show/hide player-bar extra controls based on the user's
     * `player_bar_controls` preference. All controls default to visible.
     */
    applyPlayerBarPreferences() {
        const prefs = this._getPlayerPrefs();
        const controls = prefs.player_bar_controls || {};
        const map = {
            sleep_timer: '#sleep-timer-btn',
            queue: '#queue-btn',
            ab_repeat: '#ab-repeat-btn',
            speed: '#speed-btn',
            equalizer: '#eq-btn',
            crossfade: '#crossfade-btn',
            volume: '.volume-control',
        };
        for (const [key, selector] of Object.entries(map)) {
            const el = document.querySelector(selector);
            if (!el) continue;
            const visible = controls[key] !== false; // default: visible
            el.classList.toggle('hidden', !visible);
        }
    }

    // Show/hide sysadmin-only UI (e.g. delete song/playlist) based on role
    applyRoleVisibility() {
        const isAdmin = this.user?.role === 'sysadmin';
        document.querySelectorAll('.sysadmin-only').forEach(el => {
            el.classList.toggle('hidden', !isAdmin);
        });
    }

    // Discord-style Settings Page Methods
    openSettings(section = 'appearance', { updateUrl = true } = {}) {
        if (updateUrl) {
            const currentPath = `${window.location.pathname}${window.location.search}`;
            if (!currentPath.startsWith('/settings')) {
                this._settingsReturnPath = currentPath || '/library';
            }
            return this.navigateTo(`/settings/${encodeURIComponent(section)}`);
        }

        this.closeMobileSidebar();
        this.closePlayerTools();
        this._settingsSearchIndex = null; // rebuilt on first search (role / DOM may have changed)
        const settingsPage = document.getElementById('settings-page');
        const activeElement = document.activeElement;
        this._settingsReturnFocus = activeElement instanceof HTMLElement && activeElement !== document.body
            ? activeElement
            : document.getElementById('menu-settings');
        settingsPage?.classList.remove('hidden');
        requestAnimationFrame(() => document.getElementById('settings-close')?.focus());

        // Update user profile in settings sidebar
        if (this.user) {
            const avatar = document.getElementById('settings-user-avatar');
            const username = document.getElementById('settings-username');
            const role = document.getElementById('settings-user-role');
            if (avatar) avatar.textContent = this.user.username?.charAt(0).toUpperCase() || 'U';
            if (username) username.textContent = this.user.username || t('User');
            if (role) role.textContent = this.user.role === 'sysadmin' ? t('Administrator') : t('User');

            // Server Settings (Maintenance, Users) and admin-only controls.
            // Jobs stays for every account: it is scoped to the user's own
            // library (see routes/music.py).
            this.applyRoleVisibility();
        }

        // Reset password form
        document.getElementById('change-password-form')?.reset();

        const languageSelect = document.getElementById('settings-language');
        if (languageSelect) languageSelect.value = getLanguage();

        // Set current color in picker
        let currentColor = '#3d7dc4';
        let currentFsMode = 'standard'; // default for new/no-pref accounts — keep in sync with player.js toggleFullscreen
        let currentLyricsEffect = 'word';
        let currentLightshowIntensity = 'auto';
        let lightshowReduceFlashing = false;
        let lightshowLyrics = true;
        let lightshowOffset = 0;
        let swap = false;
        let disableLasers = false;
        let showBgBlur = false;

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
                if (prefs.lightshow_intensity) currentLightshowIntensity = prefs.lightshow_intensity;
                if (typeof prefs.lightshow_reduce_flashing !== 'undefined') lightshowReduceFlashing = !!prefs.lightshow_reduce_flashing;
                if (typeof prefs.lightshow_lyrics !== 'undefined') lightshowLyrics = !!prefs.lightshow_lyrics;
                if (typeof prefs.lightshow_offset_ms !== 'undefined') lightshowOffset = Number(prefs.lightshow_offset_ms) || 0;
                if (typeof prefs.fullscreen_swap_sides !== 'undefined') swap = !!prefs.fullscreen_swap_sides;
                if (typeof prefs.disable_lasers !== 'undefined') disableLasers = !!prefs.disable_lasers;
                if (typeof prefs.show_bg_blur !== 'undefined') showBgBlur = !!prefs.show_bg_blur;
            }
        }

        // Set color picker
        const colorInput = document.getElementById('settings-accent-color');
        const colorValue = document.getElementById('settings-accent-color-value');
        if (colorInput) colorInput.value = currentColor;
        if (colorValue) colorValue.textContent = currentColor;

        // Set radio button groups to their saved values
        const radioValues = { fullscreen_mode: currentFsMode, lyrics_effect: currentLyricsEffect, lightshow_intensity: currentLightshowIntensity };
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

        // Set show animation toggles
        const disableLasersToggle = document.getElementById('settings-disable-lasers');
        if (disableLasersToggle) disableLasersToggle.checked = disableLasers;

        const showBgBlurToggle = document.getElementById('settings-show-bg-blur');
        if (showBgBlurToggle) showBgBlurToggle.checked = showBgBlur;

        const noAnimeToggle = document.getElementById('settings-no-anime');
        if (noAnimeToggle) noAnimeToggle.checked = document.documentElement.classList.contains('no-anime');

        const reduceFlashToggle = document.getElementById('settings-lightshow-reduce-flashing');
        if (reduceFlashToggle) reduceFlashToggle.checked = lightshowReduceFlashing;
        const lowPowerToggle = document.getElementById('settings-lightshow-low-power');
        if (lowPowerToggle) {
            try { lowPowerToggle.checked = localStorage.getItem('rainy-ls-lowpower') === '1'; } catch (e) { /* ignore */ }
        }
        const stageLyricsToggle = document.getElementById('settings-lightshow-lyrics');
        if (stageLyricsToggle) stageLyricsToggle.checked = lightshowLyrics;
        const offsetInput = document.getElementById('settings-lightshow-offset');
        if (offsetInput) offsetInput.value = String(lightshowOffset);
        this._renderLightshowOffset(lightshowOffset);

        // Sync Player Bar control toggles with saved preferences
        const pbControls = (this._getPlayerPrefs().player_bar_controls) || {};
        document.querySelectorAll('.pb-toggle-input').forEach(input => {
            const key = input.dataset.playerbarToggle;
            input.checked = pbControls[key] !== false; // default: on
        });

        // Switch to the requested section (loadScanStatus runs inside for the jobs section)
        this.switchSettingsSection(section, { updateUrl: false });
    }

    closeSettings({ updateUrl = true } = {}) {
        if (updateUrl && window.location.pathname.startsWith('/settings')) {
            const returnPath = this._settingsReturnPath || '/library';
            this._settingsReturnPath = null;
            this.closeSettings({ updateUrl: false });
            return this.navigateTo(returnPath, { replace: true });
        }

        this._clearSettingsSearch();
        const settingsPage = document.getElementById('settings-page');
        if (settingsPage) {
            settingsPage.classList.add('closing');
            setTimeout(() => {
                settingsPage.classList.add('hidden');
                settingsPage.classList.remove('closing');
                this._settingsReturnFocus?.focus?.();
                this._settingsReturnFocus = null;
            }, 200);
        }
    }

    trapFocus(container, event) {
        const focusable = [...container.querySelectorAll(
            'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )].filter(el => !el.classList.contains('hidden') && el.offsetParent !== null);
        if (!focusable.length) return;

        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!container.contains(document.activeElement)) {
            event.preventDefault();
            first.focus();
        } else if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }

    switchSettingsSection(sectionName, { updateUrl = true } = {}) {
        // Admin-only sections (Server Settings): non-admins fall back to
        // Appearance, even on direct deep links like /settings/users.
        if (ADMIN_SETTINGS_SECTIONS.has(sectionName) &&
            (!this.user || this.user.role !== 'sysadmin')) {
            sectionName = 'appearance';
        }
        // The old Library section (duplicates) now lives under Jobs.
        if (sectionName === 'library') sectionName = 'jobs';
        // Unknown or removed sections (e.g. stale deep links) fall back too.
        if (!document.getElementById(`settings-section-${sectionName}`)) {
            sectionName = 'appearance';
        }
        if (updateUrl) {
            return this.navigateTo(`/settings/${encodeURIComponent(sectionName)}`, { replace: true });
        }

        // Update navigation active state
        document.querySelectorAll('.settings-nav-item').forEach(item => {
            item.classList.toggle('active', item.dataset.section === sectionName);
            if (item.dataset.section === sectionName) {
                item.setAttribute('aria-current', 'page');
            } else {
                item.removeAttribute('aria-current');
            }
        });

        // Update title
        const title = document.getElementById('settings-page-title');
        if (title) title.textContent = t(SETTINGS_SECTION_TITLES[sectionName] || 'Settings');

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

        if (sectionName === 'jobs') {
            this.loadImportJobs();
            this.loadLightshowJobs();
            this.loadLyricsJobs();
            this.loadEnrichJobs();
        }

        // Library scanning and yt-dlp live in the admin Maintenance section
        if (sectionName === 'server') {
            this.loadScanStatus();
            this.loadYtdlpStatus();
        }

        if (sectionName === 'syncs') {
            this.loadPlaylistSyncs();
            this.loadSyncHistory();
        }

        // Load users when switching to users section
        if (sectionName === 'users') {
            this.setCreateUserFormOpen(false);
            this.loadUsers();
        }

        // Load Chromecast setup info when switching to chromecast section
        if (sectionName === 'chromecast') {
            this._loadChromecastInfo();
        }
    }

    async _loadChromecastInfo() {
        const originEl = document.getElementById('chromecast-origin-url');
        const fallbackOrigin = `http://${window.location.hostname || 'localhost'}:6969`;
        if (originEl) originEl.textContent = fallbackOrigin;

        const res = await useServerService().chromecastInfo();
        if (res.value && res.value.origin_url && originEl) {
            originEl.textContent = res.value.origin_url;
        }
    }

    // ==================== Settings search ====================

    _normSearch(text) {
        return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
            .toLowerCase().replace(/\s+/g, ' ').trim();
    }

    /**
     * Index every option in the settings pages (rows, option cards, group
     * headings) straight from the DOM, so results never drift out of sync with
     * what is actually on screen. Entries the current account can't see
     * (sysadmin-only) are left out.
     */
    _buildSettingsSearchIndex() {
        const isAdmin = this.user?.role === 'sysadmin';
        const textOf = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
        const entries = [];

        document.querySelectorAll('.settings-section').forEach(sec => {
            const section = sec.id.replace('settings-section-', '');
            const nav = document.querySelector(`.settings-nav-item[data-section="${section}"]`);
            if (nav?.classList.contains('sysadmin-only') && !isAdmin) return;
            const sectionTitle = t(SETTINGS_SECTION_TITLES[section] || section);
            const sectionNorm = this._normSearch(sectionTitle);

            sec.querySelectorAll('.settings-row-label, .settings-group-title').forEach(labelEl => {
                const isRow = labelEl.classList.contains('settings-row-label');
                const target = (isRow && labelEl.closest('.settings-row'))
                    || labelEl.closest('.settings-card')
                    || labelEl.closest('.settings-group')
                    || sec;
                if (target.closest('.sysadmin-only') && !isAdmin) return;
                if (target.closest('.hidden')) return;

                const title = textOf(labelEl);
                if (!title) return;
                const titleNorm = this._normSearch(title);
                if (titleNorm === sectionNorm) return; // the section itself is in the nav

                let body;
                if (target.classList.contains('settings-row')) {
                    body = textOf(target);
                } else {
                    const desc = labelEl.parentElement?.querySelector(':scope > .settings-group-description');
                    const options = target.classList.contains('settings-card')
                        ? [...target.querySelectorAll('.settings-radio-item')]
                            .filter(r => r.closest('.settings-card') === target)
                        : [];
                    body = [textOf(desc), ...options.map(textOf)].join(' ');
                }

                entries.push({
                    section,
                    sectionTitle,
                    title,
                    titleNorm,
                    bodyNorm: this._normSearch(body),
                    sectionNorm,
                    el: target,
                });
            });
        });
        return entries;
    }

    _searchSettings(query) {
        const tokens = this._normSearch(query).split(' ').filter(Boolean);
        if (!tokens.length) return { tokens, results: [] };
        if (!this._settingsSearchIndex) this._settingsSearchIndex = this._buildSettingsSearchIndex();

        const results = [];
        this._settingsSearchIndex.forEach((entry, order) => {
            let score = 0;
            for (const tok of tokens) {
                if (entry.titleNorm.split(' ').some(w => w.startsWith(tok))) score += 4;
                else if (entry.titleNorm.includes(tok)) score += 3;
                else if (entry.bodyNorm.includes(tok)) score += 2;
                else if (entry.sectionNorm.includes(tok)) score += 1;
                else return; // every word has to match somewhere
            }
            results.push({ entry, score, order });
        });
        results.sort((a, b) => b.score - a.score || a.order - b.order);
        return { tokens, results: results.map(r => r.entry) };
    }

    /** Append `text` to `parent`, wrapping the parts that match a search word in <mark>. */
    _appendHighlighted(parent, text, tokens) {
        const lower = text.toLowerCase();
        const ranges = [];
        tokens.forEach(tok => {
            let from = 0;
            for (let at = lower.indexOf(tok, from); at !== -1; at = lower.indexOf(tok, from)) {
                ranges.push([at, at + tok.length]);
                from = at + tok.length;
            }
        });
        ranges.sort((a, b) => a[0] - b[0]);
        const merged = [];
        ranges.forEach(r => {
            const last = merged[merged.length - 1];
            if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
            else merged.push([...r]);
        });
        let pos = 0;
        merged.forEach(([start, end]) => {
            if (start > pos) parent.appendChild(document.createTextNode(text.slice(pos, start)));
            const mark = document.createElement('mark');
            mark.textContent = text.slice(start, end);
            parent.appendChild(mark);
            pos = end;
        });
        if (pos < text.length) parent.appendChild(document.createTextNode(text.slice(pos)));
    }

    handleSettingsSearch(query) {
        const value = (query || '').trim();
        const sidebar = document.querySelector('.settings-sidebar');
        const box = document.getElementById('settings-search-results');
        document.getElementById('settings-search-clear')?.classList.toggle('hidden', !value);
        if (!box) return;

        this._settingsSearchActive = 0;
        sidebar?.classList.toggle('is-searching', !!value);
        box.classList.toggle('hidden', !value);
        box.replaceChildren();
        if (!value) {
            this._settingsSearchResults = [];
            return;
        }

        const { tokens, results } = this._searchSettings(value);
        this._settingsSearchResults = results;

        if (!results.length) {
            const empty = document.createElement('div');
            empty.className = 'settings-search-empty';
            empty.textContent = t('No settings match “{query}”', { query: value });
            box.appendChild(empty);
            return;
        }

        results.forEach((entry, i) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'settings-search-result';
            btn.setAttribute('role', 'option');
            btn.id = `settings-search-result-${i}`;
            const title = document.createElement('span');
            title.className = 'settings-search-result-title';
            this._appendHighlighted(title, entry.title, tokens);
            const where = document.createElement('span');
            where.className = 'settings-search-result-section';
            where.textContent = entry.sectionTitle;
            btn.append(title, where);
            btn.addEventListener('click', () => this._openSettingsSearchResult(entry));
            btn.addEventListener('mousemove', () => this._setSettingsSearchActive(i));
            box.appendChild(btn);
        });
        this._setSettingsSearchActive(0);
    }

    _setSettingsSearchActive(index) {
        const items = document.querySelectorAll('#settings-search-results .settings-search-result');
        if (!items.length) return;
        this._settingsSearchActive = Math.max(0, Math.min(index, items.length - 1));
        items.forEach((el, i) => {
            const active = i === this._settingsSearchActive;
            el.classList.toggle('active', active);
            el.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        items[this._settingsSearchActive].scrollIntoView({ block: 'nearest' });
        document.getElementById('settings-search-input')
            ?.setAttribute('aria-activedescendant', items[this._settingsSearchActive].id);
    }

    _onSettingsSearchKeydown(e) {
        const input = e.target;
        if (e.key === 'Escape' && input.value) {
            // First Escape only clears the search; the next one closes settings.
            e.stopPropagation();
            this._clearSettingsSearch();
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            if (!this._settingsSearchResults?.length) return;
            e.preventDefault();
            this._setSettingsSearchActive(this._settingsSearchActive + (e.key === 'ArrowDown' ? 1 : -1));
        } else if (e.key === 'Enter') {
            const entry = this._settingsSearchResults?.[this._settingsSearchActive];
            if (entry) {
                e.preventDefault();
                this._openSettingsSearchResult(entry);
            }
        }
    }

    _clearSettingsSearch() {
        const input = document.getElementById('settings-search-input');
        if (input) {
            input.value = '';
            input.removeAttribute('aria-activedescendant');
        }
        this.handleSettingsSearch('');
    }

    async _openSettingsSearchResult(entry) {
        this._clearSettingsSearch();
        await this.switchSettingsSection(entry.section);

        // Wait for the section to be laid out, then bring the option into view.
        const reveal = (retries = 6) => {
            if (!entry.el.isConnected) return;
            if (entry.el.offsetParent === null && retries > 0) {
                setTimeout(() => reveal(retries - 1), 50);
                return;
            }
            entry.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            document.querySelectorAll('.settings-search-highlight').forEach(el => {
                el.classList.remove('settings-search-highlight');
            });
            void entry.el.offsetWidth; // restart the animation if it is the same element
            entry.el.classList.add('settings-search-highlight');
            setTimeout(() => entry.el.classList.remove('settings-search-highlight'), 2200);
        };
        requestAnimationFrame(() => reveal());
    }

    /**
     * Save the account's UI language, then reload so every view and
     * component is rebuilt in it (playback resumes where it was).
     */
    async changeLanguage(code) {
        const select = document.getElementById('settings-language');
        if (select) select.disabled = true;

        const data = await useAuthService().updateLanguage(code);
        if (data.error) {
            if (select) {
                select.disabled = false;
                select.value = getLanguage();
            }
            this.showToast(data.error.error || 'Could not save language', 'error');
            return;
        }

        if (this.user) this.user.language = code;
        window.player?.savePlaybackState?.();
        await setLanguage(code);
        window.location.reload();
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
            list.innerHTML = `<div class="user-list-empty">${t('Failed to load users')}</div>`;
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
            list.innerHTML = `<div class="user-list-empty">${t('No users yet. Click “Add User” to create the first account.')}</div>`;
            return;
        }

        const currentUserId = this.user?.id;

        const shieldPath = 'M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z';
        const keyPath = 'M12.65 10C11.83 7.67 9.61 6 7 6c-3.31 0-6 2.69-6 6s2.69 6 6 6c2.61 0 4.83-1.67 5.65-4H17v4h4v-4h2v-4H12.65zM7 14c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z';
        const trashPath = 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z';
        const libraryPath = 'M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z';

        list.innerHTML = users.map(user => {
            const initial = Utils.escapeHtml((user.username || '?').charAt(0).toUpperCase());
            const isAdmin = user.role === 'sysadmin';
            const isSelf = user.id === currentUserId;
            const roleTitle = Utils.escapeHtml(isAdmin ? t('Make user') : t('Make administrator'));
            const hasFullLibrary = !!user.full_library;
            const fullLibraryTitle = Utils.escapeHtml(hasFullLibrary
                ? t('Full library access: ON — click to revoke')
                : t('Full library access: OFF — click to grant'));

            return `
                <div class="user-list-item" data-id="${user.id}">
                    <div class="user-list-avatar">${initial}</div>
                    <div class="user-list-info">
                        <div class="user-list-name">
                            <span class="user-list-name-text">${Utils.escapeHtml(user.username)}</span>
                            ${isSelf ? `<span class="user-role-badge you">${t('You')}</span>` : ''}
                            <span class="user-role-badge ${isAdmin ? 'admin' : ''}">${isAdmin ? t('Admin') : t('User')}</span>
                            ${hasFullLibrary ? `<span class="user-role-badge full-library">${t('Full library')}</span>` : ''}
                        </div>
                        <div class="user-list-email" title="${Utils.escapeHtml(user.email)}">${Utils.escapeHtml(user.email)}</div>
                    </div>
                    <div class="user-list-actions">
                        <button class="icon-btn-small user-full-library-toggle ${hasFullLibrary ? 'active-full-library' : ''}" data-id="${user.id}" data-full="${hasFullLibrary ? '1' : '0'}" title="${fullLibraryTitle}" aria-label="${fullLibraryTitle}">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="${libraryPath}"/></svg>
                        </button>
                        <button class="icon-btn-small user-role-toggle ${isAdmin ? 'active-admin' : ''}" data-id="${user.id}" data-role="${user.role}" title="${roleTitle}" aria-label="${roleTitle}">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="${shieldPath}"/></svg>
                        </button>
                        <button class="icon-btn-small user-reset-password" data-id="${user.id}" data-username="${Utils.escapeHtml(user.username)}" title="${Utils.escapeHtml(t('Reset password'))}" aria-label="${Utils.escapeHtml(t('Reset password'))}">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="${keyPath}"/></svg>
                        </button>
                        <button class="icon-btn-small user-action-delete user-delete" data-id="${user.id}" data-username="${Utils.escapeHtml(user.username)}" title="${Utils.escapeHtml(isSelf ? t('You cannot delete yourself') : t('Delete user'))}" aria-label="${Utils.escapeHtml(t('Delete user'))}" ${isSelf ? 'disabled' : ''}>
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="${trashPath}"/></svg>
                        </button>
                    </div>
                </div>
            `;
        }).join('');

        list.querySelectorAll('.user-role-toggle').forEach(btn => {
            btn.addEventListener('click', () => this.handleToggleUserRole(btn.dataset.id, btn.dataset.role));
        });

        list.querySelectorAll('.user-full-library-toggle').forEach(btn => {
            btn.addEventListener('click', () => this.handleToggleFullLibrary(btn.dataset.id, btn.dataset.full === '1'));
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
            if (label) label.textContent = t('Cancel');
            if (iconPath) iconPath.setAttribute('d', 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z');
            setTimeout(() => document.getElementById('new-user-username')?.focus(), 50);
        } else {
            if (label) label.textContent = t('Add User');
            if (iconPath) iconPath.setAttribute('d', 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z');
        }
    }

    async handleCreateUser() {
        const username = document.getElementById('new-user-username').value.trim();
        const email = document.getElementById('new-user-email').value.trim();
        const password = document.getElementById('new-user-password').value;
        const role = document.getElementById('new-user-role').value;
        const fullLibrary = !!document.getElementById('new-user-full-library')?.checked;

        const data = await useUsersService().create(username, email, password, role, fullLibrary);
        if (data.error) {
            this.showToast(data.error.error || 'Failed to create user', 'error');
            return;
        }

        this.showToast(t('User "{name}" created', { name: username }), 'success');
        document.getElementById('create-user-form').reset();
        this.setCreateUserFormOpen(false);
        await this.loadUsers();
    }

    async handleToggleFullLibrary(userId, currentFlag) {
        const newFlag = !currentFlag;

        const data = await useUsersService().updateFullLibrary(userId, newFlag);
        if (data.error) {
            this.showToast(data.error.error || 'Failed to update full library access', 'error');
            return;
        }

        this.showToast(newFlag
            ? 'Full library access granted'
            : 'Full library access revoked', 'success');
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
        document.getElementById('reset-user-password-target').textContent = t('Set a new password for {name}', { name: username });
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
            t('Are you sure you want to delete "{name}"? This action cannot be undone.', { name: username });
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

    switchToArtistsView(targetArtistName = null, { updateUrl = true } = {}) {
        if (updateUrl) {
            const suffix = targetArtistName
                ? `/${encodeURIComponent(targetArtistName)}`
                : '';
            return this.navigateTo(`/artists${suffix}`);
        }

        // Pause discover audio preview if it exists
        const previewAudio = document.getElementById('discover-preview-audio');
        if (previewAudio) {
            previewAudio.pause();
            previewAudio.src = '';
            document.getElementById('discover-preview-bar')?.classList.add('hidden');
        }

        useContext().set('current-view-type', 'artists');
        this.currentPlaylistId = null;

        // Hide new-feature views so they don't linger
        window.newViews?.hideNewViews();
        document.getElementById('friends-view')?.classList.add('hidden');

        // Update Sidebar UI
        document.querySelectorAll('.app-sidebar .nav-item').forEach(el => el.classList.remove('active'));
        document.getElementById('nav-artists')?.classList.add('active');
        this.renderSidebarPlaylists();

        // Update Header
        document.querySelector('.section-title').textContent = t('Artists');
        document.getElementById('library-subtitle').textContent = t('Browse your music by artist');

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

        // Group library songs by split artist names (comma separation).
        // Key by a normalized (lowercased) name so casing variants like
        // "Radiohead" / "radiohead" collapse into a single artist card, while
        // keeping the most common casing as the display name.
        const librarySongs = this.librarySongs || [];
        const artistMap = {};    // normalized name -> { displayName, songs }
        const nameCounts = {};   // normalized name -> { variant -> count }

        librarySongs.forEach(song => {
            const rawArtist = song.artist || 'Unknown Artist';
            const _dedupe = (window.Utils && window.Utils.splitArtists) ? window.Utils.splitArtists(rawArtist) : (()=>{ const seen=new Set(); const out=[]; for(const p of String(rawArtist).split(',')){const n=p.trim(); if(!n)continue; const k=n.toLowerCase(); if(!seen.has(k)){seen.add(k); out.push(n);} } return out.length?out:['Unknown Artist']; })();
            const artistNames = _dedupe;

            artistNames.forEach(artistName => {
                const key = artistName.toLowerCase();
                if (!artistMap[key]) {
                    artistMap[key] = { displayName: artistName, songs: [] };
                    nameCounts[key] = {};
                }
                nameCounts[key][artistName] = (nameCounts[key][artistName] || 0) + 1;
                artistMap[key].songs.push(song);
            });
        });

        // Pick the most frequent casing variant as the display name.
        Object.keys(artistMap).forEach(key => {
            const variants = nameCounts[key];
            artistMap[key].displayName = Object.keys(variants).sort((a, b) => variants[b] - variants[a])[0];
        });

        const sortedArtistKeys = Object.keys(artistMap).sort((a, b) => a.localeCompare(b));

        // If targetArtistName is specified, render the profile view directly
        if (targetArtistName) {
            const key = targetArtistName.trim().toLowerCase();
            const entry = artistMap[key];
            gridView.classList.add('hidden');
            profileView.classList.remove('hidden');
            this.renderArtistProfile(entry ? entry.displayName : targetArtistName, entry ? entry.songs : []);
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
            const filteredKeys = sortedArtistKeys.filter(key => key.includes(query));

            // Update stats badge
            const countEl = document.getElementById('artists-count-badge');
            if (countEl) {
                countEl.textContent = t('{count} Artists', { count: filteredKeys.length });
            }

            if (filteredKeys.length === 0) {
                gridList.innerHTML = `<div class="empty-state">${t('No artists found')}</div>`;
                return;
            }

            gridList.innerHTML = filteredKeys.map(key => {
                const artistName = artistMap[key].displayName;
                const count = artistMap[key].songs.length;
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
                        <div class="artist-circle-meta">${t('{count} songs', { count })}</div>
                    </div>
                `;
            }).join('');

            // Bind click events and fetch custom images
            const cards = gridList.querySelectorAll('.artist-circle-card');
            cards.forEach(card => {
                const artistName = card.dataset.artist;
                const key = artistName.trim().toLowerCase();

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
                    this.switchToArtistsView(artistName);
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
        bioText.textContent = t('No description available. Click Edit Profile to add one.');
        metaText.textContent = t('{count} songs in library', { count: songs.length });
        
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
                const _splitA = (window.Utils && window.Utils.splitArtists) ? window.Utils.splitArtists(song.artist || 'Unknown Artist') : (()=>{ const seen=new Set(); const out=[]; for(const p of String(song.artist||'Unknown Artist').split(',')){const n=p.trim(); if(!n)continue; const k=n.toLowerCase(); if(!seen.has(k)){seen.add(k); out.push(n);} } return out; })();
                const artistNames = _splitA;
                const artistLinksHtml = artistNames.map(name => `<span class="song-artist-link" data-artist="${escapeHtml(name)}">${escapeHtml(name)}</span>`).join(', ');

                return `
                <div class="artist-track-row fade-in" data-index="${globalIndex}" data-id="${song.id}">
                    <div class="track-number-col">
                        <span class="track-number">${trackIndex + 1}</span>
                        <button class="track-play-btn" title="${escapeHtml(t('Play'))}">
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
                    <div class="track-album-col">${escapeHtml(song.album || t('Single'))}</div>
                    <div class="track-duration-col">${Utils.formatDuration(song.duration)}</div>
                    <div class="track-actions-col">
                        <button class="song-menu-btn" data-song-id="${song.id}" data-song-title="${escapeHtml(song.title)}" data-song-artist="${escapeHtml(song.artist)}" data-song-cover="${escapeHtml(song.cover_path || song.cover || '')}" data-song-duration="${song.duration || 0}" data-song-album="${escapeHtml(song.album || '')}">
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

                const _splitB = (window.Utils && window.Utils.splitArtists) ? window.Utils.splitArtists(song.artist || 'Unknown Artist') : (()=>{ const seen=new Set(); const out=[]; for(const p of String(song.artist||'Unknown Artist').split(',')){const n=p.trim(); if(!n)continue; const k=n.toLowerCase(); if(!seen.has(k)){seen.add(k); out.push(n);} } return out; })();
                const artistNames = _splitB;
                const artistLinksHtml = artistNames.map(name => `<span class="song-artist-link" data-artist="${escapeHtml(name)}">${escapeHtml(name)}</span>`).join(', ');

                return `
                <div class="song-card fade-in" data-index="${globalIndex}" data-id="${song.id}">
                    <button class="song-menu-btn" data-song-id="${song.id}" data-song-title="${escapeHtml(song.title)}" data-song-artist="${escapeHtml(song.artist)}" data-song-cover="${escapeHtml(song.cover_path || song.cover || '')}" data-song-duration="${song.duration || 0}" data-song-album="${escapeHtml(song.album || '')}">
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
            bioToggle.textContent = t('more');
            bioToggle.classList.add('hidden');
            requestAnimationFrame(() => {
                if (bioText.scrollHeight > bioText.clientHeight + 2) {
                    bioToggle.classList.remove('hidden');
                }
            });
            bioToggle.onclick = () => {
                const expanded = bioText.classList.toggle('expanded');
                bioToggle.textContent = expanded ? t('less') : t('more');
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
        if (titleEl) titleEl.textContent = t('Edit: {name}', { name: artistName });

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
        bioInput.value = currentBio === t('No description available. Click Edit Profile to add one.') ? '' : currentBio;

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
                    <a class="scrape-candidate-link" href="${c.source_url}" target="_blank" rel="noopener noreferrer">${t('View')}</a>
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
                    this.showToast(t('Picked "{name}"', { name: c.name }), 'success');
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
                if (scrapeBtnText) scrapeBtnText.textContent = t('Scraping...');
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
                            this.showToast(t('Found "{name}" on YouTube Music', { name: c.name }), 'success');
                        } else {
                            renderScrapePicker(data.candidates);
                            this.showToast(t('Found {count} candidates for "{name}" — pick one', { count: data.candidates.length, name: artistName }), 'success');
                        }
                    } else {
                        this.showToast(data.error || 'Nothing found on YouTube Music for this artist', 'error');
                    }
                } catch (e) {
                    this.showToast(t('Scrape failed: {message}', { message: e.message }), 'error');
                } finally {
                    scrapeBtn.disabled = false;
                    if (scrapeBtnText) scrapeBtnText.textContent = t('Scrape Info');
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
                            const _splitC = (window.Utils && window.Utils.splitArtists) ? window.Utils.splitArtists(song.artist || '') : (()=>{ const seen=new Set(); const out=[]; for(const p of String(song.artist||'').split(',')){const n=p.trim(); if(!n)continue; const k=n.toLowerCase(); if(!seen.has(k)){seen.add(k); out.push(n);} } return out; })();
                            const artistNames = _splitC;
                            return artistNames.map(n=>n.toLowerCase()).includes(artistName.toLowerCase());
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
            listEl.innerHTML = `<div style="padding: 24px; color: var(--text-tertiary); text-align: center; font-size: 0.875rem;">${t('Failed to load songs')}</div>`;
            if (loadingEl) loadingEl.classList.add('hidden');
            return;
        }

        if (loadingEl) loadingEl.classList.add('hidden');

        const renderList = (filter = '') => {
            const lower = filter.toLowerCase();
            const filtered = filter
                ? allSongs.filter(s => s.title.toLowerCase().includes(lower) || (s.album || '').toLowerCase().includes(lower))
                : allSongs;

            if (countEl) countEl.textContent = t('{count} songs', { count: filtered.length });

            listEl.innerHTML = filtered.map(song => `
                <div class="artist-song-row" data-song-id="${song.id}">
                    <label class="artist-song-toggle" title="${Utils.escapeHtml(song.has_artist ? t('Remove from artist') : t('Add to artist'))}">
                        <input type="checkbox" ${song.has_artist ? 'checked' : ''} data-song-id="${song.id}">
                        <span class="artist-song-slider"></span>
                    </label>
                    <div class="artist-song-meta">
                        <div class="artist-song-title">${Utils.escapeHtml(song.title)}</div>
                        <div class="artist-song-album">${Utils.escapeHtml(song.album || t('Unknown Album'))}</div>
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
                            this.showToast(action === 'add'
                                ? t('Added to {name}', { name: artistName })
                                : t('Removed from {name}', { name: artistName }), 'success');
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
