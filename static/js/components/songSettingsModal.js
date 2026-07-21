import { useContext } from "../helper/context.js";
import { Logger } from "../helper/logger.js";
import { useLightshowService } from "../services/lightshow.js";
import { useLyricsService } from "../services/lyrics.js";
import { generateAndSaveLightshow, isLightshowCancel } from "../lightshowGenerator.js";
import { I } from "./icon.js";
import { a, Component, H, h, on, Ref, useRef } from "./index.js";
import { Modal } from "./modal.js";

/**
 * @typedef {Object} SongModel
 * @property {number} id
 * @property {string} title
 * @property {string} artist
 */

export class SongSettingsModal extends Component {
    static componentName = 'rainy-song-settings-modal';

    created() {
        /** @type {Ref<HTMLDivElement>} */
        this._cover = useRef(null);
        /** @type {Ref<HTMLSpanElement>} */
        this._songName = useRef(null);
        /** @type {Ref<HTMLButtonElement>} */
        this._navLightshow = useRef(null);
        /** @type {Ref<HTMLButtonElement>} */
        this._navLyrics = useRef(null);
        /** @type {Ref<HTMLDivElement>} */
        this._paneLightshow = useRef(null);
        /** @type {Ref<HTMLDivElement>} */
        this._paneLyrics = useRef(null);
        /** @type {Ref<HTMLDivElement>} */
        this._lightshowList = useRef(null);
        /** @type {Ref<HTMLDivElement>} */
        this._lyricsList = useRef(null);

        this.set('current-song', null, { silent: true });
        this.set('active-tab', 'lightshow', { silent: true });

        this.watch('active-tab', (_path, _oldValue, tab) => {
            const isLightshow = tab === 'lightshow';
            this._navLightshow.value.classList.toggle('active', isLightshow);
            this._navLyrics.value.classList.toggle('active', !isLightshow);
            this._paneLightshow.value.classList.toggle('active', isLightshow);
            this._paneLyrics.value.classList.toggle('active', !isLightshow);
        });
    }

    /**
     * @param {SongModel} song
     */
    show(song) {
        this.root.show();
        this.set('current-song', song);
        this._renderCover(song);
        if(this._songName.value) this._songName.value.textContent = `${song.title} \u2014 ${song.artist}`;

        this._renderLightshow();
        this._renderLyrics();
    }

    hide() {
        this.root.hide();
    }

    _lightshowBiasKey(songId) {
        return `lightshow-bias-${songId}`;
    }

    /**
     * @param {SongModel} song
     */
    _renderCover(song) {
        const holder = this._cover.value;
        if(!holder) return;
        Array.from(holder.children).forEach(el => el.remove());

        /** @type {import('../app.js').RainyApp?} */
        const app = useContext().get('app');
        const full = app && app.songs ? app.songs.find(s => s.id == song.id) : null;
        const path = (app && app.coverOverride && app.coverOverride[song.id]) || (full && full.cover_path);

        if(path) {
            const bust = app && app.coverVersion && app.coverVersion[song.id] ? `?t=${app.coverVersion[song.id]}` : '';
            const img = h.img(a.src(`/api/music/cover/${encodeURIComponent(path)}${bust}`), a.alt('cover'));
            img.addEventListener('error', () => {
                img.remove();
                holder.append(I.Note());
            });
            holder.append(img);
        } else {
            holder.append(I.Note());
        }
    }

    /**
     * Downsample the show's energy curve into an interactive bar strip.
     * @param {Array<number>} norm
     */
    _renderWaveform(norm) {
        const target = 72;
        const values = [];
        const step = norm.length / target;
        for(let i = 0; i < target; i++) {
            const start = Math.floor(i * step);
            const end = Math.max(start + 1, Math.floor((i + 1) * step));
            let peak = 0;
            for(let j = start; j < end && j < norm.length; j++) peak = Math.max(peak, norm[j]);
            values.push(peak / 255);
        }

        const strip = h.div(a.class('ss-wave'));
        for(let i = 0; i < values.length; i++) {
            const bar = h.div(a.class('ss-wave-bar'));
            bar.style.height = `${Math.max(5, Math.round(values[i] * 100))}%`;
            bar.style.animationDelay = `${i * 8}ms`;
            strip.append(bar);
        }

        const bars = Array.from(strip.children);
        strip.addEventListener('mousemove', (ev) => {
            const rect = strip.getBoundingClientRect();
            const idx = Math.floor(((ev.clientX - rect.left) / rect.width) * bars.length);
            for(let i = 0; i < bars.length; i++) {
                const d = Math.abs(i - idx);
                const hot = d <= 5 ? 1 - d / 6 : 0;
                bars[i].classList.toggle('hot', hot > 0);
                bars[i].style.setProperty('--hot', String(hot));
            }
        });
        strip.addEventListener('mouseleave', () => {
            for(const bar of bars) {
                bar.classList.remove('hot');
                bar.style.setProperty('--hot', '0');
            }
        });

        return strip;
    }

    /**
     * @param {{ t0: number, y: string }} show
     */
    _renderSectionChips(sections) {
        const counts = {};
        for(const sec of sections) {
            const label = sec.y || 'section';
            counts[label] = (counts[label] || 0) + 1;
        }

        const chips = h.div(a.class('ss-chips'));
        Object.entries(counts)
            .sort((x, y) => y[1] - x[1])
            .slice(0, 4)
            .forEach(([label, count]) => {
                const name = label.charAt(0).toUpperCase() + label.slice(1);
                chips.append(h.span(a.class('ss-chip'), `${count} ${name}`));
            });
        return chips;
    }

    async _renderLightshow() {
        const container = this._lightshowList.value;
        if(!container) return;
        Array.from(container.children).forEach(el => el.remove());

        /** @type {SongModel?} */
        const song = this.get('current-song');
        if(!song) return;

        let show = null;
        const data = await useLightshowService().get(song.id);
        if(!data.error && data.value && data.value.lightshow) show = data.value.lightshow;

        const bias = (show && show.settings && show.settings.bias)
            || localStorage.getItem(this._lightshowBiasKey(song.id))
            || 'balanced';

        if(show) {
            if(Array.isArray(show.norm) && show.norm.length) {
                container.append(this._renderWaveform(show.norm));
            }

            container.append(h.div(a.class('ss-stats'),
                h.div(a.class('ss-stat'),
                    h.div(a.class('ss-stat-value'), String(Math.round(show.bpm))),
                    h.div(a.class('ss-stat-label'), 'BPM'),
                ),
                h.div(a.class('ss-stat'),
                    h.div(a.class('ss-stat-value'), String(show.sections.length)),
                    h.div(a.class('ss-stat-label'), 'Sections'),
                ),
                this._renderSectionChips(show.sections),
            ));
        } else {
            container.append(h.div(a.class('ss-empty'),
                I.Bolt(),
                h.div(a.class('ss-empty-title'), 'No light show yet'),
                h.div(a.class('ss-empty-detail'), 'Generate one and the rig will follow this song\u2019s rhythm, energy and structure while it plays.'),
            ));
        }

        container.append(h.button(a.class('btn', 'btn-primary', 'ss-cta'), on.click(() => this.generateLightshow()),
            I.Bolt(),
            h.span(show ? 'Regenerate Light Show' : 'Generate Light Show'),
        ));

        container.append(h.div(a.class('ss-label-row'),
            h.span(a.class('ss-label'), 'Energy bias'),
            h.span(a.class('ss-hint'), 'shapes the next generation'),
        ));

        const segmented = h.div(a.class('ss-seg'));
        for(const opt of ['chill', 'balanced', 'hype']) {
            const label = opt.charAt(0).toUpperCase() + opt.slice(1);
            const btn = h.button(a.class(bias === opt ? 'active' : ''), on.click(() => {
                localStorage.setItem(this._lightshowBiasKey(song.id), opt);
                Array.from(segmented.children).forEach(el => el.classList.remove('active'));
                btn.classList.add('active');
            }), label);
            segmented.append(btn);
        }
        container.append(segmented);

        if(show) {
            container.append(this._renderRow({
                icon: I.Bin(),
                title: 'Remove Light Show',
                subtitle: 'Falls back to the live engine while playing',
                onClick: () => this.removeLightshow(),
                variant: 'danger',
            }));
        }
    }

    async _renderLyrics() {
        const container = this._lyricsList.value;
        if(!container) return;
        Array.from(container.children).forEach(el => el.remove());

        /** @type {SongModel?} */
        const song = this.get('current-song');
        if(!song) return;

        let lines = [];
        let synced = false;
        let state = 'none';
        const data = await useLyricsService().get(song.id);
        if(!data.error && data.value && data.value.lyrics) {
            const lyrics = data.value.lyrics;
            if(Array.isArray(lyrics.synced) && lyrics.synced.length) {
                lines = lyrics.synced.map(l => l.text).filter(t => t && t.trim());
                synced = true;
                state = 'found';
            } else if(lyrics.plain) {
                lines = lyrics.plain.split('\n').map(s => s.trim()).filter(Boolean);
                state = 'found';
            }
        } else if(data.error && data.error.state === 'not_fetched') {
            state = 'not_fetched';
        }

        if(state === 'found' && lines.length) {
            const preview = h.div(a.class('ss-lyrics'));
            preview.append(h.div(a.class('ss-lyrics-meta'),
                synced ? h.span(a.class('ss-synced-chip'), 'Synced') : h.span(a.class('ss-plain-chip'), 'Plain text'),
                h.span(a.class('ss-lyrics-count'), `${lines.length} lines`),
            ));
            for(const line of lines.slice(0, 5)) {
                preview.append(h.div(a.class('ss-lyrics-line'), line));
            }
            if(lines.length > 5) {
                preview.append(h.div(a.class('ss-lyrics-fade')));
                preview.append(h.div(a.class('ss-lyrics-more'), `+ ${lines.length - 5} more lines`));
            }
            container.append(preview);
        } else {
            container.append(h.div(a.class('ss-empty'),
                I.Lyrics(),
                h.div(a.class('ss-empty-title'),
                    state === 'not_fetched' ? 'Lyrics haven\u2019t been fetched' : 'No lyrics for this song'),
                h.div(a.class('ss-empty-detail'),
                    state === 'not_fetched'
                        ? 'Run an automatic fetch, or search LRCLIB yourself and hand-pick the right version.'
                        : 'The automatic search came up empty \u2014 try a manual search, the lyrics might still be there.'),
            ));
        }

        container.append(h.button(a.class('btn', 'btn-primary', 'ss-cta'), on.click(() => this.findLyrics()),
            I.Magnifier(),
            h.span('Find Lyrics\u2026'),
        ));

        const rowIcon = h.div(a.class('ss-row-icon'), I.Refresh());
        const rowTitle = h.div(a.class('ss-row-title'), 'Auto-fetch Lyrics');
        const row = h.div(a.class('ss-row'), on.click(() => this.autoFetchLyrics(row, rowIcon, rowTitle)),
            rowIcon,
            h.div(a.class('ss-row-text'),
                rowTitle,
                h.div(a.class('ss-row-sub'), 'Let Rainy pick the best LRCLIB match automatically'),
            ),
        );
        container.append(row);

        if(state === 'found') {
            container.append(this._renderRow({
                icon: I.Bin(),
                title: 'Remove Lyrics',
                subtitle: 'Clears cached lyrics so they can be re-fetched',
                onClick: () => this.removeLyrics(),
                variant: 'danger',
            }));
        }
    }

    /**
     * @param {{ icon: SVGElement, title: string, subtitle: string, onClick: () => void, variant?: string }} opts
     */
    _renderRow({ icon, title, subtitle, onClick, variant }) {
        return h.div(a.class('ss-row', variant ?? ''), on.click(onClick),
            h.div(a.class('ss-row-icon'), icon),
            h.div(a.class('ss-row-text'),
                h.div(a.class('ss-row-title'), title),
                h.div(a.class('ss-row-sub'), subtitle),
            ),
        );
    }

    /**
     * @param {HTMLElement} row
     * @param {HTMLElement} rowIcon
     * @param {HTMLElement} rowTitle
     */
    async autoFetchLyrics(row, rowIcon, rowTitle) {
        if(row.classList.contains('busy')) return;

        /** @type {SongModel?} */
        const song = this.get('current-song');
        if(!song) return;

        /** @type {import('../app.js').RainyApp} */
        const app = useContext().get('app');

        row.classList.add('busy');
        Array.from(rowIcon.children).forEach(el => el.remove());
        rowIcon.append(I.Spinner());
        rowTitle.textContent = 'Fetching from LRCLIB\u2026';

        const data = await useLyricsService().fetch(song.id);
        if(data.error) {
            Logger.error(data.error);
            app.showToast('No lyrics found for this song', 'error');
        } else {
            app.showToast('Lyrics fetched', 'success');
            if(window.player && window.player.currentSong && window.player.currentSong.id === song.id) {
                window.player.loadLyrics(song.id);
            }
        }

        this._renderLyrics();
    }

    async generateLightshow() {
        this.hide();

        /** @type {SongModel?} */
        const song = this.get('current-song');
        if(!song) return;

        /** @type {import('../app.js').RainyApp} */
        const app = useContext().get('app');
        const bias = localStorage.getItem(this._lightshowBiasKey(song.id)) || 'balanced';

        let cancelled = false;
        /** @type {Modal} */
        const dialog = H.of(Modal,
            I.Bolt('currentColor', a.slot('header-icon')),
            h.h2(a.slot('header-title'), 'Generating Light Show'),
            h.div(a.slot('body'),
                h.p(a.class('lightshow-progress-text'), `Preparing "${song.title}"\u2026`),
                h.div(a.class('progress-bar-modern'),
                    h.div(a.class('progress-fill-modern')),
                ),
            ),
            h.button(a.slot('action'), a.class('btn btn-secondary'), on.click(() => {
                cancelled = true;
                dialog.remove();
            }), 'Cancel'),
        ); document.body.append(dialog); dialog.show();

        const fill = dialog.querySelector('.progress-fill-modern');
        const text = dialog.querySelector('.lightshow-progress-text');
        const phaseLabels = {
            download: 'Downloading song\u2026',
            decode: 'Decoding audio\u2026',
            analyze: 'Analysing rhythm & energy\u2026',
            save: 'Saving light show\u2026',
            done: 'Done!',
        };

        try {
            const show = await generateAndSaveLightshow(song.id, { bias }, (progress) => {
                if(text) text.textContent = phaseLabels[progress.phase] || progress.phase;
                if(fill) fill.style.width = `${Math.round(progress.fraction * 100)}%`;
            }, () => cancelled);

            dialog.remove();
            app.showToast(`Light show ready \u2014 ${Math.round(show.bpm)} BPM, ${show.sections.length} sections`, 'success');

            if(window.player && window.player.lightShow && window.player.currentSong?.id === song.id) {
                window.player.lightShow.loadScript(song.id, true);
            }
        } catch(e) {
            dialog.remove();
            if(isLightshowCancel(e)) return;
            Logger.error('Light show generation failed:', e);
            app.showToast('Failed to generate light show', 'error');
        }
    }

    async removeLightshow() {
        this.hide();

        /** @type {SongModel?} */
        const song = this.get('current-song');
        if(!song) return;

        /** @type {import('../app.js').RainyApp} */
        const app = useContext().get('app');

        const data = await useLightshowService().remove(song.id);
        if(data.error) {
            Logger.error(data.error);
            app.showToast('Failed to remove light show', 'error');
            return;
        }

        app.showToast('Light show removed', 'success');

        if(window.player && window.player.lightShow && window.player.currentSong?.id === song.id) {
            window.player.lightShow.clearScript(song.id);
        }
    }

    findLyrics() {
        this.hide();

        /** @type {SongModel?} */
        const song = this.get('current-song');
        if(!song) return;

        /** @type {import('./lyricsModal.js').LyricsModal} */
        const modal = document.querySelector('rainy-lyrics-modal');
        if(!modal) return;

        modal.show(song);
    }

    async removeLyrics() {
        /** @type {SongModel?} */
        const song = this.get('current-song');
        if(!song) return;

        /** @type {import('../app.js').RainyApp} */
        const app = useContext().get('app');

        const data = await useLyricsService().remove(song.id);
        if(data.error) {
            Logger.error(data.error);
            app.showToast('Failed to remove lyrics', 'error');
            return;
        }

        app.showToast('Lyrics removed', 'success');

        if(window.player && window.player.currentSong && window.player.currentSong.id === song.id) {
            window.player.loadLyrics(song.id);
        }

        this._renderLyrics();
    }

    render() {
        return H.of(Modal,
            h.div(this._cover, a.slot('header-icon'), a.class('ss-cover')),
            h.h2(a.slot('header-title'), 'Song Settings'),
            h.p(a.slot('header-subtitle'), h.span(this._songName)),
            h.div(a.slot('body'), a.class('ss-body'),
                h.div(a.class('ss-rail'),
                    h.button(this._navLightshow, a.class('ss-nav', 'active'), on.click(() => this.set('active-tab', 'lightshow')),
                        I.Bolt(),
                        h.span('Light Show'),
                    ),
                    h.button(this._navLyrics, a.class('ss-nav'), on.click(() => this.set('active-tab', 'lyrics')),
                        I.Lyrics(),
                        h.span('Lyrics'),
                    ),
                ),
                h.div(this._paneLightshow, a.class('ss-pane', 'active'),
                    h.div(this._lightshowList, a.class('ss-pane-inner')),
                ),
                h.div(this._paneLyrics, a.class('ss-pane'),
                    h.div(this._lyricsList, a.class('ss-pane-inner')),
                ),
            ),
        );
    }
};

customElements.define(SongSettingsModal.componentName, SongSettingsModal);
