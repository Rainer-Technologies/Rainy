/**
 * Smart Mix page.
 *
 * Personalised mixes from /api/smartmix/mixes: a Supermix feature, mood
 * pills, and horizontally scrolling shelves of cover-first cards. Each mix
 * takes a single flat tint from its own artwork (no invented palette).
 * Playing a mix queues it as an endless session: the player asks
 * /api/smartmix/more for songs that follow on from what is playing.
 */
import { Logger } from '../helper/logger.js';
import { Utils } from './utils.js';

const SHELVES = [
    { id: 'made', title: 'Made for you' },
    { id: 'fresh', title: 'From your listening' },
    { id: 'artists', title: 'Artists' },
];

const ICON = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>',
    prev: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>',
    next: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>',
};

const esc = (s) => Utils.escapeHtml(String(s ?? ''));
const coverUrl = (p) => `/api/music/cover/${encodeURIComponent(p)}`;

function fmtTotal(seconds) {
    const m = Math.round((seconds || 0) / 60);
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} hr ${m % 60} min`;
}

// --- artwork tint ---------------------------------------------------------

const tintCache = new Map();

/** Average colour of an image, weighted towards its more saturated pixels. */
function artworkTint(src) {
    if (!tintCache.has(src)) {
        tintCache.set(src, new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                try {
                    const size = 24;
                    const canvas = document.createElement('canvas');
                    canvas.width = canvas.height = size;
                    const ctx = canvas.getContext('2d', { willReadFrequently: true });
                    ctx.drawImage(img, 0, 0, size, size);
                    const { data } = ctx.getImageData(0, 0, size, size);
                    let r = 0, g = 0, b = 0, total = 0;
                    for (let i = 0; i < data.length; i += 4) {
                        const max = Math.max(data[i], data[i + 1], data[i + 2]);
                        const min = Math.min(data[i], data[i + 1], data[i + 2]);
                        const w = 0.1 + (max - min) / 255;
                        r += data[i] * w; g += data[i + 1] * w; b += data[i + 2] * w;
                        total += w;
                    }
                    resolve(total ? `rgb(${Math.round(r / total)} ${Math.round(g / total)} ${Math.round(b / total)})` : null);
                } catch {
                    resolve(null);
                }
            };
            img.onerror = () => resolve(null);
            img.src = src;
        }));
    }
    return tintCache.get(src);
}

function applyTint(el, mix) {
    const first = mix.covers?.[0];
    if (!el || !first) return;
    artworkTint(coverUrl(first)).then((c) => { if (c) el.style.setProperty('--tint', c); });
}

// --------------------------------------------------------------------------

export class MixesView {
    constructor(app, player) {
        this.app = app;
        this.player = player;
        this.mixes = [];
        this.byId = new Map();
        this.loading = null;
        this.loadedAt = 0;
        this.home = document.getElementById('mixes-home');
        this.detail = document.getElementById('mix-detail');
        this.status = document.getElementById('mixes-status');
        // Keep the "playing" row in an open mix current.
        this.player.audio?.addEventListener('play', () => this._markPlaying());
        this.player.audio?.addEventListener('loadstart', () => this._markPlaying());
    }

    // ---------------------------------------------------------------- data

    async show() {
        this._showHome();
        const stale = Date.now() - this.loadedAt > 5 * 60 * 1000;
        if (!this.mixes.length || stale) await this.load();
        else this.renderHome();
    }

    async load({ refresh = false } = {}) {
        if (this.loading) return this.loading;
        this._setStatus('loading');
        this.loading = (async () => {
            try {
                const res = await fetch(`/api/smartmix/mixes${refresh ? '?refresh=1' : ''}`);
                const data = await res.json();
                if (!res.ok || data.error) throw new Error(data.error || 'Could not build mixes');
                this.mixes = data.mixes || [];
                this.byId = new Map(this.mixes.map(m => [m.id, m]));
                this.loadedAt = Date.now();
                this._showHome();
                this.renderHome();
            } catch (e) {
                Logger.error('Mixes load error:', e);
                this._setStatus('error', e.message);
            } finally {
                this.loading = null;
            }
        })();
        return this.loading;
    }

    // -------------------------------------------------------------- render

    _setStatus(kind, msg) {
        if (!this.status) return;
        if (kind === 'loading') {
            this.home.innerHTML = '';
            this.status.classList.remove('hidden');
            this.status.innerHTML = `<div class="loading-container">
                <div class="loading-spinner"></div>
                <p class="loading-text">Building your mixes…</p></div>`;
        } else if (kind === 'error') {
            this.status.classList.remove('hidden');
            this.status.innerHTML = `<div class="empty-state">
                <h3>Couldn’t build your mixes</h3><p>${esc(msg || 'Something went wrong.')}</p>
                <button class="mix-btn" id="mixes-retry" type="button">Try again</button></div>`;
            this.status.querySelector('#mixes-retry')
                ?.addEventListener('click', () => this.load({ refresh: true }));
        } else {
            this.status.classList.add('hidden');
            this.status.innerHTML = '';
        }
    }

    /** A mix's artwork: 2x2 of its tracks' covers, a single cover, or the app's note fallback. */
    _cover(mix) {
        const covers = mix.covers || [];
        if (covers.length >= 4) {
            return `<div class="mix-mosaic">${covers.slice(0, 4).map(c =>
                `<img src="${coverUrl(c)}" alt="" loading="lazy">`).join('')}</div>`;
        }
        if (covers.length) return `<img src="${coverUrl(covers[0])}" alt="" loading="lazy">`;
        return '<div class="mix-nocover">♪</div>';
    }

    _meta(mix) {
        const count = `${mix.count} ${mix.count === 1 ? 'song' : 'songs'}`;
        return `${count} · ${fmtTotal(mix.duration)}`;
    }

    _hero(mix) {
        return `
            <section class="mix-hero">
                <div class="mix-cover mix-hero-cover">${this._cover(mix)}</div>
                <div class="mix-hero-body">
                    <h2 class="mix-hero-title">${esc(mix.title)}</h2>
                    <p class="mix-hero-sub">${esc(mix.subtitle)}</p>
                    <p class="mix-hero-meta">${this._meta(mix)}</p>
                    <div class="mix-actions">
                        <button class="album-play-btn mix-play" type="button" data-play="${esc(mix.id)}">${ICON.play}Play</button>
                        <button class="mix-btn" type="button" data-mix="${esc(mix.id)}">See tracks</button>
                    </div>
                </div>
            </section>`;
    }

    _card(mix) {
        return `
            <div class="mix-card" role="button" tabindex="0" data-mix="${esc(mix.id)}">
                <div class="mix-cover">
                    ${this._cover(mix)}
                    <button class="mix-quickplay" type="button" data-play="${esc(mix.id)}"
                        aria-label="Play ${esc(mix.title)}">${ICON.play}</button>
                </div>
                <div class="mix-card-title">${esc(mix.title)}</div>
                <div class="mix-card-sub">${esc(mix.subtitle)}</div>
            </div>`;
    }

    renderHome() {
        if (!this.home) return;
        this._setStatus('done');
        if (!this.mixes.length) {
            this.home.innerHTML = `<div class="empty-state">
                <h3>No mixes yet</h3>
                <p>Add some music and play a few songs. Mixes are built from what you listen to.</p></div>`;
            return;
        }

        const hero = this.mixes.find(m => m.kind === 'supermix');
        const moods = this.mixes.filter(m => m.shelf === 'moods');

        const bar = `
            <div class="mix-bar">
                <div class="recent-tabs mix-moods">
                    ${moods.map(m => `<button class="recent-tab" type="button" data-mix="${esc(m.id)}">${esc(m.title)}</button>`).join('')}
                </div>
                <div class="mix-tools">
                    <button class="mix-btn" id="mixes-refresh" type="button"
                        title="Pick a new set of songs for each mix">${ICON.refresh}Refresh</button>
                </div>
            </div>`;

        const shelves = SHELVES.map(shelf => {
            const items = this.mixes.filter(m => m.shelf === shelf.id && m !== hero);
            if (!items.length) return '';
            return `
                <section class="mix-shelf">
                    <div class="mix-shelf-head">
                        <h3 class="section-heading">${esc(shelf.title)}</h3>
                        <div class="mix-nav">
                            <button class="icon-btn-small" type="button" data-scroll="-1" aria-label="Scroll left">${ICON.prev}</button>
                            <button class="icon-btn-small" type="button" data-scroll="1" aria-label="Scroll right">${ICON.next}</button>
                        </div>
                    </div>
                    <div class="mix-row">${items.map(m => this._card(m)).join('')}</div>
                </section>`;
        }).join('');

        this.home.innerHTML = bar + (hero ? this._hero(hero) : '') + shelves;

        if (hero) applyTint(this.home.querySelector('.mix-hero'), hero);

        this.home.querySelector('#mixes-refresh')?.addEventListener('click', (e) => {
            e.currentTarget.disabled = true;
            this.load({ refresh: true });
        });
        this.home.querySelectorAll('[data-play]').forEach(btn => btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.play(this.byId.get(btn.dataset.play));
        }));
        this.home.querySelectorAll('[data-mix]').forEach(el => {
            const open = () => this.openMix(el.dataset.mix);
            el.addEventListener('click', open);
            if (el.classList.contains('mix-card')) {
                el.addEventListener('keydown', (e) => {
                    if (e.target === el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(); }
                });
            }
        });
        this.home.querySelectorAll('.mix-shelf').forEach(shelf => this._wireShelf(shelf));
    }

    /** Chevron buttons scroll the row one screenful; disabled at either end. */
    _wireShelf(shelf) {
        const row = shelf.querySelector('.mix-row');
        const [prev, next] = shelf.querySelectorAll('[data-scroll]');
        const nav = shelf.querySelector('.mix-nav');
        const sync = () => {
            nav.hidden = row.scrollWidth <= row.clientWidth + 2;   // nothing to scroll
            prev.disabled = row.scrollLeft <= 2;
            next.disabled = row.scrollLeft + row.clientWidth >= row.scrollWidth - 2;
        };
        shelf.querySelectorAll('[data-scroll]').forEach(btn => btn.addEventListener('click', () =>
            row.scrollBy({ left: Number(btn.dataset.scroll) * row.clientWidth * 0.85, behavior: 'smooth' })));
        row.addEventListener('scroll', sync, { passive: true });
        new ResizeObserver(sync).observe(row);
        sync();
    }

    // -------------------------------------------------------------- detail

    _showHome() {
        this.detail?.classList.add('hidden');
        this.home?.classList.remove('hidden');
    }

    openMix(id) {
        const mix = this.byId.get(id);
        if (!mix || !this.detail) return;
        this.home?.classList.add('hidden');
        this.detail.classList.remove('hidden');

        const rows = mix.songs.map((s, i) => `
            <div class="recent-song-row mix-track" data-song="${s.id}" data-index="${i}">
                <div class="recent-song-num">${i + 1}</div>
                <div class="recent-song-cover">${s.cover_path
                    ? `<img src="${coverUrl(s.cover_path)}" alt="" loading="lazy">`
                    : '<div class="recent-no-cover">♪</div>'}</div>
                <div class="recent-song-info">
                    <div class="recent-song-title">${esc(s.title)}</div>
                    <div class="recent-song-artist">${esc(s.artist)}</div>
                </div>
                <div class="recent-song-duration">${Utils.formatDuration(s.duration)}</div>
            </div>`).join('');

        this.detail.innerHTML = `
            <button class="album-back-btn" id="mix-back" type="button">&larr; Back to Smart Mix</button>
            <div class="mix-detail-head">
                <div class="mix-cover mix-detail-cover">${this._cover(mix)}</div>
                <div class="mix-detail-info">
                    <h1 class="mix-detail-title">${esc(mix.title)}</h1>
                    <p class="mix-hero-sub">${esc(mix.subtitle)}</p>
                    <p class="mix-hero-meta">${mix.tag ? `${esc(mix.tag)} · ` : ''}${this._meta(mix)}</p>
                    <div class="mix-actions">
                        <button class="album-play-btn mix-play" id="mix-play" type="button">${ICON.play}Play</button>
                        <button class="mix-btn" id="mix-shuffle" type="button">Shuffle</button>
                        <button class="mix-btn" id="mix-save" type="button">Save as playlist</button>
                    </div>
                </div>
            </div>
            <div class="mix-tracks">${rows}</div>`;

        applyTint(this.detail.querySelector('.mix-detail-head'), mix);
        this.detail.querySelector('#mix-back').addEventListener('click', () => this._showHome());
        this.detail.querySelector('#mix-play').addEventListener('click', () => this.play(mix));
        this.detail.querySelector('#mix-shuffle').addEventListener('click', () => this.play(mix, { shuffle: true }));
        this.detail.querySelector('#mix-save').addEventListener('click', (e) => this.save(mix, e.currentTarget));
        this.detail.querySelectorAll('.mix-track').forEach(row => row.addEventListener('click', () =>
            this.play(mix, { index: parseInt(row.dataset.index, 10) })));
        this._markPlaying();
    }

    _markPlaying() {
        const id = this.player.currentSong?.id;
        this.detail?.querySelectorAll('.mix-track').forEach(row => {
            row.classList.toggle('playing', id != null && Number(row.dataset.song) === id);
        });
    }

    // ------------------------------------------------------------ playback

    play(mix, { index = 0, shuffle = false } = {}) {
        if (!mix?.songs?.length) return;
        const songs = [...mix.songs];   // the player appends to its queue; never hand it our copy
        if (shuffle) {
            for (let i = songs.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [songs[i], songs[j]] = [songs[j], songs[i]];
            }
            index = 0;
        }
        this.player.playSong(index, songs, { type: 'smartmix', id: mix.id, endless: true });
    }

    async save(mix, btn) {
        if (btn.disabled) return;
        btn.disabled = true;
        const generic = mix.kind === 'supermix' || mix.kind === 'my' || mix.kind === 'mood';
        try {
            const res = await fetch('/api/smartmix/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: generic ? `${mix.title} ${new Date().toLocaleDateString()}` : mix.title,
                    song_ids: mix.songs.map(s => s.id),
                }),
            });
            const data = await res.json();
            if (!res.ok || data.error) throw new Error(data.error || 'Could not save');
            window.showToast?.(`Saved “${data.name}” (${data.count} songs)`, 'success');
            this.app.loadPlaylists?.();
        } catch (e) {
            Logger.error('Save mix error:', e);
            window.showToast?.(e.message, 'error');
        } finally {
            btn.disabled = false;
        }
    }
}
