/**
 * Media Session API integration — lock screen / media key controls.
 * Wires the OS-level media controls to the AudioPlayer instance.
 */
import { Logger } from '../helper/logger.js';

export class MediaSessionController {
    constructor(player) {
        this.player = player;
        this.supported = 'mediaSession' in navigator;
        if (!this.supported) {
            Logger.warn('Media Session API not supported');
            return;
        }
        this.bindHandlers();
    }

    bindHandlers() {
        const ms = navigator.mediaSession;
        const p = this.player;

        ms.setActionHandler('play', () => { if (!p.isPlaying) p.togglePlayPause(); });
        ms.setActionHandler('pause', () => { if (p.isPlaying) p.togglePlayPause(); });
        ms.setActionHandler('previoustrack', () => p.playPrevious());
        ms.setActionHandler('nexttrack', () => p.playNext());
        ms.setActionHandler('seekto', (details) => {
            if (details.seekTime != null && p.audio) {
                p.audio.currentTime = details.seekTime;
            }
        });
        ms.setActionHandler('seekbackward', (details) => {
            if (p.audio) p.audio.currentTime = Math.max(0, p.audio.currentTime - (details.seekOffset || 10));
        });
        ms.setActionHandler('seekforward', (details) => {
            if (p.audio) p.audio.currentTime = Math.min(p.audio.duration || 0, p.audio.currentTime + (details.seekOffset || 10));
        });
        ms.setActionHandler('stop', () => { if (p.isPlaying) p.togglePlayPause(); });
    }

    /** Update the lock-screen metadata + artwork for the current song. */
    updateMetadata(song) {
        if (!this.supported || !song) return;
        try {
            const artwork = [];
            if (song.cover_path) {
                const url = `/api/music/cover/${encodeURIComponent(song.cover_path)}`;
                artwork.push(
                    { src: url, sizes: '96x96', type: 'image/jpeg' },
                    { src: url, sizes: '256x256', type: 'image/jpeg' },
                    { src: url, sizes: '512x512', type: 'image/jpeg' }
                );
            }
            navigator.mediaSession.metadata = new MediaMetadata({
                title: song.title || 'Unknown Title',
                artist: song.artist || 'Unknown Artist',
                album: song.album || '',
                artwork
            });
        } catch (e) {
            Logger.warn('Failed to set media metadata:', e);
        }
    }

    /** Update playback state + position for the OS controls. */
    updatePlaybackState() {
        if (!this.supported) return;
        try {
            navigator.mediaSession.playbackState = this.player.isPlaying ? 'playing' : 'paused';
            if (this.player.audio && this.player.audio.duration) {
                navigator.mediaSession.setPositionState({
                    duration: this.player.audio.duration || 0,
                    playbackRate: this.player.audio.playbackRate || 1,
                    position: this.player.audio.currentTime || 0
                });
            }
        } catch (e) {
            // setPositionState can throw if values are invalid; ignore
        }
    }
}
