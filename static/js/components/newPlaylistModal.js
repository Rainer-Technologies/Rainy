import { PLAYLIST_ICON_COLORS, PLAYLIST_ICONS } from "../data/playlist-icons.js";
import { useContext } from "../helper/context.js";
import { Logger } from "../helper/logger.js";
import { usePlaylistService } from "../services/playlist.js";
import { I } from "./icon.js";
import { a, Component, H, h, on, Ref, s, useRef } from "./index.js";
import { Modal } from "./modal.js";
import { t } from "../i18n/index.js";

export class NewPlaylistModal extends Component {
    static componentName = 'rainy-new-playlist-modal';

    created() {
        /** @type {Ref<HTMLDivElement>} */
        this._previewIcon = useRef();
        /** @type {Ref<HTMLDivElement>} */
        this._iconPicker = useRef();
        /** @type {Ref<HTMLDivElement>} */
        this._colorPresets = useRef();
        /** @type {Ref<HTMLInputElement>} */
        this._nameInput = useRef();

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
        return s.svg(a.viewBox('0 0 24 24'), a.fill(color),
            s.path(a.d(icon.path))
        );
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

        const root = this._previewIcon.value;
        root.firstElementChild?.remove();
        root.append(this._renderIcon(currentIcon, currentColor));
    }

    _renderIconPickers() {
        const currentIcon = this.get('current-icon');
        const currentColor = this.get('current-color');

        const root = this._iconPicker.value;
        Array.from(root.children).forEach(el => el.remove());

        for(const icon of Object.keys(PLAYLIST_ICONS)) {
            root.append(h.button(a.type('button'),
                a.class('icon-picker-btn', (icon === currentIcon) ? 'selected' : ''),
                on.click(() => this.changeIcon(icon)),
                this._renderIcon(icon, currentColor)
            ));
        }
    }

    _renderColorPresets() {
        const currentColor = this.get('current-color');
        const root = this._colorPresets.value;
        Array.from(root.children).forEach(el => el.remove());

        for(const color of PLAYLIST_ICON_COLORS) {
            root.append(h.button(a.type('button'), 
                a.class('color-preset', (color === currentColor) ? 'selected' : ''), 
                a.style(`background-color: ${color};`), 
                on.click(() => this.changeColor(color))));
        }
    }

    /** @param {InputEvent} ev */
    _changeColor(ev) {
        const originalTarget = ev.originalTarget;
        if(!originalTarget) return;
        const color = originalTarget.value;
        this.set('current-color', color);
    }

    async createPlaylist() {
        /** @type {import('../app.js').RainyApp} */
        const app = useContext().get('app');

        const name = (this._nameInput.value).value;
        if(!name) return;

        const currentIcon = this.get('current-icon');
        const currentColor = this.get('current-color');

        // Per-account isolation: every playlist belongs to its creator and is
        // only visible to them — there is no shared/public option anymore.
        const data = await usePlaylistService().create(name, currentIcon, currentColor, true);
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
        const root = this.root = H.of(Modal,
            I.Plus('currentColor', a.slot('header-icon')),
            h.h2(a.slot('header-title'), t('New Playlist')),
            h.p(a.slot('header-subtitle'), t('Create a personalized playlist')),
            h.div(a.slot('body'), a.class('playlist-preview-section'),
                h.div(this._previewIcon, a.class('playlist-preview-icon')),
                h.input(this._nameInput, a.type('text'), a.class('playlist-name-input-styled'), a.placeholder(t('Playlist name')))
            ),
            h.div(a.slot('body'), a.class('playlist-customize-section'),
                h.div(a.class('customize-row'),
                    h.div(a.class('customize-group'),
                        h.label(a.class('form-label'), t('Choose Icon')),
                        h.div(this._iconPicker, a.class('icon-picker'))
                    )
                ),
                h.div(a.class('customize-row'),
                    h.div(a.class('customize-group'),
                        h.label(a.class('form-label'), t('Choose Color')),
                        h.div(a.class('color-picker-row'),
                            h.input(a.type('color'), a.class('color-input'), a.value('#888888'), on.change((ev) => this._changeColor(ev))),
                            h.div(this._colorPresets, a.class('color-presets'))
                        )
                    )
                ),
            ),
            h.button(a.slot('action'), a.class('btn', 'btn-secondary'), on.click(() => this.hide()), t('Cancel')),
            h.button(a.slot('action'), a.class('btn', 'btn-primary'), on.click(() => this.createPlaylist()), t('Create Playlist'))
        );

        this._renderIconPreview();
        this._renderIconPickers();
        this._renderColorPresets();

        return root;
    }
};

customElements.define(NewPlaylistModal.componentName, NewPlaylistModal);