import { getLanguage, onLanguageChange, t } from "../i18n/index.js";
import {
    ENVIRONMENTS, DEFAULT_ENVIRONMENT, environmentIds, environmentText, onEnvironmentsChange, unsupportedReason,
} from "../lightshow/environments/index.js";
import { useEnvironmentsService } from "../services/environments.js";
import { a, Component, h, on, useRef } from "./index.js";

const FEATURE_NAMES = { webgl: 'WebGL', webgl2: 'WebGL 2', webgpu: 'WebGPU' };

/** An environment's name and description in the interface's language. */
function texts(id) {
    const def = ENVIRONMENTS[id];
    if (def.builtin) return { name: t(def.name), description: t(def.description) };
    const lang = getLanguage();
    return { name: environmentText(id, 'name', lang), description: environmentText(id, 'description', lang) };
}

/** Why an environment cannot be picked on this device, in words ('' when it can). */
function unsupportedText(id) {
    const reason = unsupportedReason(id);
    if (!reason) return '';
    if (reason === 'api') return t('Needs a newer version of Rainy');
    return t('Needs {feature}, which this device does not have', { feature: FEATURE_NAMES[reason] || reason });
}

const formatSize = (bytes) => (bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/**
 * Settings → Light Show: which environment the show runs in. One option per
 * environment on the server; picking one saves the `lightshow_environment`
 * preference, which the show follows live.
 */
export class EnvironmentPicker extends Component {
    static componentName = 'rainy-environment-picker';

    created() {
        this._group = useRef(null);
        this.set('value', DEFAULT_ENVIRONMENT, { silent: true });
        this.watch('value', () => this._select());
        this._stops = [onEnvironmentsChange(() => this._fill()), onLanguageChange(() => this._fill())];
    }

    destroyed() {
        for (const stop of this._stops) stop();
    }

    _pick(id) {
        if (unsupportedReason(id)) return;
        this.set('value', id);
        if (window.app && window.app.savePreferences) window.app.savePreferences({ lightshow_environment: id });
    }

    _option(id) {
        const def = ENVIRONMENTS[id];
        const { name, description } = texts(id);
        const problem = unsupportedText(id);
        const credit = [def.version && `v${def.version}`, def.author].filter(Boolean).join(' · ');
        return h.div(a.class('settings-radio-item', problem ? 'is-unavailable' : ''), a['data-value'](id),
            on.click(() => this._pick(id)),
            h.div(a.class('settings-radio-circle')),
            def.preview ? h.img(a.class('settings-env-preview'), a.src(def.preview), a.alt(''), a.loading('lazy')) : null,
            h.div(a.class('settings-radio-content'),
                h.div(a.class('settings-radio-title'), name, def.dev ? h.span(a.class('settings-env-tag'), t('Development')) : null),
                description ? h.div(a.class('settings-radio-description'), description) : null,
                credit ? h.div(a.class('settings-env-credit'), credit) : null,
                problem ? h.div(a.class('settings-env-problem'), problem) : null,
            ),
        );
    }

    _fill() {
        const group = this._group.value;
        if (!group) return;
        group.replaceChildren(...environmentIds().map((id) => this._option(id)));
        this._select();
    }

    _select() {
        const group = this._group.value;
        if (!group) return;
        // A preference for an environment that is no longer installed shows as the default it falls back to.
        const value = ENVIRONMENTS[this.get('value')] ? this.get('value') : DEFAULT_ENVIRONMENT;
        for (const item of group.children) item.classList.toggle('selected', item.dataset.value === value);
    }

    render() {
        const root = h.div(this._group, a.class('settings-radio-group'));
        queueMicrotask(() => this._fill());
        return root;
    }
}

customElements.define(EnvironmentPicker.componentName, EnvironmentPicker);

/**
 * Settings → Server (administrators): the environment packages installed on
 * this server. Install one from a .zip, switch one off, remove one.
 */
export class EnvironmentManager extends Component {
    static componentName = 'rainy-environment-manager';

    created() {
        this._list = useRef(null);
        this._file = useRef(null);
        this._button = useRef(null);
        this.set('items', [], { silent: true });
        this.set('busy', false, { silent: true });
        this.watch('items', () => this._fill());
        this.watch('busy', (_path, _old, busy) => {
            if (this._button.value) this._button.value.disabled = !!busy;
        });
        this._stops = [onLanguageChange(() => this._fill())];
    }

    destroyed() {
        for (const stop of this._stops) stop();
    }

    /** Fetch the list again (also refreshes the show's registry). */
    async refresh() {
        const res = await useEnvironmentsService().refresh();
        if (!res.error && res.value) this.set('items', res.value.environments);
    }

    async _install(file) {
        if (!file) return;
        const warning = t('Install "{file}"?\n\nAn environment is code that runs in the browser of everyone who uses this server, with their session. Only install packages from authors you trust.', { file: file.name });
        if (!confirm(warning)) return;
        this.set('busy', true);
        const res = await useEnvironmentsService().install(file);
        this.set('busy', false);
        if (res.error) {
            window.showToast?.(t('Could not install the environment: {error}', { error: res.error.error || '' }), 'error');
            return;
        }
        const env = res.value.environment;
        window.showToast?.(res.value.updated
            ? t('{name} updated to version {version}', { name: env.name, version: env.version })
            : t('{name} {version} installed', { name: env.name, version: env.version }), 'success');
        this.refresh();
    }

    async _toggle(item, enabled) {
        const res = await useEnvironmentsService().setEnabled(item.id, enabled);
        if (res.error) window.showToast?.(res.error.error || t('Could not update the environment'), 'error');
        this.refresh();
    }

    async _remove(item) {
        if (!confirm(t('Remove the "{name}" environment from this server? Anyone using it goes back to Classic.', { name: item.name }))) return;
        const res = await useEnvironmentsService().remove(item.id);
        if (res.error) window.showToast?.(res.error.error || t('Could not remove the environment'), 'error');
        else window.showToast?.(t('{name} removed', { name: item.name }), 'success');
        this.refresh();
    }

    _row(item) {
        const details = [
            `v${item.version}`,
            item.author,
            item.size ? formatSize(item.size) : '',
            item.dev ? t('Development folder') : '',
        ].filter(Boolean).join(' · ');
        return h.div(a.class('settings-row', 'settings-env-row', item.enabled ? '' : 'is-off'),
            h.div(a.class('settings-row-info'),
                h.div(a.class('settings-row-label'), item.name),
                h.div(a.class('settings-row-hint'), details),
            ),
            // A package served from the development folder is not installed: nothing to switch or remove.
            item.dev ? null : h.div(a.class('settings-row-control', 'settings-env-actions'),
                h.label(a.class('toggle-switch'), a.title(t('Enabled')),
                    (() => {
                        const input = h.input(a.type('checkbox'), on.change((e) => this._toggle(item, e.target.checked)));
                        input.checked = !!item.enabled;
                        return input;
                    })(),
                    h.span(a.class('toggle-slider')),
                ),
                h.button(a.class('btn', 'btn-secondary', 'btn-sm'), a.type('button'), on.click(() => this._remove(item)), t('Remove')),
            ),
        );
    }

    _fill() {
        const list = this._list.value;
        if (!list) return;
        const items = this.get('items') || [];
        list.replaceChildren(...(items.length
            ? items.map((item) => this._row(item))
            : [h.div(a.class('settings-row-hint', 'settings-env-empty'), t('No environments installed. Classic is always available.'))]));
    }

    render() {
        const root = h.div(a.class('settings-env-manager'),
            h.div(this._list, a.class('settings-env-list')),
            h.div(a.class('settings-env-install'),
                h.input(this._file, a.type('file'), a.accept('.zip,application/zip'), a.hidden(''),
                    on.change((e) => {
                        const file = e.target.files && e.target.files[0];
                        e.target.value = '';
                        this._install(file);
                    })),
                h.button(this._button, a.class('btn', 'btn-secondary', 'btn-sm'), a.type('button'),
                    on.click(() => this._file.value.click()), t('Install package (.zip)')),
            ),
        );
        queueMicrotask(() => this._fill());
        return root;
    }
}

customElements.define(EnvironmentManager.componentName, EnvironmentManager);
