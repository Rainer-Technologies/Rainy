import { useContext } from "../helper/context.js";
import { Logger } from "../helper/logger.js";
import { Utils } from "../modules/utils.js";
import { useMetadataService } from "../services/metadata.js";
import { I } from "./icon.js";
import { a, Component, H, h, on, Ref, useRef } from "./index.js";
import { Modal } from "./modal.js";
import { t } from "../i18n/index.js";

export class MetadataModal extends Component {
    static componentName = 'rainy-metadata-modal';

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
        this.set('songs', [], { silent: true });
        this.set('current-song', null, { silent: true });
        this.set('applying', false, { silent: true });

        this.watch('loading', (_path, _oldValue, newValue) => {
            const root = this._loading.value;
            if(newValue === true) root.classList.remove('hidden');
            else root.classList.add('hidden');
        });

        this.watch('songs', (_path, _oldValue, newValue) => {
            const noResults = this._noResults.value;
            if(newValue.length === 0) {
                noResults.classList.remove('hidden');
                return;
            }

            noResults.classList.add('hidden');
            const results = this._results.value;
            Array.from(results.children).forEach(el => el.remove());
            
            for(const song of newValue) {
                results.append(this._renderSong(song));
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
            this.root.querySelectorAll('.apply-metadata-btn')
                .forEach(btn => btn.disabled = !newValue);
        });
    }

    /**
     * @param {import('./songContextMenu.js').SongModel} query
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
     * @param {import('../services/metadata.js').SongModel} song
     * @returns {HTMLElement}
     */
    _renderSongCover(song) {
        if(song.cover_url) {
            return h.img(a.src(song.cover_url), a.alt('song_cover'), a.loading('lazy'));
        }

        return I.Note();
    }

    /**
     * @param {import('../services/metadata.js').SongModel} song
     * @returns {HTMLElement}
     */
    _renderSong(song) {
        return h.div(a.class('metadata-result-card'),
            h.div(a.class('metadata-result-cover'),
                this._renderSongCover(song)
            ),
            h.div(a.class('metadata-result-info'),
                h.div(a.class('metadata-result-title'), Utils.escapeHtml(song.title)),
                h.div(a.class('metadata-result-artist'), Utils.escapeHtml(song.artist)),
                h.div(a.class('metadata-result-album'), Utils.escapeHtml(song.album)),
                h.div(a.class('metadata-result-duration'), song.duration_text || Utils.formatDuration(song.duration))
            ),
            h.div(a.class('metadata-result-action'),
                h.button(a.class('btn', 'btn-primary', 'apply-metadata-btn'), on.click(() => this.apply(song)), t('Apply'))
            )
        );
    }

    /**
     * @param {import('../services/metadata.js').SongModel} song
     */
    async apply(song) {
        /** @type {import('./songContextMenu.js').SongModel?} */
        const currentSong = this.get('current-song');
        if(!currentSong) return;
        this.set('applying', true);

        const data = await useMetadataService().apply(currentSong.id,
            song.title, song.artist, song.album, song.year, song.genre, song.cover_url);
        if (data.error) {
            Logger.log(data.error);
            this.set('applying', false);

            return;
        }

        const result = data.value;
        if (!result) return Logger.error('unreachable');
        this.hide();

        /** @type {import('../app.js').RainyApp} */
        const app = useContext().get('app');

        const updatedSong = result.song;
        if(updatedSong.cover_path) {
            app.coverVersion[currentSong.id] = Date.now();
            app.coverOverride[currentSong.id] = updatedSong.cover_path;
        }

        const songIndex = app.songs.findIndex(s => s.id === currentSong.id);
        if(songIndex !== -1) {
            app.songs[songIndex] = { ...app.songs[songIndex], ...updatedSong };
        }

        const filteredIndex = app.filteredSongs.findIndex(s => s.id === currentSong.id);
        if(filteredIndex !== -1) {
            app.filteredSongs[filteredIndex] = { ...app.filteredSongs[filteredIndex], ...updatedSong };
        }

        if(app.librarySongs) {
            const libIndex = app.librarySongs.findIndex(s => s.id === currentSong.id);
            if (libIndex !== -1) {
                app.librarySongs[libIndex] = { ...app.librarySongs[libIndex], ...updatedSong };
            }
        }

        if(app.librarySections) {
            for (const section of app.librarySections) {
                const sectionSongIndex = section.songs.findIndex(s => s.id === currentSong.id);
                if (sectionSongIndex !== -1) {
                    section.songs[sectionSongIndex] = { ...section.songs[sectionSongIndex], ...updatedSong };
                }
            }
        }

        if(app.sections && app.sections.length > 0) {
            for(const section of app.sections) {
                const sectionSongIndex = section.songs.findIndex(s => s.id === currentSong.id);
                if(sectionSongIndex !== -1) {
                    section.songs[sectionSongIndex] = { ...section.songs[sectionSongIndex], ...updatedSong };
                }
            }
            app.renderSections();
        } else {
            app.renderSongs();
        }

        if (updatedSong.cover_path) {
            app.coverVersion[currentSong.id] = Date.now();
            setTimeout(() => {
                const ts = app.coverVersion[currentSong.id] || Date.now();
                document.querySelectorAll(`[data-id="${currentSong.id}"] .song-artwork, [data-id="${currentSong.id}"] .song-row-artwork`).forEach(container => {
                    const img = container.querySelector('img');
                    if (img) {
                        const base = img.src.split('?')[0];
                        img.src = `${base}?t=${ts}`;
                    } else {
                        const svg = container.querySelector('svg');
                        const newImg = document.createElement('img');
                        newImg.alt = 'Cover';
                        newImg.loading = 'lazy';
                        newImg.src = `/api/music/cover/${encodeURIComponent(updatedSong.cover_path)}?t=${ts}`;
                        newImg.onerror = () => window.handleCoverError ? window.handleCoverError(newImg) : null;
                        if (svg) {
                            container.insertBefore(newImg, svg);
                            svg.remove();
                        } else {
                            container.insertBefore(newImg, container.firstChild);
                        }
                    }
                });
            }, 50);
        }

        if(window.player && window.player.currentSong && window.player.currentSong.id === currentSong.id) {
            window.player.updateNowPlaying(updatedSong);
        }

        app.showToast('Metadata updated successfully', 'success');
    }

    /**
     * @param {string} query 
     */
    async search(query) {
        if(query.length === 0) return;
        this.set('loading', true);
        Array.from((this._results.value).children).forEach(el => el.remove());

        const data = await useMetadataService().search(query);
        if (data.error) {
            Logger.error(data.error);
            this.set('loading', false);
            this.set('songs', []);

            return;
        }

        this.set('loading', false);

        const matches = data.value;
        if(!matches) return Logger.error('unreachable');
        this.set('songs', matches.results);
    }

    render() {
        return H.of(Modal,
            I.Magnifier('currentColor', a.slot('header-icon')),
            h.h2(a.slot('header-title'), t('Find Metadata')),
            h.div(a.slot('body'), a.class('metadata-current-song'),
                h.span(a.class('label'), t('Searching for:')),
                h.span(this._songName, a.class('song-name'), t('Song Name'))
            ),
            h.div(a.slot('body'), a.class('metadata-search-bar'),
                h.input(this._queryInput, a.type('text'), a.placeholder(t('Search YouTube Music...'))),
                h.button(a.class('btn', 'btn-primary'), on.click(() => this.search((this._queryInput.value).value)),
                    I.Magnifier()
                )
            ),
            h.div(this._loading, a.slot('body'), a.class('metadata-loading', 'hidden'),
                h.div(a.class('loading-spinner')),
                h.p(t('Searching...'))
            ),
            h.div(this._results, a.slot('body'), a.class('metadata-results')),
            h.div(this._noResults, a.slot('body'), a.class('metadata-no-results', 'hidden'),
                h.p(t('No results found. Try a different search term.'))
            )
        );
    }
};

customElements.define(MetadataModal.componentName, MetadataModal);