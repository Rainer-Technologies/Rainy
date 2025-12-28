import { useContext } from "../helper/context.js";
import { Utils } from "../modules/utils.js";
import { useMetadataService } from "../services/metadata.js";
import { Component, html } from "./index.js";

export class MetadataModal extends Component {
    static componentName = 'rainy-metadata-modal';

    created() {
        this.set('loading', false, { silent: true });
        this.set('songs', [], { silent: true });
        this.set('current-song', null, { silent: true });
        this.set('applying', false, { silent: true });

        this.watch('loading', (_path, _oldValue, newValue) => {
            const root = this.root.querySelector('.metadata-loading');
            if(newValue === true) root.classList.remove('hidden');
            else root.classList.add('hidden');
        });

        this.watch('songs', (_path, _oldValue, newValue) => {
            const noResults = this.root.querySelector('.metadata-no-results');
            if(newValue.length === 0) {
                noResults.classList.remove('hidden');
                return;
            }

            noResults.classList.add('hidden');
            const results = this.root.querySelector('.metadata-results');
            results.innerHTML = '';
            
            for(const song of newValue) {
                results.append(this._renderSong(song));
            }
        });

        this.watch('current-song', (_path, _oldValue, newValue) => {
            const query = `${newValue.title} ${newValue.artist}`;

            const noResults = this.root.querySelector('.metadata-no-results');
            const results = this.root.querySelector('.metadata-results');

            noResults.classList.add('hidden');
            results.innerHTML = '';

            const songName = this.root.querySelector('.song-name');
            songName.textContent = `${newValue.title} - ${newValue.artist}`;

            const searchInput = this.root.querySelector('#metadata-search-input');
            searchInput.value = query;

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
            return html(this)`<img src='${song.cover_url}' alt='song_cover' loading='lazy'>`;
        }

        return html(this)`<svg viewBox='0 0 24 24'>
            <path d='M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z' />
        </svg>`;
    }

    /**
     * @param {import('../services/metadata.js').SongModel} song
     * @returns {HTMLElement}
     */
    _renderSong(song) {
        return html(this)`<div class='metadata-result-card'>
            <div class='metadata-result-cover'>
                ${this._renderSongCover(song)}
            </div>
            <div class='metadata-result-info'>
                <div class='metadata-result-title'>${Utils.escapeHtml(song.title)}</div>
                <div class='metadata-result-artist'>${Utils.escapeHtml(song.artist)}</div>
                <div class='metadata-result-album'>${Utils.escapeHtml(song.album)}</div>
                <div class='metadata-result-duration'>${song.duration_text || Utils.formatDuration(song.duration)}</div>
            </div>
            <div class='metadata-result-action'>
                <button class='btn btn-primary apply-metadata-btn' :click=${() => this.apply(song)}>Apply</button>
            </div>
        </div>`
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
            console.log(data.error);
            this.set('applying', false);

            return;
        }

        const result = data.value;
        if (!result) return console.error('unreachable');
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

        const data = await useMetadataService().search(query);
        if (data.error) {
            console.error(data.error);
            this.set('loading', false);
            this.set('songs', []);

            return;
        }

        this.set('loading', false);

        const matches = data.value;
        if(!matches) return console.error('unreachable');
        this.set('songs', matches.results);
    }

    render() {
        return html(this)`<rainy-modal>
            <svg slot='header-icon' viewBox='0 0 24 24' fill='currentColor'>
                <path d='M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z' />
            </svg>
            <h2 slot='header-title'>Find Metadata</h2>
            <div slot='body' class='metadata-current-song'>
                <span class='label'>Searching for:</span>
                <span class='song-name'>Song Name</span>
            </div>
            <div slot='body' class='metadata-search-bar'>
                <input type='text' id='metadata-search-input' placeholder='Search YouTube Music...'>
                <button class='btn btn-primary' :click=${() => this.search(this.root.querySelector('#metadata-search-input').value)}>
                    <svg viewBox='0 0 24 24' fill='currentColor'>
                        <path d='M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z' />
                    </svg>
                </button>
            </div>
            <div slot='body' class='metadata-loading hidden'>
                <div class='loading-spinner'></div>
                <p>Searching...</p>
            </div>
            <div slot='body' class='metadata-results'></div>
            <div slot='body' class='metadata-no-results hidden'>
                <p>No results found. Try a different search term.</p>
            </div>
        </rainy-modal>`;
    }
};

customElements.define(MetadataModal.componentName, MetadataModal);