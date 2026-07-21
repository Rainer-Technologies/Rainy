/**
 * Global keyboard shortcuts for Rainy.
 * Space=play/pause, arrows=seek/track, /=focus search, Ctrl+K=global search,
 * M=mute, F=fullscreen player, L=like current song, B=A-B repeat (section loop),
 * [/]=speed down/up (0.25x steps), 0=reset speed to 1x.
 */
import { Logger } from '../helper/logger.js';

export class KeyboardShortcuts {
    constructor(player, app) {
        this.player = player;
        this.app = app;
        this.enabled = true;
        this._onKeyDown = this._onKeyDown.bind(this);
        document.addEventListener('keydown', this._onKeyDown);
        Logger.info('Keyboard shortcuts registered');
    }

    _isTyping() {
        const el = document.activeElement;
        if (!el) return false;
        const tag = el.tagName.toLowerCase();
        return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
    }

    _onKeyDown(e) {
        if (!this.enabled) return;

        // Ctrl+K / Cmd+K — global search overlay (works even while typing)
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            this._toggleGlobalSearch();
            return;
        }

        // Escape — close overlays
        if (e.key === 'Escape') {
            this._closeOverlays();
            return;
        }

        // Don't hijack keys while typing in a field
        if (this._isTyping()) return;

        const p = this.player;
        switch (e.key) {
            case ' ':
                e.preventDefault();
                p.togglePlayPause();
                break;
            case 'ArrowRight':
                if (e.shiftKey) { p.playNext(); }
                else if (p.audio) { p.audio.currentTime = Math.min(p.audio.duration || 0, p.audio.currentTime + 10); }
                break;
            case 'ArrowLeft':
                if (e.shiftKey) { p.playPrevious(); }
                else if (p.audio) { p.audio.currentTime = Math.max(0, p.audio.currentTime - 10); }
                break;
            case 'ArrowUp':
                e.preventDefault();
                if (p.audio) { p.audio.volume = Math.min(1, p.audio.volume + 0.05); this._syncVolumeUI(); }
                break;
            case 'ArrowDown':
                e.preventDefault();
                if (p.audio) { p.audio.volume = Math.max(0, p.audio.volume - 0.05); this._syncVolumeUI(); }
                break;
            case 'm':
            case 'M':
                if (p.audio) { p.audio.muted = !p.audio.muted; this._syncVolumeUI(); }
                break;
            case 'f':
            case 'F':
                if (p.toggleFullscreen) p.toggleFullscreen();
                break;
            case 'l':
            case 'L':
                if (p.toggleLike) p.toggleLike();
                break;
            case 'b':
            case 'B':
                if (p.handleAbRepeatClick) p.handleAbRepeatClick();
                break;
            case '[':
                if (p.setPlaybackSpeed) {
                    const cur = p.audio.playbackRate || 1;
                    p.setPlaybackSpeed(Math.max(0.25, parseFloat((cur - 0.25).toFixed(2))));
                    window.showToast?.(`Speed: ${p.audio.playbackRate}x`, 'info');
                }
                break;
            case ']':
                if (p.setPlaybackSpeed) {
                    const cur = p.audio.playbackRate || 1;
                    p.setPlaybackSpeed(Math.min(3, parseFloat((cur + 0.25).toFixed(2))));
                    window.showToast?.(`Speed: ${p.audio.playbackRate}x`, 'info');
                }
                break;
            case '0':
                if (p.setPlaybackSpeed) {
                    p.setPlaybackSpeed(1);
                    window.showToast?.('Speed: 1x', 'info');
                }
                break;
            case '/':
                e.preventDefault();
                this._focusHeaderSearch();
                break;
        }
    }

    _syncVolumeUI() {
        const p = this.player;
        const slider = document.getElementById('volume-slider');
        if (slider && p.audio) slider.value = p.audio.muted ? 0 : p.audio.volume * 100;
    }

    _focusHeaderSearch() {
        const search = document.getElementById('search-input') || document.querySelector('.search-bar input');
        if (search) { search.focus(); search.select(); }
    }

    _toggleGlobalSearch() {
        if (window.__globalSearch) {
            window.__globalSearch.toggle();
        } else {
            Logger.warn('Global search not initialized');
        }
    }

    _closeOverlays() {
        if (window.__globalSearch && window.__globalSearch.isOpen) {
            window.__globalSearch.close();
        }
    }

    destroy() {
        document.removeEventListener('keydown', this._onKeyDown);
    }
}
