import { useContext } from "../helper/context.js";
import { Logger } from "../helper/logger.js";
import { Utils } from "../modules/utils.js";
import { useMusicService } from "../services/music.js";
import { usePlaylistService } from "../services/playlist.js";
import { ContextMenu, ContextMenuItem, ContextSubMenu } from "./contextMenu.js";
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

        // FIXME: Use Dialog with actions (cancel, confirm)
        if (!confirm(`Remove "${song.title}" by ${song.artist}?\n\nThis will permanently delete the song file.`)) {
            return;
        }

        useMusicService().delete(song.id)
            .then((data) => {
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
            });
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
            H.of(ContextMenuItem, a.hasSubmenu('true'),
                s.svg(a.viewBox('0 0 24 24'), a.fill('currentColor'),
                    s.path(a.d('M14 10H2v2h12v-2zm0-4H2v2h12V6zm4 8v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zM2 16h8v-2H2v2z'))
                ),
                h.span('Add to Playlist'),
                H.of(ContextSubMenu, p.onOpen(() => this._renderPlaylists()),
                    H.of(ContextMenuItem, on.click(() => this.newPlaylist()),
                        s.svg(a.viewBox('0 0 24 24'), a.fill('currentColor'),
                            s.path(a.d('M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z'))
                        ),
                        h.span('New Playlist'),
                    ),
                    h.div(a.class('dropdown-divider')),
                    h.div(this._playlistList)
                )
            ),
            H.of(ContextMenuItem, this._removeFromPlaylist, a.danger(), on.click(() => this.removeCurrentSongFromPlaylist()),
                s.svg(a.viewBox('0 0 24 24'), a.fill('currentColor'),
                    s.path(a.d('M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z'))
                ),
                h.span('Remove from Playlist'),
            ),
            H.of(ContextMenuItem, on.click(() => this.playCurrentSongAsNext()),
                s.svg(a.viewBox('0 0 24 24'), a.fill('currentColor'),
                    s.path(a.d('M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z'))
                ),
                h.span('Play Next'),
            ),
            H.of(ContextMenuItem, on.click(() => this.addCurrentSongToQueue()),
                s.svg(a.viewBox('0 0 24 24'), a.fill('currentColor'),
                    s.path(a.d('M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zm11.5-4.33v6.67L21 15l-6.5-3.33z'))
                ),
                h.span('Add to Queue'),
            ),
            H.of(ContextMenuItem, on.click(() => this.findMetadataForCurrentSong()),
                s.svg(a.viewBox('0 0 24 24'), a.fill('currentColor'),
                    s.path(a.d('M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z'))
                ),
                h.span('Find Metadata'),
            ),
            H.of(ContextMenuItem, a.danger(), on.click(() => this.deleteCurrentSong()),
                s.svg(a.viewBox('0 0 24 24'), a.fill('currentColor'),
                    s.path(a.d('M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z'))
                ),
                h.span('Remove Song'),
            ),
        );
    }
};

customElements.define(SongContextMenu.componentName, SongContextMenu);