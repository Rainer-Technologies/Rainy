import { useContext } from "../helper/context.js";
import { Logger } from "../helper/logger.js";
import { Utils } from "../modules/utils.js";
import { useLyricsService } from "../services/lyrics.js";
import { I } from "./icon.js";
import { a, Component, H, h, on, Ref, useRef } from "./index.js";
import { Modal } from "./modal.js";

export class LyricsModal extends Component {
    static componentName = 'rainy-lyrics-modal';

    created() {
        /** @type {Ref<HTMLInputElement>} */
        this._queryInput = useRef(null);
        /** @type {Ref<HTMLDivElement>} */
        this._noResults = useRef(null);
        /** @type {Ref<HTMLDivElement>} */
        this._loading = useRef(null);
        /** @type {Ref<HTMLDivElement>} */
        this._results = useRef(null);
        /** @type {Ref<HTMLSpanElement>} */
        this._songName = useRef(null);

        this.set('loading', false, { silent: true });
        this.set('results', [], { silent: true });
        this.set('current-song', null, { silent: true });
        this.set('applying', false, { silent: true });

        this.watch('loading', (_path, _oldValue, newValue) => {
            const loading = this._loading.value;
            const results = this._results.value;
            if(newValue === true) {
                loading.classList.remove('hidden');
                results.classList.add('hidden');
            } else {
                loading.classList.add('hidden');
                results.classList.remove('hidden');
            }
        });

        this.watch('results', (_path, _oldValue, newValue) => {
            const noResults = this._noResults.value;
            const results = this._results.value;
            if(newValue.length === 0) {
                noResults.classList.remove('hidden');
                results.classList.add('hidden');
                return;
            }

            noResults.classList.add('hidden');
            results.classList.remove('hidden');
            Array.from(results.children).forEach(el => el.remove());

            for(const candidate of newValue) {
                results.append(this._renderCandidate(candidate));
            }
        });

        this.watch('current-song', (_path, _oldValue, newValue) => {
            const query = `${newValue.title} ${newValue.artist}`;
            (this._noResults.value).classList.add('hidden');
            Array.from((this._results.value).children).forEach(el => el.remove());
            (this._songName.value).textContent = `${newValue.title} - ${newValue.artist}`;
            (this._queryInput.value).value = query;

            this.search(query);
        });

        this.watch('applying', (_path, _oldValue, newValue) => {
            this.root.querySelectorAll('.apply-lyrics-btn')
                .forEach(btn => btn.disabled = newValue);
        });
    }

    /**
     * @param {import('./songContextMenu.js').SongModel} song
     */
    show(song) {
        this.root.show();
        if(song) this.set('current-song', song);
    }

    hide() {
        this.root.hide();
    }

    hasActions() {
        return this.root.hasActions();
    }

    /**
     * @param {import('../services/lyrics.js').LyricsCandidate} candidate
     * @returns {HTMLElement}
     */
    _renderCandidate(candidate) {
        const meta = [
            candidate.album ? Utils.escapeHtml(candidate.album) : null,
            candidate.duration ? Utils.formatDuration(candidate.duration) : null,
        ].filter(Boolean).join(' · ');

        return h.div(a.class('lyrics-result-card'),
            h.div(a.class('lyrics-result-info'),
                h.div(a.class('lyrics-result-title'),
                    h.span(Utils.escapeHtml(candidate.title)),
                    h.span(a.class(candidate.synced ? 'lyrics-synced-badge' : 'lyrics-plain-badge'),
                        candidate.synced ? 'Synced' : 'Plain'),
                ),
                h.div(a.class('lyrics-result-artist'), Utils.escapeHtml(candidate.artist)),
                meta ? h.div(a.class('lyrics-result-meta'), meta) : null,
                candidate.snippet
                    ? h.pre(a.class('lyrics-result-snippet'), candidate.snippet)
                    : null,
            ),
            h.div(a.class('lyrics-result-action'),
                h.button(a.class('btn', 'btn-primary', 'apply-lyrics-btn'), on.click(() => this.apply(candidate)), 'Use')
            )
        );
    }

    /**
     * @param {import('../services/lyrics.js').LyricsCandidate} candidate
     */
    async apply(candidate) {
        /** @type {import('./songContextMenu.js').SongModel?} */
        const currentSong = this.get('current-song');
        if(!currentSong) return;
        this.set('applying', true);

        const data = await useLyricsService().apply(currentSong.id, candidate.id);
        this.set('applying', false);

        if(data.error) {
            Logger.error(data.error);

            /** @type {import('../app.js').RainyApp} */
            const app = useContext().get('app');
            app.showToast('Failed to apply lyrics', 'error');

            return;
        }

        this.hide();

        /** @type {import('../app.js').RainyApp} */
        const app = useContext().get('app');
        app.showToast('Lyrics updated', 'success');

        if(window.player && window.player.currentSong && window.player.currentSong.id === currentSong.id) {
            window.player.loadLyrics(currentSong.id);
        }
    }

    /**
     * @param {string} query
     */
    async search(query) {
        if(query.length === 0) return;
        this.set('loading', true);
        (this._noResults.value).classList.add('hidden');
        Array.from((this._results.value).children).forEach(el => el.remove());

        const data = await useLyricsService().search(query);
        if(data.error) {
            Logger.error(data.error);
            this.set('loading', false);
            this.set('results', []);

            return;
        }

        this.set('loading', false);

        const matches = data.value;
        if(!matches) return Logger.error('unreachable');
        this.set('results', matches.results);
    }

    render() {
        return H.of(Modal,
            I.Lyrics('currentColor', a.slot('header-icon')),
            h.h2(a.slot('header-title'), 'Find Lyrics'),
            h.div(a.slot('body'), a.class('metadata-current-song'),
                h.span(a.class('label'), 'Searching for:'),
                h.span(this._songName, a.class('song-name'), 'Song Name')
            ),
            h.div(a.slot('body'), a.class('metadata-search-bar'),
                h.input(this._queryInput, a.type('text'), a.placeholder('Search LRCLIB...'),
                    on.keydown((ev) => {
                        if(ev.key === 'Enter') this.search((this._queryInput.value).value);
                    })),
                h.button(a.class('btn', 'btn-primary'), on.click(() => this.search((this._queryInput.value).value)),
                    I.Magnifier()
                )
            ),
            h.div(this._loading, a.slot('body'), a.class('metadata-loading', 'hidden'),
                h.div(a.class('loading-spinner')),
                h.p('Searching...')
            ),
            h.div(this._results, a.slot('body'), a.class('metadata-results', 'lyrics-results')),
            h.div(this._noResults, a.slot('body'), a.class('metadata-no-results', 'hidden'),
                h.p('No lyrics found. Try a different search term.')
            )
        );
    }
};

customElements.define(LyricsModal.componentName, LyricsModal);
