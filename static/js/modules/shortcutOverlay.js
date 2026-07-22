/**
 * Keyboard Shortcut Cheat Sheet Overlay (? key).
 * Shows all available shortcuts in a grouped, visually appealing overlay.
 * Toggle with ? — close with Escape, backdrop click, or ? again.
 */
import { Logger } from '../helper/logger.js';

const SHORTCUT_GROUPS = [
    {
        title: 'Playback',
        icon: `<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>`,
        shortcuts: [
            { keys: ['Space'], action: 'Play / Pause' },
            { keys: ['←'], action: 'Seek back 10s' },
            { keys: ['→'], action: 'Seek forward 10s' },
            { keys: ['Shift', '←'], action: 'Previous track' },
            { keys: ['Shift', '→'], action: 'Next track' },
        ],
    },
    {
        title: 'Volume',
        icon: `<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8.5v7a4.47 4.47 0 0 0 2.5-3.5zM14 3.23v2.06a7.007 7.007 0 0 1 0 13.42v2.06A9.005 9.005 0 0 0 14 3.23z"/></svg>`,
        shortcuts: [
            { keys: ['↑'], action: 'Volume up' },
            { keys: ['↓'], action: 'Volume down' },
            { keys: ['M'], action: 'Mute / Unmute' },
        ],
    },
    {
        title: 'Player',
        icon: `<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>`,
        shortcuts: [
            { keys: ['F'], action: 'Fullscreen player' },
            { keys: ['L'], action: 'Like current song' },
            { keys: ['B'], action: 'A-B repeat (loop section)' },
            { keys: ['E'], action: 'Equalizer' },
        ],
    },
    {
        title: 'Speed',
        icon: `<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M20.38 8.57l-1.23 1.85a8 8 0 0 1-.22 7.58H5.07A8 8 0 0 1 15.58 6.85l1.85-1.23A10 10 0 0 0 3.35 19a2 2 0 0 0 1.72 1h13.85a2 2 0 0 0 1.74-1 10 10 0 0 0-.28-10.43z"/><path fill="currentColor" d="M10.59 15.41a2 2 0 0 0 2.83 0l5.66-8.49-8.49 5.66a2 2 0 0 0 0 2.83z"/></svg>`,
        shortcuts: [
            { keys: ['['], action: 'Slower (−0.25x)' },
            { keys: [']'], action: 'Faster (+0.25x)' },
            { keys: ['0'], action: 'Reset speed to 1x' },
        ],
    },
    {
        title: 'Search & Navigation',
        icon: `<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"/></svg>`,
        shortcuts: [
            { keys: ['/'], action: 'Focus search bar' },
            { keys: ['Ctrl', 'K'], action: 'Global search overlay' },
        ],
    },
    {
        title: 'General',
        icon: `<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M11 18h2v-2h-2v2zm1-16C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-14c-2.21 0-4 1.79-4 4h2c0-1.1.9-2 2-2s2 .9 2 2c0 2-3 1.75-3 5h2c0-2.25 3-2.5 3-5 0-2.21-1.79-4-4-4z"/></svg>`,
        shortcuts: [
            { keys: ['?'], action: 'Toggle this shortcut sheet' },
            { keys: ['Esc'], action: 'Close overlays / menus' },
        ],
    },
];

export class ShortcutOverlay {
    constructor() {
        this.isOpen = false;
        this._buildDOM();
        this._bindEvents();
        window.__shortcutOverlay = this;
        Logger.info('Shortcut overlay registered');
    }

    _buildDOM() {
        const overlay = document.createElement('div');
        overlay.id = 'shortcut-overlay';
        overlay.className = 'shortcut-overlay hidden';

        const groupsHtml = SHORTCUT_GROUPS.map(group => `
            <div class="so-group">
                <div class="so-group-title">
                    <span class="so-group-icon">${group.icon}</span>
                    ${group.title}
                </div>
                <div class="so-group-items">
                    ${group.shortcuts.map(s => `
                        <div class="so-item">
                            <span class="so-keys">${s.keys.map(k => `<kbd>${k}</kbd>`).join('<span class="so-plus">+</span>')}</span>
                            <span class="so-action">${s.action}</span>
                        </div>
                    `).join('')}
                </div>
            </div>
        `).join('');

        overlay.innerHTML = `
            <div class="so-backdrop"></div>
            <div class="so-panel">
                <div class="so-header">
                    <div class="so-title">
                        <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M20 5H4c-1.1 0-1.99.9-1.99 2L2 17c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm-9 3h2v2h-2V8zm0 3h2v2h-2v-2zM8 8h2v2H8V8zm0 3h2v2H8v-2zm-1 2H5v-2h2v2zm0-3H5V8h2v2zm9 7H8v-2h8v2zm0-4h-2v-2h2v2zm0-3h-2V8h2v2zm3 3h-2v-2h2v2zm0-3h-2V8h2v2z"/></svg>
                        Keyboard Shortcuts
                    </div>
                    <button class="so-close" title="Close (Esc)">
                        <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                    </button>
                </div>
                <div class="so-body">
                    ${groupsHtml}
                </div>
                <div class="so-footer">
                    Press <kbd>?</kbd> to toggle &middot; <kbd>Esc</kbd> to close
                </div>
            </div>
        `;

        document.body.appendChild(overlay);
        this.overlay = overlay;
    }

    _bindEvents() {
        this.overlay.querySelector('.so-backdrop').addEventListener('click', () => this.close());
        this.overlay.querySelector('.so-close').addEventListener('click', () => this.close());
    }

    toggle() { this.isOpen ? this.close() : this.open(); }

    open() {
        this.isOpen = true;
        this.overlay.classList.remove('hidden');
    }

    close() {
        this.isOpen = false;
        this.overlay.classList.add('hidden');
    }
}
