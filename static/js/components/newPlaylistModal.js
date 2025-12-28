import { PLAYLIST_ICON_COLORS, PLAYLIST_ICONS } from "../data/playlist-icons.js";
import { useContext } from "../helper/context.js";
import { Logger } from "../helper/logger.js";
import { usePlaylistService } from "../services/playlist.js";
import { Component, html } from "./index.js";

export class NewPlaylistModal extends Component {
    static componentName = 'rainy-new-playlist-modal';

    created() {
        this.set('current-icon', 'music-note', { silent: true });
        this.set('current-color', '#888888', { silent: true });

        this.watch('current-icon', () => {
            this._renderIconPreview();
            this._renderIconPickers();
        });

        this.watch('current-color', () => {
            this._renderIconPreview();
            this._renderIconPickers();
            this._renderColorPresets();
        });
    }

    /**
     * @param {string} iconId
     * @returns {{
     *  name: string;
     *  path: string;
     * }}
     */
    _getIcon(iconId) {
        return PLAYLIST_ICONS[iconId];
    }

    /**
     * @param {string} iconId
     * @param {string} color 
     */
    _renderIcon(iconId, color) {
        const icon = this._getIcon(iconId);
        return html(this)`<svg viewBox='0 0 24 24' style='fill: ${color}'>
            <path d='${icon.path}' />
        </svg>`;
    }

    show() {
        this.root.show();
    }

    hide() {
        this.root.hide();
    }

    hasActions() {
        return this.root.hasActions();
    }

    /**
     * @param {string} iconId 
     */
    changeIcon(iconId) {
        this.set('current-icon', iconId);
    }

    /**
     * @param {string} color 
     */
    changeColor(color) {
        this.set('current-color', color);
    }

    _renderIconPreview() {
        const currentIcon = this.get('current-icon');
        const currentColor = this.get('current-color');

        const root = this.root.querySelector('.playlist-preview-icon');
        root.innerHTML = '';

        root.append(this._renderIcon(currentIcon, currentColor));
    }

    _renderIconPickers() {
        const currentIcon = this.get('current-icon');
        const currentColor = this.get('current-color');

        const root = this.root.querySelector('.icon-picker');
        root.innerHTML = '';

        for(const icon of Object.keys(PLAYLIST_ICONS)) {
            root.append(html(this)`<button 
                type='button' 
                class='icon-picker-btn ${(icon === currentIcon) ? 'selected' : ''}' 
                :click=${() => this.changeIcon(icon)}>
                ${this._renderIcon(icon, currentColor)}
            </button>`);
        }
    }

    _renderColorPresets() {
        const currentColor = this.get('current-color');
        const root = this.root.querySelector('.color-presets');
        root.innerHTML = '';

        for(const color of PLAYLIST_ICON_COLORS) {
            root.append(html(this)`<button 
                type='button' 
                class='color-preset ${(color === currentColor) ? 'selected' : ''}' 
                style='background-color: ${color};' 
                :click=${() => this.changeColor(color)}></button>`);
        }
    }

    async createPlaylist() {
        /** @type {import('../app.js').RainyApp} */
        const app = useContext().get('app');

        const input = this.root.querySelector('.playlist-name-input-styled');
        const name = input.value;
        if(!name) return;

        const currentIcon = this.get('current-icon');
        const currentColor = this.get('current-color');

        const data = await usePlaylistService().create(name, currentIcon, currentColor);
        if (data.error) {
            Logger.error(data.error);
            app.showToast('Failed to create playlist', 'error');
            return;
        }

        this.hide();
        
        await app.loadPlaylists();
        app.showToast('Playlist created', 'success');
    }

    render() {
        const root = this.root = html(this)`<rainy-modal>
            <svg slot='header-icon' viewBox='0 0 24 24' fill='currentColor'>
                <path d='M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z' />
            </svg>
            <h2 slot='header-title'>New Playlist</h2>
            <p slot='header-subtitle'>Create a personalized playlist</p>
            <div slot='body' class='playlist-preview-section'>
                <div class='playlist-preview-icon'></div>
                <input type='text' class='playlist-name-input-styled' placeholder='Playlist name'>
            </div>
            <div slot='body' class='playlist-customize-section'>
                <div class='customize-row'>
                    <div class='customize-group'>
                        <label class='form-label'>Choose Icon</label>
                        <div class='icon-picker'></div>
                    </div>
                </div>
                <div class='customize-row'>
                    <div class='customize-group'>
                        <label class='form-label'>Choose Color</label>
                        <div class='color-picker-row'>
                            <input type='color' class='color-input' value='#888888'>
                            <div class='color-presets'></div>
                        </div>
                    </div>
                </div>
            </div>
            <button slot='action' class='btn btn-secondary' :click=${this.hide}>Cancel</button>
            <button slot='action' class='btn btn-primary' :click=${this.createPlaylist}>Create Playlist</button>
        </rainy-modal>`;

        this._renderIconPreview();
        this._renderIconPickers();
        this._renderColorPresets();

        return root;
    }
};

customElements.define(NewPlaylistModal.componentName, NewPlaylistModal);