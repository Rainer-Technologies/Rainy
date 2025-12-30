import { Modal } from "../components/modal.js";
import { useContext } from "../helper/context.js";
import { Logger } from "../helper/logger.js";
import { Utils } from "../modules/utils.js";
import { useMusicService } from "../services/music.js";
import { usePlaylistService } from "../services/playlist.js";
import { ContextMenu, ContextMenuItem, ContextSubMenu } from "./contextMenu.js";
import { I } from "./icon.js";
import { a, Component, h, H, on, p, Ref, s, useRef } from "./index.js";

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

        this.set('current-song', null, { silent: true });
        this.set('current-view-watcher', useContext().listen('current-view-type', (_path, _oldValue, newValue) => {
            if(!this._removeFromPlaylist.value) return;
            const item = this._removeFromPlaylist.value;

            if(newValue === 'playlist') item.style.display = 'block';
            else item.style.display = 'none';
        }));
    }

    destroyed() {
        this.get('current-view-watcher')();
    }

    /**
     * @param {SongModel} song 
     */
    setCurrentSong(song) {
        this.set('current-song', song);
    }

    deleteCurrentSong() {
        this.hide();

        /** @type {SongModel?} */
        const song = this.get('current-song');
        if(!song) return;

        /** @type {Modal} */
        const dialog = H.of(Modal,
            I.Bin('currentColor', a.slot('header-icon')),
            h.h2(a.slot('header-title'), `Delete song`),
            h.p(a.slot('body'), 'Are you sure you want to delete this song? This action cannot be undone.'),
            h.button(a.slot('action'), a.class('btn btn-secondary'), on.click(() => {
                dialog.remove();
            }), 'Cancel'),
            h.button(a.slot('action'), a.class('btn btn-danger'), on.click(async () => {
                dialog.remove();

                const data = await useMusicService().delete(song.id)
                if(data.error) return Logger.error(data.error);

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
            }), 'Delete'),
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

        const data = await usePlaylistService().addSong(playlist.id, currentSong.id);
        if (data.error) {
            Logger.error(data.error);
            app.showToast('Failed to add song to playlist', 'error');

            return;
        }

        app.showToast(`Added to "${playlist.name}"`, 'success');
        app.refreshPlayerQueueIfNeeded(playlist.id);
    }

    async removeCurrentSongFromPlaylist() {
        this.hide();

        /** @type {SongModel?} */
        const currentSong = this.get('current-song');
        if(!currentSong) return;

        /** @type {import('../app.js').RainyApp} */
        const app = useContext().get('app');
        
        const data = await usePlaylistService().removeSong(app.currentPlaylistId, currentSong.id);
        if (data.error) {
            Logger.error(data.error);
            app.showToast('Failed to remove song from playlist', 'error');
            return;
        }

        const playlist = app.playlists.find(p => p.id === app.currentPlaylistId);
        const playlistName = playlist ? playlist.name : 'playlist';

        app.showToast(`Removed from "${playlistName}"`, 'success');
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
        
        const playlists = (data.value || []).filter(p => (p.name || '').toLowerCase() !== 'liked music');
        if(!playlists) return Logger.error('unreachable');

        for(const playlist of playlists) {
            item.append(H.of(ContextMenuItem, on.click(() => this.addCurrentSongToPlaylist(playlist)),
                s.svg(a.viewBox('0 0 24 24'), a.fill('currentColor'),
                    s.path(a.d('M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z'))
                ),
                h.span(Utils.escapeHtml(playlist.name))
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
            app.showToast(`Now playing: "${song.title}"`, 'success');

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
        app.showToast(`"${song.title}" added to queue (${(position - player.currentIndex)} songs away)`, 'success');
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
        this.root.show(pos);
    }

    hide() {
        this.root.hide();
    }

    render() {
        return H.of(ContextMenu,
            H.of(ContextMenuItem, a.hasSubmenu(),
                I.ListWithPlus(),
                h.span('Add to Playlist'),
                H.of(ContextSubMenu, p.onOpen(() => this._renderPlaylists()),
                    H.of(ContextMenuItem, on.click(() => this.newPlaylist()),
                        I.Plus(),
                        h.span('New Playlist'),
                    ),
                    h.div(a.class('dropdown-divider')),
                    h.div(this._playlistList, a.style('overflow-y: auto;', 'max-height: 200px;'))
                )
            ),
            H.of(ContextMenuItem, this._removeFromPlaylist, a.danger(), on.click(() => this.removeCurrentSongFromPlaylist()),
                I.Bin(),
                h.span('Remove from Playlist'),
            ),
            H.of(ContextMenuItem, on.click(() => this.playCurrentSongAsNext()),
                I.Next(),
                h.span('Play Next'),
            ),
            H.of(ContextMenuItem, on.click(() => this.addCurrentSongToQueue()),
                I.ListWithPlay(),
                h.span('Add to Queue'),
            ),
            H.of(ContextMenuItem, on.click(() => this.findMetadataForCurrentSong()),
                I.Magnifier(),
                h.span('Find Metadata'),
            ),
            H.of(ContextMenuItem, a.danger(), on.click(() => this.deleteCurrentSong()),
                I.Bin(),
                h.span('Remove Song'),
            ),
        );
    }
};

customElements.define(SongContextMenu.componentName, SongContextMenu);