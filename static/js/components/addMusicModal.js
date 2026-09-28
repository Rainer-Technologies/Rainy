import { Logger } from "../helper/logger.js";
import { Utils } from "../modules/utils.js";
import { useDiscoveryService } from "../services/discovery.js";
import { useMusicService } from "../services/music.js";
import { useImportJobsService } from "../services/importJobs.js";
import { I } from "./icon.js";
import { a, Component, H, h, on, Ref, useRef } from "./index.js";
import { Modal } from "./modal.js";

/** Format seconds as m:ss (or "" when unknown). */
const fmtDur = (s) => {
    if (!s || s <= 0) return '';
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.round(s % 60)).padStart(2, '0')}`;
};

export class AddMusicModal extends Component {
    static componentName = 'rainy-add-music-modal';

    created() {
        /** @type {Ref<HTMLInputElement>} */
        this._discoverInput = useRef(null);
        /** @type {Ref<HTMLDivElement>} */
        this._discoverResults = useRef(null);
        /** @type {Ref<HTMLDivElement>} */
        this._dropzone = useRef(null);
        /** @type {Ref<HTMLInputElement>} */
        this._fileInput = useRef(null);
        /** @type {Ref<HTMLDivElement>} */
        this._uploadProgress = useRef(null);
        /** @type {Ref<HTMLDivElement>} */
        this._uploadProgressFill = useRef(null);
        /** @type {Ref<HTMLSpanElement>} */
        this._uploadStatus = useRef(null);

        /** @type {Ref<HTMLInputElement>} */
        this._youtubeInput = useRef(null);
        /** @type {Ref<HTMLButtonElement>} */
        this._youtubeImportBtn = useRef(null);
        /** @type {Ref<HTMLDivElement>} */
        this._youtubeStatus = useRef(null);
        /** @type {Ref<HTMLSpanElement>} */
        this._youtubeStatusText = useRef(null);
        /** @type {Ref<HTMLDivElement>} */
        this._youtubeProgressFill = useRef(null);

        /** @type {Ref<HTMLInputElement>} */
        this._playlistInput = useRef(null);
        /** @type {Ref<HTMLButtonElement>} */
        this._playlistImportBtn = useRef(null);
        /** @type {Ref<HTMLDivElement>} */
        this._playlistStatus = useRef(null);
        /** @type {Ref<HTMLSpanElement>} */
        this._playlistStatusText = useRef(null);
        /** @type {Ref<HTMLDivElement>} */
        this._playlistProgressFill = useRef(null);

        /** @type {Ref<HTMLInputElement>} */
        this._spotifySongInput = useRef(null);
        /** @type {Ref<HTMLButtonElement>} */
        this._spotifySongImportBtn = useRef(null);
        /** @type {Ref<HTMLDivElement>} */
        this._spotifySongStatus = useRef(null);
        /** @type {Ref<HTMLSpanElement>} */
        this._spotifySongStatusText = useRef(null);
        /** @type {Ref<HTMLDivElement>} */
        this._spotifySongProgressFill = useRef(null);

        /** @type {Ref<HTMLInputElement>} */
        this._spotifyPlaylistInput = useRef(null);
        /** @type {Ref<HTMLButtonElement>} */
        this._spotifyPlaylistImportBtn = useRef(null);
        /** @type {Ref<HTMLDivElement>} */
        this._spotifyPlaylistStatus = useRef(null);
        /** @type {Ref<HTMLSpanElement>} */
        this._spotifyPlaylistStatusText = useRef(null);
        /** @type {Ref<HTMLDivElement>} */
        this._spotifyPlaylistProgressFill = useRef(null);

        /** @type {Ref<HTMLInputElement>} */
        this._youtubeBgToggle = useRef(null);
        /** @type {Ref<HTMLInputElement>} */
        this._spotifyBgToggle = useRef(null);

        this.set('current-method', 'upload', { silent: true });
        this.set('youtube-tab', 'song', { silent: true });
        this.set('spotify-tab', 'song', { silent: true });

        // Discover flow state (transient, not context — see AGENTS.md)
        this._discoverToken = 0;
        this._discoverSearching = false;
        this._discoverCancelled = false;
        this._discoverBusy = false;
        this._discoverDetail = null;
        this._discoverLastResults = [];
        this._discoverLastNotices = [];

        this.watch('current-method', (_path, _oldValue, methodName) => {
            const methods = this.root.querySelectorAll('.add-music-method');
            methods.forEach(method => {
                method.classList.toggle('active', method.dataset.method === methodName);
            });

            const contents = this.root.querySelectorAll('.add-music-content');
            contents.forEach(content => content.classList.remove('active'));
            const active = this.root.querySelector(`#${methodName}-content`);
            if (active) active.classList.add('active');
        });

        this.watch('youtube-tab', (_path, _oldValue, tabName) => {
            const songTab = this.root.querySelector('.youtube-tab-song');
            const playlistTab = this.root.querySelector('.youtube-tab-playlist');
            const songContent = this.root.querySelector('.youtube-song-content');
            const playlistContent = this.root.querySelector('.youtube-playlist-content');

            if (songTab && playlistTab) {
                songTab.classList.toggle('active', tabName === 'song');
                playlistTab.classList.toggle('active', tabName === 'playlist');
            }

            if (songContent && playlistContent) {
                songContent.classList.toggle('hidden', tabName !== 'song');
                playlistContent.classList.toggle('hidden', tabName !== 'playlist');
            }
        });

        this.watch('spotify-tab', (_path, _oldValue, tabName) => {
            const songTab = this.root.querySelector('.spotify-tab-song');
            const playlistTab = this.root.querySelector('.spotify-tab-playlist');
            const songContent = this.root.querySelector('.spotify-song-content');
            const playlistContent = this.root.querySelector('.spotify-playlist-content');

            if (songTab && playlistTab) {
                songTab.classList.toggle('active', tabName === 'song');
                playlistTab.classList.toggle('active', tabName === 'playlist');
            }

            if (songContent && playlistContent) {
                songContent.classList.toggle('hidden', tabName !== 'song');
                playlistContent.classList.toggle('hidden', tabName !== 'playlist');
            }
        });
    }

    show() {
        this.root.show();
        this.set('current-method', 'upload');
        this.set('youtube-tab', 'song');
        this.set('spotify-tab', 'song');
        this._discoverDetail = null;
        this._discoverCancelled = true;  // abandon any in-flight search
        this._discoverSearching = false;
        this._discoverBusy = false;
        this._discoverLastResults = [];
        this._discoverLastNotices = [];
        this._discoverSourceValue = 'all';
        this.root.querySelectorAll?.('.discover-source-tab').forEach((t) =>
            t.classList.toggle('active', t.dataset.source === 'all'));
        if (this._discoverInput.value) this._discoverInput.value.value = '';
        if (this._discoverResults.value) this._discoverRenderResults();
        if (this._youtubeInput.value) this._youtubeInput.value.value = '';
        if (this._fileInput.value) this._fileInput.value.value = '';
        if (this._playlistInput.value) this._playlistInput.value.value = '';
        if (this._spotifySongInput.value) this._spotifySongInput.value.value = '';
        if (this._spotifyPlaylistInput.value) this._spotifyPlaylistInput.value.value = '';
        this._uploadProgress.value?.classList.add('hidden');
        this._youtubeStatus.value?.classList.add('hidden');
        this._playlistStatus.value?.classList.add('hidden');
        this._spotifySongStatus.value?.classList.add('hidden');
        this._spotifyPlaylistStatus.value?.classList.add('hidden');
        if (this._youtubeBgToggle.value) this._youtubeBgToggle.value.checked = false;
        if (this._spotifyBgToggle.value) this._spotifyBgToggle.value.checked = false;
    }

    hide() {
        this.root.hide();
    }

    hasActions() {
        return this.root.hasActions();
    }

    switchMethod(methodName) {
        this.set('current-method', methodName);
    }

    switchYouTubeTab(tabName) {
        this.set('youtube-tab', tabName);
    }

    switchSpotifyTab(tabName) {
        this.set('spotify-tab', tabName);
    }

    // ------------------------------------------------------------ discover --

    _onDiscoverKeyPress(e) {
        if (e.key === 'Enter') this._discoverRunSearch();
    }

    _discoverSetSource(source) {
        this._discoverSourceValue = source;
        this.root.querySelectorAll('.discover-source-tab').forEach((tab) => {
            tab.classList.toggle('active', tab.dataset.source === source);
        });
        if (this._discoverLastResults.length) this._discoverRunSearch();
    }

    async _discoverRunSearch() {
        const q = (this._discoverInput.value?.value || '').trim();
        if (q.length < 2) {
            this._discoverInput.value?.focus();
            return;
        }
        if (this._discoverSearching) return;
        this._discoverSearching = true;
        this._discoverCancelled = false;
        const token = ++this._discoverToken;
        const source = this._discoverSourceValue || 'all';
        const box = this._discoverResults.value;
        const clearSearch = () => { this._discoverSearching = false; };

        box.replaceChildren(
            h.div(a.class('discover-state'),
                I.Refresh('currentColor', a.class('spinning')),
                h.span(`Searching ${source === 'all' ? 'YouTube & Spotify' : source} for “${q}”…`),
                h.span(a.class('discover-state-hint'), 'this can take ~20 s')
            )
        );

        const data = await useDiscoveryService().searchPlaylists(q, source, 8);
        if (token !== this._discoverToken || this._discoverCancelled) { clearSearch(); return; }
        this._discoverSearching = false;

        if (data.error) {
            box.replaceChildren(h.div(a.class('discover-state', 'discover-state-error'),
                I.Info(),
                h.span(data.error?.error || 'Search failed. Try again.')));
            return;
        }

        const results = data.value?.results || [];
        const notices = data.value?.notices || [];
        this._discoverLastResults = results;
        this._discoverLastNotices = notices;
        this._discoverDetail = null;
        this._discoverSearched = true;
        this._discoverRenderResults();
    }

    _discoverCard(r) {
        const img = r.cover
            ? h.img(a.class('discover-card-cover'), a.src(r.cover), a.alt(''), a.loading('lazy'),
                on.error((e) => { e.target.style.display = 'none'; }))
            : h.div(a.class('discover-card-cover', 'discover-card-cover-fallback'),
                I[r.source === 'spotify' ? 'Spotify' : 'Yt']());
        const meta = [r.channel, r.track_count ? `${r.track_count} tracks` : null]
            .filter(Boolean).join(' · ');
        return h.div(a.class('discover-card'),
            img,
            h.div(a.class('discover-card-body'),
                h.div(a.class('discover-card-name'), r.name),
                meta ? h.div(a.class('discover-card-meta'), meta) : null,
                h.span(a.class('discover-card-source', `discover-source-${r.source}`), r.source)
            ),
            h.button(a.class('btn', 'btn-primary', 'discover-card-btn'),
                on.click(() => this._discoverOpen(r)), 'Inspect')
        );
    }

    /**
     * Preview step: fetch track list, show it inline in the modal body under
     * the search. Import button at the bottom hands off to the same conflict
     * + import-jobs machinery the paste-URL flows use.
     */
    async _discoverOpen(r) {
        if (this._discoverBusy) return;
        this._discoverBusy = true;
        const box = this._discoverResults.value;

        const backBtn = h.button(a.class('discover-back'),
            I.ArrowHeadRight('currentColor', a.class('discover-back-flip')), 'Back');
        const detail = h.div(a.class('discover-detail'),
            h.div(a.class('discover-detail-header'),
                backBtn,
                h.div(a.class('discover-detail-title'),
                    r.cover ? h.img(a.class('discover-detail-cover'), a.src(r.cover), a.alt('')) : null,
                    h.div(h.div(a.class('discover-detail-name'), r.name),
                        h.div(a.class('discover-card-meta'),
                            r.source === 'spotify'
                                ? 'Spotify · audio is matched & downloaded via YouTube on import'
                                : 'YouTube · audio is downloaded on import'))
                )
            ),
            h.div(a.class('discover-detail-state'),
                I.Refresh('currentColor', a.class('spinning')),
                h.span('Loading track list…')));
        box.replaceChildren(detail);
        backBtn.addEventListener('click', () => {
            this._discoverCancelled = true;
            this._discoverBusy = false;
            this._discoverRenderResults();
        });

        const data = await useDiscoveryService().previewPlaylist(r.url);
        const stateEl = detail.querySelector('.discover-detail-state');
        if (data.error) {
            stateEl?.replaceChildren(
                I.Info(), h.span(data.error?.error || 'Could not read this playlist.'));
            this._discoverBusy = false;
            return;
        }

        const p = data.value;
        this._discoverDetail = { card: r, preview: p };
        stateEl?.classList.add('hidden');

        const rows = (p.tracks || []).map((t, i) =>
            h.div(a.class('discover-track'),
                h.span(a.class('discover-track-idx'), String(i + 1)),
                h.div(a.class('discover-track-main'),
                    h.div(a.class('discover-track-title'), t.title),
                    t.artist ? h.div(a.class('discover-track-artist'), t.artist) : null),
                h.span(a.class('discover-track-dur'), fmtDur(t.duration))));

        const list = h.div(a.class('discover-track-list'), ...rows);
        if (p.note) detail.appendChild(h.div(a.class('discover-notice'), I.Info(), h.span(p.note)));
        detail.appendChild(list);

        if (rows.length > 25) {
            list.classList.add('discover-track-list--collapsed');
            const collapse = h.button(a.class('discover-collapse'),
                h.span(`Show all ${rows.length} tracks`), I.ArrowHeadDown());
            collapse.addEventListener('click', () => {
                list.classList.remove('discover-track-list--collapsed');
                collapse.remove();
            });
            list.after(collapse);
        }

        const importBtn = h.button(a.class('btn', 'btn-primary', 'discover-import-btn'),
            I.Import(), h.span(`Import ${p.total} song${p.total === 1 ? '' : 's'}`));
        importBtn.addEventListener('click', () => this._discoverImport(importBtn));
        detail.appendChild(importBtn);
        this._discoverBusy = false;
    }

    /** Re-render the cached result grid when backing out of a detail view. */
    _discoverRenderResults() {
        const box = this._discoverResults.value;
        if (!box) return;
        const results = this._discoverLastResults || [];
        const notices = this._discoverLastNotices || [];
        if (!results.length && !notices.length) {
            box.replaceChildren(this._discoverSearched
                ? h.div(a.class('discover-state'), I.Info(),
                    h.span(`No playlists found. Try different words or the other source.`))
                : this._discoverIdleState());
            return;
        }
        box.replaceChildren(
            ...notices.map(n => h.div(a.class('discover-notice'), I.Info(), h.span(n))),
            ...results.map(x => this._discoverCard(x)));
    }

    _discoverIdleState() {
        return h.div(a.class('discover-state'),
            I.Magnifier(),
            h.span('Search YouTube & Spotify by name — “rainy lofi”, “top hits”, ’80s metal”…'),
            h.div(a.class('discover-chips'),
                h.button(a.class('discover-chip'), on.click(() => this._discoverChipPre('indie mix')),'indie mix'),
                h.button(a.class('discover-chip'), on.click(() => this._discoverChipPre('workout')),'workout'),
                h.button(a.class('discover-chip'), on.click(() => this._discoverChipPre('lofi')),'lofi')));
    }

    _discoverChipPre(q) {
        if (this._discoverInput.value) this._discoverInput.value.value = q;
        this._discoverRunSearch();
    }

    /** Import hand-off: conflict check, then background job / foreground stream. */
    async _discoverImport(btn) {
        const d = this._discoverDetail;
        if (!d || btn.disabled) return;
        btn.disabled = true;
        const { card } = d;
        const url = card.url;
        const source = card.source;

        // Name collision? Ask add / replace / new (same modal as paste-URL flow).
        const conflictMode = await this._resolvePlaylistConflict(source, url);
        if (conflictMode === null) { btn.disabled = false; return; }

        try {
            const data = await useImportJobsService()
                .enqueue(source, 'playlist', url, conflictMode);
            if (data.error) {
                const msg = data.error.error || data.error.message || 'Failed to queue import';
                Utils.showToast(msg, 'error', 5000);
                btn.disabled = false;
                return;
            }
            Utils.showToast('Import queued — track it in Settings → Jobs', 'success', 4000);
            setTimeout(() => this.hide(), 800);
        } catch (e) {
            Logger.error('discover import:', e);
            Utils.showToast(String(e?.message || e), 'error', 5000);
            btn.disabled = false;
        }
    }

    _onPlaylistKeyPress = (e) => {
        if (e.key === 'Enter') {
            this.importPlaylistFromYouTube();
        }
    };

    _onSpotifySongKeyPress = (e) => {
        if (e.key === 'Enter') {
            this.importFromSpotify();
        }
    };

    _onSpotifyPlaylistKeyPress = (e) => {
        if (e.key === 'Enter') {
            this.importPlaylistFromSpotify();
        }
    };

    _onDropzoneClick = () => {
        const fileInput = this.root.querySelector('#file-upload-input');
        fileInput?.click();
    };

    _onDragOver = (e) => {
        e.preventDefault();
        const dropzone = this.root.querySelector('#upload-dropzone');
        dropzone?.classList.add('dragover');
    };

    _onDragLeave = () => {
        const dropzone = this.root.querySelector('#upload-dropzone');
        dropzone?.classList.remove('dragover');
    };

    _onDrop = (e) => {
        e.preventDefault();
        this._dropzone.value?.classList.remove('dragover');
        if (e.dataTransfer.files.length > 0) {
            this.uploadFiles(e.dataTransfer.files);
        }
    };

    _onFileChange = (e) => {
        if (e.target.files.length > 0) {
            this.uploadFiles(e.target.files);
        }
    };

    _onYouTubeKeyPress = (e) => {
        if (e.key === 'Enter') {
            this.importFromYouTube();
        }
    };

    async uploadFiles(files) {
        const dropzone = this._dropzone.value;
        const progress = this._uploadProgress.value;
        const progressFill = this._uploadProgressFill.value;
        const statusText = this._uploadStatus.value;

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

            setTimeout(() => {
                this.hide();
                window.app?.loadLibrary();
            }, 1500);
        } catch (error) {
            Logger.error('Upload error:', error);
            statusText.textContent = 'Upload failed. Please try again.';
        } finally {
            setTimeout(() => {
                dropzone.classList.remove('hidden');
                progress.classList.add('hidden');
            }, 2000);
        }
    }

    /**
     * If the "process in background" toggle is on for the given source, enqueue
     * the import as a background job and return true (caller should stop).
     * Otherwise returns false so the caller proceeds with the foreground import.
     * @param {'youtube'|'spotify'} source
     * @param {'song'|'playlist'} kind
     * @param {string} url
     * @returns {Promise<boolean>}
     */
    async _tryBackgroundImport(source, kind, url) {
        const toggle = source === 'youtube' ? this._youtubeBgToggle.value : this._spotifyBgToggle.value;
        if (!toggle || !toggle.checked) return false;

        // Playlist imports: resolve a name collision up front so the queued job
        // carries the user's choice (replace / add / new) instead of silently
        // defaulting to "add" and never updating the playlist order.
        let conflictMode;
        if (kind === 'playlist') {
            conflictMode = await this._resolvePlaylistConflict(source, url);
            if (conflictMode === null) return true; // user cancelled — enqueue nothing
        }

        const data = await useImportJobsService().enqueue(source, kind, url, conflictMode);
        if (data.error) {
            const msg = data.error.error || data.error.message || 'Failed to queue background import';
            Utils.showToast(msg, 'error', 5000);
            return false; // fall back to foreground import on failure
        }

        Utils.showToast(`Import queued — track it in Settings → Jobs`, 'success', 4000);
        setTimeout(() => this.hide(), 800);
        return true;
    }

    /**
     * Precheck an import for a playlist-name collision and, if one exists, ask
     * the user whether to add to the existing playlist, override it, or create
     * a new one. Resolves to a conflict_mode ('add' | 'override' | 'new') or
     * null if the user cancelled. When there is no collision, resolves to
     * undefined (create normally).
     */
    async _resolvePlaylistConflict(source, url) {
        const pre = await useMusicService().precheckImportPlaylist(source, url);
        if (pre.error || !pre.value) {
            // Precheck failed (e.g. couldn't read the playlist). Let the import
            // proceed and surface the real error there.
            return undefined;
        }
        if (!pre.value.exists) return undefined;

        const name = pre.value.playlist_name;
        return new Promise((resolve) => {
            const overlay = h.div(a.class('modal-overlay'),
                h.div(a.class('modal-content'),
                    h.div(a.class('modal-header'),
                        h.div(a.class('modal-header-info'),
                            h.div(a.class('modal-icon'), I.Note()),
                            h.div(a.class('modal-header-title'),
                                h.div('Playlist already exists'),
                                h.p(a.class('modal-subtitle'), `“${name}” is already in your library`)
                            )
                        )
                    ),
                    h.div(a.class('modal-body'),
                        h.p(a.style('color:var(--text-secondary);margin:0 0 16px;line-height:1.5'),
                            'A playlist with this name already exists. Replace it to update its songs and order, or add only the new songs while keeping the current order.'),
                        h.div(a.class('modal-actions'),
                            h.button(a.class('btn'), on.click(() => done('new')), 'Create new'),
                            h.button(a.class('btn', 'btn-danger'), on.click(() => done('override')), 'Replace'),
                            h.button(a.class('btn', 'btn-primary'), on.click(() => done('add')), 'Add new songs')
                        )
                    )
                )
            );
            const done = (mode) => {
                overlay.remove();
                resolve(mode);
            };
            // Cancel on backdrop click.
            overlay.addEventListener('click', (ev) => {
                if (ev.target === overlay) done(null);
            });
            document.body.appendChild(overlay);
        });
    }

    async importFromYouTube() {
        const urlInput = this._youtubeInput.value;
        const importBtn = this._youtubeImportBtn.value;
        const status = this._youtubeStatus.value;
        const statusText = this._youtubeStatusText.value;
        const progressFill = this._youtubeProgressFill.value;

        const url = urlInput.value.trim();
        if (!url) {
            urlInput.focus();
            return;
        }

        if (await this._tryBackgroundImport('youtube', 'song', url)) {
            urlInput.value = '';
            return;
        }

        importBtn.disabled = true;
        status.classList.remove('hidden');
        progressFill.style.width = '0%';

        const updateProgress = (percent, message) => {
            progressFill.style.width = `${percent}%`;
            statusText.textContent = message;
        };

        updateProgress(10, 'Connecting to YouTube...');

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

        const data = await useMusicService().YouTube.import(url);
        clearInterval(progressInterval);

        if (data.error) {
            Logger.error(data.error);

            importBtn.disabled = false;
            status.classList.add('hidden');
            progressFill.style.width = '0%';

            const errorMessage = data.error.error || data.error.message || 'Failed to import from YouTube. Please check the URL and try again.';
            Utils.showToast(errorMessage, 'error', 5000);

            return;
        }

        const result = data.value;
        if (!result) return Logger.error('unreachable');

        // Check if song already existed
        if (result.already_exists) {
            updateProgress(100, `Song already in library`);
            window.Utils.showToast(result.message || `"${result.title}" by ${result.artist} already exists`, 'error', 4000);
            setTimeout(() => {
                status.classList.add('hidden');
                progressFill.style.width = '0%';
                urlInput.value = '';
            }, 1500);
            importBtn.disabled = false;
            return;
        }

        updateProgress(100, `✓ Imported: ${result.title || 'song'}`);
        setTimeout(() => {
            this.hide();
            window.app?.loadLibrary();
        }, 1500);

        importBtn.disabled = false;
    }

    async importPlaylistFromYouTube() {
        const urlInput = this._playlistInput.value;
        const importBtn = this._playlistImportBtn.value;
        const status = this._playlistStatus.value;
        const statusText = this._playlistStatusText.value;
        const progressFill = this._playlistProgressFill.value;

        const url = urlInput.value.trim();
        if (!url) {
            urlInput.focus();
            return;
        }

        if (await this._tryBackgroundImport('youtube', 'playlist', url)) {
            urlInput.value = '';
            return;
        }

        importBtn.disabled = true;
        status.classList.remove('hidden');
        progressFill.style.width = '0%';

        const updateProgress = (percent, message) => {
            progressFill.style.width = `${percent}%`;
            statusText.textContent = message;
        };

        updateProgress(5, 'Checking for conflicts...');

        const conflictMode = await this._resolvePlaylistConflict('youtube', url);
        if (conflictMode === null) {
            importBtn.disabled = false;
            status.classList.add('hidden');
            progressFill.style.width = '0%';
            return;
        }

        updateProgress(10, 'Fetching playlist...');

        const data = await useMusicService().YouTube.importPlaylist(url, (event) => {
            updateProgress(event.percent, event.message);
        }, conflictMode);

        if (data.error) {
            Logger.error(data.error);

            importBtn.disabled = false;
            status.classList.add('hidden');
            progressFill.style.width = '0%';

            const errorMessage = data.error.error || data.error.message || 'Failed to import playlist. Please check the URL and try again.';
            Utils.showToast(errorMessage, 'error', 5000);

            return;
        }

        const result = data.value;
        if (!result) return Logger.error('unreachable');

        updateProgress(100, `✓ Imported: ${result.song_count} songs to "${result.playlist_name}"`);
        setTimeout(() => {
            this.hide();
            window.app?.loadLibrary();
            window.app?.loadPlaylists();
        }, 2000);

        importBtn.disabled = false;
    }

    async importFromSpotify() {
        const urlInput = this._spotifySongInput.value;
        const importBtn = this._spotifySongImportBtn.value;
        const status = this._spotifySongStatus.value;
        const statusText = this._spotifySongStatusText.value;
        const progressFill = this._spotifySongProgressFill.value;

        const url = urlInput.value.trim();
        if (!url) {
            urlInput.focus();
            return;
        }

        if (await this._tryBackgroundImport('spotify', 'song', url)) {
            urlInput.value = '';
            return;
        }

        importBtn.disabled = true;
        status.classList.remove('hidden');
        progressFill.style.width = '0%';

        const updateProgress = (percent, message) => {
            progressFill.style.width = `${percent}%`;
            statusText.textContent = message;
        };

        updateProgress(10, 'Fetching track from Spotify...');

        let currentProgress = 10;
        const progressInterval = setInterval(() => {
            if (currentProgress < 85) {
                currentProgress += Math.random() * 5;
                const messages = [
                    'Matching on YouTube Music...',
                    'Downloading audio...',
                    'Converting to MP3...',
                    'Downloading cover art...'
                ];
                const messageIndex = Math.min(Math.floor(currentProgress / 25), messages.length - 1);
                updateProgress(currentProgress, messages[messageIndex]);
            }
        }, 500);

        const data = await useMusicService().Spotify.import(url);
        clearInterval(progressInterval);

        if (data.error) {
            Logger.error(data.error);

            importBtn.disabled = false;
            status.classList.add('hidden');
            progressFill.style.width = '0%';

            const errorMessage = data.error.error || data.error.message || 'Failed to import from Spotify. Please check the URL and try again.';
            Utils.showToast(errorMessage, 'error', 5000);

            return;
        }

        const result = data.value;
        if (!result) return Logger.error('unreachable');

        if (result.already_exists) {
            updateProgress(100, `Song already in library`);
            Utils.showToast(result.message || `"${result.title}" by ${result.artist} already exists`, 'error', 4000);
            setTimeout(() => {
                status.classList.add('hidden');
                progressFill.style.width = '0%';
                urlInput.value = '';
            }, 1500);
            importBtn.disabled = false;
            return;
        }

        updateProgress(100, `✓ Imported: ${result.title || 'song'}`);
        setTimeout(() => {
            this.hide();
            window.app?.loadLibrary();
        }, 1500);

        importBtn.disabled = false;
    }

    async importPlaylistFromSpotify() {
        const urlInput = this._spotifyPlaylistInput.value;
        const importBtn = this._spotifyPlaylistImportBtn.value;
        const status = this._spotifyPlaylistStatus.value;
        const statusText = this._spotifyPlaylistStatusText.value;
        const progressFill = this._spotifyPlaylistProgressFill.value;

        const url = urlInput.value.trim();
        if (!url) {
            urlInput.focus();
            return;
        }

        if (await this._tryBackgroundImport('spotify', 'playlist', url)) {
            urlInput.value = '';
            return;
        }

        importBtn.disabled = true;
        status.classList.remove('hidden');
        progressFill.style.width = '0%';

        const updateProgress = (percent, message) => {
            progressFill.style.width = `${percent}%`;
            statusText.textContent = message;
        };

        updateProgress(2, 'Checking for conflicts...');

        const conflictMode = await this._resolvePlaylistConflict('spotify', url);
        if (conflictMode === null) {
            importBtn.disabled = false;
            status.classList.add('hidden');
            progressFill.style.width = '0%';
            return;
        }

        updateProgress(5, 'Fetching playlist from Spotify...');

        const data = await useMusicService().Spotify.importPlaylist(url, (event) => {
            updateProgress(event.percent, event.message);
        }, conflictMode);

        if (data.error) {
            Logger.error(data.error);

            importBtn.disabled = false;
            status.classList.add('hidden');
            progressFill.style.width = '0%';

            const errorMessage = data.error.error || data.error.message || 'Failed to import from Spotify. Please check the URL and try again.';
            Utils.showToast(errorMessage, 'error', 5000);

            return;
        }

        const result = data.value;
        if (!result) return Logger.error('unreachable');

        const failedNote = result.failed_count > 0 ? ` (${result.failed_count} failed)` : '';
        updateProgress(100, `✓ Imported: ${result.song_count} songs to "${result.playlist_name}"${failedNote}`);
        setTimeout(() => {
            this.hide();
            window.app?.loadLibrary();
            window.app?.loadPlaylists();
        }, 2000);

        importBtn.disabled = false;
    }

    render() {
        const currentMethod = this.get('current-method');
        const uploadActive = currentMethod === 'upload' ? 'active' : '';
        const youtubeActive = currentMethod === 'youtube' ? 'active' : '';
        const spotifyActive = currentMethod === 'spotify' ? 'active' : '';
        const discoverActive = currentMethod === 'discover' ? 'active' : '';

        return H.of(Modal,
            I.Note('currentColor', a.slot('header-icon')),
            h.h2(a.slot('header-title'), 'Add Music'),
            h.p(a.slot('header-subtitle'), a.class('modal-subtitle'), 'Import songs to your library'),
            h.div(a.slot('body'), a.class('add-music-methods'),
                h.div(a.class('add-music-method', uploadActive), a.dataMethod('upload'), on.click(() => this.switchMethod('upload')),
                    h.div(a.class('method-icon'),
                        I.Upload()
                    ),
                    h.div(a.class('method-info'),
                        h.span(a.class('method-title'), 'Upload Files')
                    ),
                    h.div(a.class('method-check'),
                        I.Check()
                    )
                ),
                h.div(a.class('add-music-method', youtubeActive), a.dataMethod('youtube'), on.click(() => this.switchMethod('youtube')),
                    h.div(a.class('method-icon', 'youtube'),
                        I.Yt()
                    ),
                    h.div(a.class('method-info'),
                        h.span(a.class('method-title'), 'YouTube Import')
                    ),
                    h.div(a.class('method-check'),
                        I.Check()
                    )
                ),
                h.div(a.class('add-music-method', spotifyActive), a.dataMethod('spotify'), on.click(() => this.switchMethod('spotify')),
                    h.div(a.class('method-icon', 'spotify'),
                        I.Spotify()
                    ),
                    h.div(a.class('method-info'),
                        h.span(a.class('method-title'), 'Spotify Import')
                    ),
                    h.div(a.class('method-check'),
                        I.Check()
                    )
                ),
                h.div(a.class('add-music-method', discoverActive), a.dataMethod('discover'), on.click(() => this.switchMethod('discover')),
                    h.div(a.class('method-icon', 'discover'),
                        I.Magnifier()
                    ),
                    h.div(a.class('method-info'),
                        h.span(a.class('method-title'), 'Discover')
                    ),
                    h.div(a.class('method-check'),
                        I.Check()
                    )
                )
            ),
            h.div(a.slot('body'), a.class('add-music-content', discoverActive), a.dataMethod('discover'), a.id('discover-content'),
                h.div(a.class('discover-bar'),
                    h.div(a.class('youtube-input-field'),
                        I.Magnifier('currentColor', a.class('input-icon-svg')),
                        h.input(this._discoverInput, a.type('search'), a.id('discover-search-input'), a.placeholder('Search playlists by name…'), a.autocomplete('off'), on.keypress((ev) => this._onDiscoverKeyPress(ev)))
                    ),
                    h.button(a.class('btn', 'btn-primary'), on.click(() => this._discoverRunSearch()), 'Search')
                ),
                h.div(a.class('youtube-tabs', 'discover-source-tabs'),
                    ...['all', 'youtube', 'spotify'].map((src, i) => {
                        const btn = h.div(a.class('youtube-tab', 'discover-source-tab', i === 0 ? 'active' : ''),
                            a.dataSource(src), on.click(() => this._discoverSetSource(src)),
                            h.span(a.class('tab-label'), src === 'all' ? 'YouTube + Spotify' : src === 'youtube' ? 'YouTube' : 'Spotify'));
                        return btn;
                    })
                ),
                h.div(this._discoverResults, a.class('discover-results'), a.id('discover-results'))
            ),
            h.div(a.slot('body'), a.class('add-music-content', uploadActive), a.dataMethod('upload'), a.id('upload-content'),
                h.div(this._dropzone, a.class('upload-dropzone-modern'), a.id('upload-dropzone'),
                    on.click(() => this._onDropzoneClick()),
                    on.dragover((ev) => this._onDragOver(ev)),
                    on.dragleave(() => this._onDragLeave()),
                    on.drop((ev) => this._onDrop(ev)),
                    h.div(a.class('dropzone-icon-wrapper'),
                        I.Note(),
                        h.div(a.class('dropzone-icon-glow'))
                    ),
                    h.div(a.class('dropzone-text-group'),
                        h.p(a.class('dropzone-title'), 'Drop your audio files here'),
                        h.p(a.class('dropzone-subtitle'),
                            'or ',
                            h.span(a.class('dropzone-browse'), 'browse'),
                            ' to choose files'
                        )
                    ),
                    h.div(a.class('dropzone-formats'),
                        h.span(a.class('format-tag'), 'MP3'),
                        h.span(a.class('format-tag'), 'FLAC'),
                        h.span(a.class('format-tag'), 'WAV'),
                        h.span(a.class('format-tag'), 'OGG'),
                    ),
                    h.input(this._fileInput, a.type('file'), a.id('file-upload-input'), a.accept('audio/*'), a.multiple(''), a.hidden(''), on.change((ev) => this._onFileChange(ev)))
                ),
                h.div(this._uploadProgress, a.class('upload-progress-modern', 'hidden'), a.id('upload-progress'),
                    h.div(a.class('progress-info'),
                        I.Refresh('currentColor', a.class('progress-icon', 'spinning')),
                        h.span(this._uploadStatus, a.id('upload-status'), 'Uploading...')
                    ),
                    h.div(a.class('progress-bar-modern'),
                        h.div(this._uploadProgressFill, a.class('progress-fill-modern'), a.id('upload-progress-fill'))
                    )
                )
            ),
            h.div(a.slot('body'), a.class('add-music-content', youtubeActive), a.dataMethod('youtube'), a.id('youtube-content'),
                h.div(a.class('youtube-tabs'),
                    h.div(a.class('youtube-tab', 'youtube-tab-song', 'active'), on.click(() => this.switchYouTubeTab('song')),
                        h.span(a.class('tab-label'), 'Song')
                    ),
                    h.div(a.class('youtube-tab', 'youtube-tab-playlist'), on.click(() => this.switchYouTubeTab('playlist')),
                        h.span(a.class('tab-label'), 'Playlist')
                    )
                ),
                h.label(a.class('bg-import-toggle'),
                    h.span(a.class('bg-import-toggle-text'),
                        h.span(a.class('bg-import-toggle-title'), 'Process in background'),
                        h.span(a.class('bg-import-toggle-hint'), 'Queue this import as a job — track it in Settings → Jobs')
                    ),
                    h.span(a.class('toggle-switch'),
                        h.input(this._youtubeBgToggle, a.type('checkbox'), a.id('youtube-bg-toggle'), a.class('bg-import-checkbox')),
                        h.span(a.class('toggle-slider'))
                    )
                ),
                h.div(a.class('youtube-song-content'),
                    h.div(a.class('youtube-input-wrapper'),
                        h.div(a.class('youtube-input-field'),
                            I.Share('currentColor', a.class('input-icon-svg')),
                            h.input(this._youtubeInput, a.type('text'), a.id('youtube-url-input'), a.placeholder('Paste YouTube or YouTube Music URL...'), on.keypress((ev) => this._onYouTubeKeyPress(ev)))
                        ),
                        h.button(this._youtubeImportBtn, a.class('btn', 'btn-primary', 'youtube-import-btn'), a.id('youtube-import-btn'), on.click(() => this.importFromYouTube()),
                            I.Import(),
                            'Import'
                        )
                    ),
                    h.div(this._youtubeStatus, a.class('youtube-status-modern', 'hidden'), a.id('youtube-status'),
                        h.div(a.class('status-card'),
                            h.div(a.class('status-icon'),
                                I.Refresh('currentColor', a.class('spinning'))
                            ),
                            h.div(a.class('status-info'),
                                h.span(this._youtubeStatusText, a.class('status-title'), a.id('youtube-status-text'), 'Importing from YouTube...'),
                                h.div(a.class('progress-bar-modern'),
                                    h.div(this._youtubeProgressFill, a.class('progress-fill-modern'), a.id('youtube-progress-fill'))
                                )
                            )
                        )
                    ),
                    h.div(a.class('youtube-tips'),
                        h.div(a.class('tip-item'),
                            I.Info(),
                            h.span('Supports YouTube and YouTube Music URLs')
                        )
                    )
                ),
                h.div(a.class('youtube-playlist-content', 'hidden'),
                    h.div(a.class('youtube-input-wrapper'),
                        h.div(a.class('youtube-input-field'),
                            I.Share('currentColor', a.class('input-icon-svg')),
                            h.input(this._playlistInput, a.type('text'), a.id('playlist-url-input'), a.placeholder('Paste YouTube Music playlist URL...'), on.keypress((ev) => this._onPlaylistKeyPress(ev)))
                        ),
                        h.button(this._playlistImportBtn, a.class('btn', 'btn-primary', 'youtube-import-btn'), a.id('playlist-import-btn'), on.click(() => this.importPlaylistFromYouTube()),
                            I.Import(),
                            'Import Playlist'
                        )
                    ),
                    h.div(this._playlistStatus, a.class('youtube-status-modern', 'hidden'), a.id('playlist-status'),
                        h.div(a.class('status-card'),
                            h.div(a.class('status-icon'),
                                I.Refresh('currentColor', a.class('spinning'))
                            ),
                            h.div(a.class('status-info'),
                                h.span(this._playlistStatusText, a.class('status-title'), a.id('playlist-status-text'), 'Importing playlist...'),
                                h.div(a.class('progress-bar-modern'),
                                    h.div(this._playlistProgressFill, a.class('progress-fill-modern'), a.id('playlist-progress-fill'))
                                )
                            )
                        )
                    ),
                    h.div(a.class('youtube-tips'),
                        h.div(a.class('tip-item'),
                            I.Info(),
                            h.span('Creates a new playlist with all songs from the YouTube Music playlist')
                        )
                    )
                )
            ),
            h.div(a.slot('body'), a.class('add-music-content', spotifyActive), a.dataMethod('spotify'), a.id('spotify-content'),
                h.div(a.class('youtube-tabs'),
                    h.div(a.class('youtube-tab', 'spotify-tab-song', 'active'), on.click(() => this.switchSpotifyTab('song')),
                        h.span(a.class('tab-label'), 'Song')
                    ),
                    h.div(a.class('youtube-tab', 'spotify-tab-playlist'), on.click(() => this.switchSpotifyTab('playlist')),
                        h.span(a.class('tab-label'), 'Playlist')
                    )
                ),
                h.label(a.class('bg-import-toggle'),
                    h.span(a.class('bg-import-toggle-text'),
                        h.span(a.class('bg-import-toggle-title'), 'Process in background'),
                        h.span(a.class('bg-import-toggle-hint'), 'Queue this import as a job — track it in Settings → Jobs')
                    ),
                    h.span(a.class('toggle-switch'),
                        h.input(this._spotifyBgToggle, a.type('checkbox'), a.id('spotify-bg-toggle'), a.class('bg-import-checkbox')),
                        h.span(a.class('toggle-slider'))
                    )
                ),
                h.div(a.class('spotify-song-content'),
                    h.div(a.class('youtube-input-wrapper'),
                        h.div(a.class('youtube-input-field'),
                            I.Share('currentColor', a.class('input-icon-svg')),
                            h.input(this._spotifySongInput, a.type('text'), a.id('spotify-song-url-input'), a.placeholder('Paste Spotify track URL...'), on.keypress((ev) => this._onSpotifySongKeyPress(ev)))
                        ),
                        h.button(this._spotifySongImportBtn, a.class('btn', 'btn-primary', 'youtube-import-btn'), a.id('spotify-song-import-btn'), on.click(() => this.importFromSpotify()),
                            I.Import(),
                            'Import'
                        )
                    ),
                    h.div(this._spotifySongStatus, a.class('youtube-status-modern', 'hidden'), a.id('spotify-song-status'),
                        h.div(a.class('status-card'),
                            h.div(a.class('status-icon'),
                                I.Refresh('currentColor', a.class('spinning'))
                            ),
                            h.div(a.class('status-info'),
                                h.span(this._spotifySongStatusText, a.class('status-title'), a.id('spotify-song-status-text'), 'Importing from Spotify...'),
                                h.div(a.class('progress-bar-modern'),
                                    h.div(this._spotifySongProgressFill, a.class('progress-fill-modern'), a.id('spotify-song-progress-fill'))
                                )
                            )
                        )
                    ),
                    h.div(a.class('youtube-tips'),
                        h.div(a.class('tip-item'),
                            I.Info(),
                            h.span('Imports a single song by matching it on YouTube Music')
                        )
                    )
                ),
                h.div(a.class('spotify-playlist-content', 'hidden'),
                    h.div(a.class('youtube-input-wrapper'),
                        h.div(a.class('youtube-input-field'),
                            I.Share('currentColor', a.class('input-icon-svg')),
                            h.input(this._spotifyPlaylistInput, a.type('text'), a.id('spotify-playlist-url-input'), a.placeholder('Paste Spotify playlist URL...'), on.keypress((ev) => this._onSpotifyPlaylistKeyPress(ev)))
                        ),
                        h.button(this._spotifyPlaylistImportBtn, a.class('btn', 'btn-primary', 'youtube-import-btn'), a.id('spotify-playlist-import-btn'), on.click(() => this.importPlaylistFromSpotify()),
                            I.Import(),
                            'Import Playlist'
                        )
                    ),
                    h.div(this._spotifyPlaylistStatus, a.class('youtube-status-modern', 'hidden'), a.id('spotify-playlist-status'),
                        h.div(a.class('status-card'),
                            h.div(a.class('status-icon'),
                                I.Refresh('currentColor', a.class('spinning'))
                            ),
                            h.div(a.class('status-info'),
                                h.span(this._spotifyPlaylistStatusText, a.class('status-title'), a.id('spotify-playlist-status-text'), 'Importing playlist...'),
                                h.div(a.class('progress-bar-modern'),
                                    h.div(this._spotifyPlaylistProgressFill, a.class('progress-fill-modern'), a.id('spotify-playlist-progress-fill'))
                                )
                            )
                        )
                    ),
                    h.div(a.class('youtube-tips'),
                        h.div(a.class('tip-item'),
                            I.Info(),
                            h.span('Creates a new playlist with all songs from the Spotify playlist')
                        )
                    )
                )
            )
        );
    }
};

customElements.define(AddMusicModal.componentName, AddMusicModal);