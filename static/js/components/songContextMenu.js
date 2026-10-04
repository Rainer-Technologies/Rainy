import { Modal } from "../components/modal.js";
import { useContext } from "../helper/context.js";
import { Logger } from "../helper/logger.js";
import { useMusicService } from "../services/music.js";
import { usePlaylistService } from "../services/playlist.js";
import { ContextMenu, ContextMenuItem, ContextSubMenu } from "./contextMenu.js";
import { I } from "./icon.js";
import { a, Component, h, H, on, p, Ref, s, useRef } from "./index.js";
import { t } from "../i18n/index.js";
import { playlistDisplayName } from "../modules/playlists.js";

/**
 * @typedef {Object} SongModel
 * @property {number} id
 * @property {string} title
 * @property {string} artist
 */

export class SongContextMenu extends Component {
    static componentName = 'rainy-song-context-menu';

    created() {
        /** @type {Ref<HTMLDivElement>} */
        this._removeFromPlaylist = useRef(null);
        /** @type {Ref<HTMLDivElement>} */
        this._playlistList = useRef(null);
        /** @type {Ref<HTMLDivElement>} */
        this._removeSongItem = useRef(null);
        /** @type {Ref<HTMLDivElement>} */
        this._publishSongItem = useRef(null);
        /** @type {Ref<HTMLDivElement>} */
        this._findMetadataItem = useRef(null);

        this.set('current-song', null, { silent: true });
        this.set('current-view-watcher', useContext().listen('current-view-type', (_path, _oldValue, newValue) => {
            this._updateRemoveItem();
        }));
    }

    destroyed() {
        this.get('current-view-watcher')();
    }

    /**
     * "Remove from Playlist" only makes sense on an editable playlist —
     * viewers of a shared playlist get read-only rows. Re-evaluated on
     * every menu open (show) and on view-type changes, so it can never
     * go stale when switching between playlists.
     */
    _updateRemoveItem() {
        if (!this._removeFromPlaylist.value) return;
        const item = this._removeFromPlaylist.value;
        if (useContext().get('current-view-type') !== 'playlist') {
            item.style.display = 'none';
            return;
        }
        /** @type {import('../app.js').RainyApp} */
        const app = useContext().get('app');
        item.style.display = app?.currentPlaylistCanEdit?.() ? 'block' : 'none';
    }

    /**
     * "Remove Song" removes the track from the CURRENT view. On a shared
     * playlist the viewer doesn't own, that reads as (and acts like)
     * removing from the shared playlist — the wrong tool. Hide it there;
     * keep it for the library and own playlists (where it means "remove
     * from my library").
     */
    _updateRemoveSongItem() {
        if (!this._removeSongItem.value) return;
        const item = this._removeSongItem.value;
        /** @type {import('../app.js').RainyApp} */
        const app = useContext().get('app');
        const inSharedPlaylist =
            useContext().get('current-view-type') === 'playlist' &&
            (app?.currentPlaylistRole ?? null) !== null &&
            (app?.currentPlaylistRole ?? null) !== 'owner';
        item.style.display = inSharedPlaylist ? 'none' : 'block';
    }

    /**
     * @param {SongModel} song 
     */
    setCurrentSong(song) {
        this.set('current-song', song);
    }

    /** Sysadmin: publish a personally-imported song to every account. */
    async publishCurrentSong() {
        this.hide();

        const song = this.get('current-song');
        if(!song) return;

        try {
            const res = await fetch(`/api/users/library/publish/${song.id}`, {
                method: 'POST', credentials: 'same-origin',
            });
            const data = await res.json();
            if (!res.ok || !data.success) throw new Error(data.error || 'Publish failed');
            window.showToast?.('Song published to all accounts', 'success');
        } catch (e) {
            Logger.error(e);
            window.showToast?.(e.message, 'error');
        }
    }

    deleteCurrentSong() {
        this.hide();

        /** @type {SongModel?} */
        const song = this.get('current-song');
        if(!song) return;

        /** @type {Modal} */
        const dialog = H.of(Modal,
            I.Bin('currentColor', a.slot('header-icon')),
            h.h2(a.slot('header-title'), t('Delete song')),
            h.p(a.slot('body'), t('Are you sure you want to delete this song? This action cannot be undone.')),
            h.button(a.slot('action'), a.class('btn btn-secondary'), on.click(() => {
                dialog.remove();
            }), t('Cancel')),
            h.button(a.slot('action'), a.class('btn btn-danger'), on.click(async () => {
                dialog.remove();

                const data = await useMusicService().delete(song.id)
                if(data.error) {
                    Logger.error(data.error);
                    window.showToast?.(data.error.error || data.error.message || 'Failed to remove song', 'error');
                    return;
                }

                const result = data.value;
                if(!result) return Logger.error('unreachable');

                const currentSong = window.player.getCurrentSong();
                if (currentSong && currentSong.id === song.id) {
                    window.player.audio.pause();
                    window.player.audio.src = '';
                }

                /** @type {import('../app.js').RainyApp} */
                const app = useContext().get('app');
                app.loadLibrary();
            }), t('Delete')),
        ); document.body.append(dialog); dialog.show();
    }

    /** 
     * @param {import('../services/playlist.js').PlaylistModel} playlist
     */
    async addCurrentSongToPlaylist(playlist) {
        this.hide();

        /** @type {SongModel?} */
        const currentSong = this.get('current-song');
        if(!currentSong) return;

        /** @type {import('../app.js').RainyApp} */
        const app = useContext().get('app');

        // Client-side permission guard: viewer shares would 403 server-side.
        if (playlist.shared && playlist.share_role !== 'admin') {
            app?.showToast?.('You can only view that playlist', 'error');
            return;
        }

        const data = await usePlaylistService().addSong(playlist.id, currentSong.id);
        if (data.error) {
            Logger.error(data.error);
            app.showToast(data.error.error || data.error.message || 'Failed to add song to playlist', 'error');

            return;
        }

        app.showToast(t('Added to "{name}"', { name: playlistDisplayName(playlist.name) }), 'success');
        app.refreshPlayerQueueIfNeeded(playlist.id);
    }

    async removeCurrentSongFromPlaylist() {
        this.hide();

        /** @type {SongModel?} */
        const currentSong = this.get('current-song');
        if(!currentSong) return;

        /** @type {import('../app.js').RainyApp} */
        const app = useContext().get('app');

        // Client-side permission guard: never even attempt a remove the
        // backend will reject (stale menus, role changes mid-session).
        if (!app?.currentPlaylistCanEdit?.()) {
            app?.showToast?.('You can only view this playlist', 'error');
            return;
        }

        const data = await usePlaylistService().removeSong(app.currentPlaylistId, currentSong.id);
        if (data.error) {
            Logger.error(data.error);
            app.showToast(data.error.error || data.error.message || 'Failed to remove song from playlist', 'error');
            return;
        }

        const playlist = app.playlists.find(p => p.id === app.currentPlaylistId);
        const playlistName = playlist ? playlistDisplayName(playlist.name) : t('playlist');

        app.showToast(t('Removed from "{name}"', { name: playlistName }), 'success');
        await app.openPlaylist(app.currentPlaylistId);
        await app.refreshPlayerQueueIfNeeded(app.currentPlaylistId);

        // If removing from Liked Music, also update player like state
        if(playlist && (playlist.name || '').toLowerCase() === 'liked music' && window.player) {
            try {
                await window.player.ensureLikedDataInitialized();

                const songId = parseInt(currentSong.id);
                if(window.player.likedSongIds && window.player.likedSongIds.has(songId)) {
                    window.player.likedSongIds.delete(songId);
                    window.player.updateReactionButtons();
                    if(window.app && typeof window.app.loadPlaylists === 'function') {
                        window.app.loadPlaylists();
                    }
                }
            } catch (e) { Logger.error(e) }
        }
    }

    async _renderPlaylists() {
        const item = this._playlistList.value;
        Array.from(item.children).forEach(el => el.remove());

        const data = await usePlaylistService().all();
        // FIXME: Add toast notification
        if(data.error) return Logger.error(data.error);
        
        // Only list playlists the user may add songs to: their own and
        // shared ones where they are an 'admin'. Viewer shares would 403.
        const playlists = (data.value || []).filter(p =>
            (p.name || '').toLowerCase() !== 'liked music' &&
            (!p.shared || p.share_role === 'admin'));
        if(!playlists) return Logger.error('unreachable');

        for(const playlist of playlists) {
            item.append(H.of(ContextMenuItem, on.click(() => this.addCurrentSongToPlaylist(playlist)),
                s.svg(a.viewBox('0 0 24 24'), a.fill('currentColor'),
                    s.path(a.d('M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z'))
                ),
                h.span(playlistDisplayName(playlist.name))
            ));
        }
    }

    async newPlaylist() {
        this.hide();

        /** @type {import('../components/modal.js').Modal} */
        const modal = document.querySelector('rainy-new-playlist-modal');
        if(!modal) return;

        modal.show();
    }

    /**
     * @param {number} position 
     * @returns {void}
     */
    _insertCurrentSongAtPosition(position) {
        /** @type {SongModel?} */
        const currentSong = this.get('current-song');
        if(!currentSong) return;

        /** @type {import('../app.js').RainyApp} */
        const app = useContext().get('app');
        const player = window.player;

        const song = app.songs.find(s => s.id == currentSong.id);
        if(!song) {
            app.showToast('Song not found', 'error');
            return;
        };

        if(!player || player.currentIndex < 0) {
            player.playSong(0, [song], { type: 'library', id: null });
            app.showToast(t('Now playing: "{title}"', { title: song.title }), 'success');

            return;
        }

        player.playlist.splice(position, 0, song);
        player.queueOperations.push({
            action: 'add',
            songId: song.id,
            position
        });

        player.queueModified = true;
        player.savePlaybackState();

        if(player.fsQueueList) player.renderFullscreenQueue();
        app.showToast(t('"{title}" added to queue ({count} songs away)', { title: song.title, count: position - player.currentIndex }), 'success');
    }

    addCurrentSongToQueue() {
        const player = window.player;
        this._insertCurrentSongAtPosition(player.playlist.length);
    }

    playCurrentSongAsNext() {
        const player = window.player;
        this._insertCurrentSongAtPosition(player.currentIndex + 1);
    }

    findMetadataForCurrentSong() {
        this.hide();

        /** @type {SongModel?} */
        const currentSong = this.get('current-song');
        if(!currentSong) return;

        /** @type {import('../components/metadataModal.js').MetadataModal} */
        const modal = document.querySelector('rainy-metadata-modal');
        if(!modal) return;

        modal.show(currentSong);
    }

    downloadCurrentSong() {
        this.hide();

        /** @type {SongModel?} */
        const song = this.get('current-song');
        if(!song) return;

        window.location.href = `/api/music/download/${song.id}`;
    }

    // --------------------------------------------------------- Song settings

    openSongSettings() {
        this.hide();

        /** @type {SongModel?} */
        const currentSong = this.get('current-song');
        if(!currentSong) return;

        /** @type {import('../components/songSettingsModal.js').SongSettingsModal} */
        const modal = document.querySelector('rainy-song-settings-modal');
        if(!modal) return;

        modal.show(currentSong);
    }

    /**
     * @param {import('./contextMenu.js').Position} pos 
     */
    setPosition(pos) {
        this.root.setPosition(pos);
    }

    /**
     * @param {import('./contextMenu.js').Position?} pos 
     */
    show(pos) {
        // Re-evaluate per-open so the menu reflects the user's CURRENT
        // permissions (role can change between playlist switches).
        this._updateRemoveItem();
        this._updateRemoveSongItem();
        // "Publish to Everyone" is sysadmin-only.
        if (this._publishSongItem.value) {
            /** @type {import('../app.js').RainyApp} */
            const app = useContext().get('app');
            const isAdmin = app?.user?.role === 'sysadmin';
            this._publishSongItem.value.style.display = isAdmin ? 'block' : 'none';
        }
        // "Find Metadata" edits the shared song row via /metadata/apply
        // (access-checked but a system-wide write) — sysadmins only.
        if (this._findMetadataItem.value) {
            /** @type {import('../app.js').RainyApp} */
            const app = useContext().get('app');
            const isAdmin = app?.user?.role === 'sysadmin';
            this._findMetadataItem.value.style.display = isAdmin ? 'block' : 'none';
        }
        this.root.show(pos);
    }

    hide() {
        this.root.hide();
    }

    render() {
        return H.of(ContextMenu,
            H.of(ContextMenuItem, a.hasSubmenu(),
                I.ListWithPlus(),
                h.span(t('Add to Playlist')),
                H.of(ContextSubMenu, p.onOpen(() => this._renderPlaylists()),
                    H.of(ContextMenuItem, on.click(() => this.newPlaylist()),
                        I.Plus(),
                        h.span(t('New Playlist')),
                    ),
                    h.div(a.class('dropdown-divider')),
                    h.div(this._playlistList, a.style('overflow-y: auto;', 'max-height: 200px;'))
                )
            ),
            h.div(a.class('context-menu-divider')),
            H.of(ContextMenuItem, a.hasSubmenu(),
                I.Play(),
                h.span(t('Playback')),
                H.of(ContextSubMenu,
                    H.of(ContextMenuItem, on.click(() => this.playCurrentSongAsNext()),
                        I.Next(),
                        h.span(t('Play Next')),
                    ),
                    H.of(ContextMenuItem, on.click(() => this.addCurrentSongToQueue()),
                        I.ListWithPlay(),
                        h.span(t('Add to Queue')),
                    ),
                )
            ),
            H.of(ContextMenuItem, a.hasSubmenu(),
                I.Cog(),
                h.span(t('Song Tools')),
                H.of(ContextSubMenu,
                    H.of(ContextMenuItem, this._findMetadataItem, on.click(() => this.findMetadataForCurrentSong()),
                        I.Magnifier(),
                        h.span(t('Find Metadata')),
                    ),
                    H.of(ContextMenuItem, on.click(() => this.openSongSettings()),
                        I.Cog(),
                        h.span(t('Song Settings')),
                    ),
                    H.of(ContextMenuItem, on.click(() => this.downloadCurrentSong()),
                        I.Download(),
                        h.span(t('Download Song')),
                    ),
                )
            ),
            h.div(a.class('context-menu-divider')),
            H.of(ContextMenuItem, this._removeFromPlaylist, a.danger(), on.click(() => this.removeCurrentSongFromPlaylist()),
                I.Bin(),
                h.span(t('Remove from Playlist')),
            ),
            H.of(ContextMenuItem, this._publishSongItem, on.click(() => this.publishCurrentSong()),
                I.Plus(),
                h.span(t('Publish to Everyone')),
            ),
            h.div(a.class('context-menu-divider')),
            H.of(ContextMenuItem, this._removeSongItem, a.danger(), on.click(() => this.deleteCurrentSong()),
                I.Bin(),
                h.span(t('Remove Song')),
            ),
        );
    }
};

customElements.define(SongContextMenu.componentName, SongContextMenu);
