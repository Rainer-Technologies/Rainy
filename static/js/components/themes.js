import { getLanguage, onLanguageChange, t } from "../i18n/index.js";
import { useThemesService } from "../services/themes.js";
import { THEMES, onThemesChange, themeIds, themeText, unsupportedReason } from "../theme/index.js";
import { currentTheme, isSafe, onThemeChange, setSafeMode } from "../theme/host.js";
import { a, Component, h, on, useRef } from "./index.js";
import { formatSize, packagePicture } from "./packageUi.js";

/** A theme's name and description in the interface's language. */
function texts(id) {
    const def = THEMES[id];
    if (def.builtin) return { name: t(def.name), description: t(def.description) };
    const lang = getLanguage();
    return { name: themeText(id, 'name', lang), description: themeText(id, 'description', lang) };
}

/**
 * What stands in for a theme's picture when its package has none: a little
 * window drawn in its own colours.
 */
function swatch(def) {
    // Rainy's own colours (variables.css) for what a theme leaves as it is.
    const tok = def.tokens || {};
    const light = def.colorScheme === 'light';
    const bg = tok['--bg-primary'] || (light ? '#f7f7f8' : '#0d0d0d');
    const panel = tok['--bg-secondary'] || (light ? '#ffffff' : '#1a1a1a');
    const accent = tok['--accent-primary'] || '#3d7dc4';
    const text = tok['--text-primary'] || (light ? '#111111' : '#ffffff');
    const plate = h.div(a.class('settings-theme-swatch'), a['aria-hidden']('true'),
        h.span(a.class('settings-theme-swatch-side')),
        h.span(a.class('settings-theme-swatch-main'),
            h.span(a.class('settings-theme-swatch-line')),
            h.span(a.class('settings-theme-swatch-line', 'short')),
            h.span(a.class('settings-theme-swatch-dot'))),
        h.span(a.class('settings-theme-swatch-bar')));
    plate.style.setProperty('--sw-bg', bg);
    plate.style.setProperty('--sw-panel', panel);
    plate.style.setProperty('--sw-accent', accent);
    plate.style.setProperty('--sw-text', text);
    return plate;
}

/**
 * Settings → Appearance: which interface theme to wear. One card per theme
 * on the server, with the picture its package brought (or a swatch in its
 * colours); picking one puts it on at once and saves the `ui_theme` preference.
 */
export class ThemePicker extends Component {
    static componentName = 'rainy-theme-picker';

    created() {
        this._group = useRef(null);
        this._safe = useRef(null);
        this._stops = [
            onThemesChange(() => this._fill()),
            onThemeChange(() => this._select()),
            onLanguageChange(() => this._fill()),
        ];
    }

    destroyed() {
        for (const stop of this._stops) stop();
    }

    async _pick(id) {
        if (unsupportedReason(id)) return;
        if (isSafe()) await setSafeMode(false);
        await window.app?.pickInterfaceTheme?.(id);
        this._select();
    }

    _option(id) {
        const def = THEMES[id];
        const { name, description } = texts(id);
        const problem = unsupportedReason(id) === 'api' ? t('Needs a newer version of Rainy') : '';
        const credit = [def.version && `v${def.version}`, def.author].filter(Boolean).join(' · ');
        const scheme = def.colorScheme === 'light' ? t('Light') : t('Dark');
        return h.div(a.class('settings-env-card', 'settings-theme-card', problem ? 'is-unavailable' : ''), a['data-value'](id),
            a.role('radio'), a.tabindex(problem ? '-1' : '0'), a['aria-checked']('false'),
            on.click(() => this._pick(id)),
            on.keydown((e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                this._pick(id);
            }),
            packagePicture(def.preview, () => swatch(def)),
            h.div(a.class('settings-env-body'),
                h.div(a.class('settings-env-name'),
                    h.span(name),
                    def.dev ? h.span(a.class('settings-env-tag'), t('Development')) : null,
                    h.span(a.class('settings-env-check'), a['aria-hidden']('true')),
                ),
                description ? h.div(a.class('settings-env-description'), description) : null,
                h.div(a.class('settings-env-credit'), [scheme, credit].filter(Boolean).join(' · ')),
                problem ? h.div(a.class('settings-env-problem'), problem) : null,
            ),
        );
    }

    _fill() {
        const group = this._group.value;
        if (!group) return;
        group.replaceChildren(...themeIds().map((id) => this._option(id)));
        this._select();
    }

    _select() {
        const group = this._group.value;
        if (!group) return;
        const value = currentTheme();
        for (const item of group.children) {
            const on = item.dataset.value === value;
            item.classList.toggle('selected', on);
            item.setAttribute('aria-checked', String(on));
        }
        if (this._safe.value) this._safe.value.classList.toggle('hidden', !isSafe());
    }

    render() {
        const root = h.div(a.class('settings-theme-picker'),
            h.div(this._safe, a.class('settings-theme-safe', 'hidden'),
                h.span(t('Safe mode: this tab shows Rainy\'s own look whatever theme you picked.')),
                h.button(a.class('btn', 'btn-secondary', 'btn-sm'), a.type('button'),
                    on.click(async () => { await setSafeMode(false); this._select(); }), t('Turn off'))),
            h.div(this._group, a.class('settings-env-grid'), a.role('radiogroup'),
                a['aria-label'](t('Interface theme'))),
        );
        queueMicrotask(() => this._fill());
        return root;
    }
}

customElements.define(ThemePicker.componentName, ThemePicker);

/**
 * Settings → Appearance (administrators): the theme packages installed on this
 * server. Install one from a .zip, switch one off, make one everyone's
 * default, remove one, and check the theme in use for controls it hides.
 */
export class ThemeManager extends Component {
    static componentName = 'rainy-theme-manager';

    created() {
        this._list = useRef(null);
        this._file = useRef(null);
        this._button = useRef(null);
        this._report = useRef(null);
        this.set('items', [], { silent: true });
        this.set('default', null, { silent: true });
        this.set('busy', false, { silent: true });
        this.watch('items', () => this._fill());
        this.watch('default', () => this._fill());
        this.watch('busy', (_path, _old, busy) => {
            if (this._button.value) this._button.value.disabled = !!busy;
        });
        this._stops = [onLanguageChange(() => this._fill())];
    }

    destroyed() {
        for (const stop of this._stops) stop();
    }

    /** Fetch the list again (also refreshes the theme registry). */
    async refresh() {
        const res = await useThemesService().refresh();
        if (!res.error && res.value) {
            this.set('default', res.value.default || null);
            this.set('items', res.value.themes);
        }
    }

    async _install(file) {
        if (!file) return;
        const warning = t('Install "{file}"?\n\nA theme restyles Rainy for everyone who uses this server and may run code in their browser, with their session. Only install packages from authors you trust.', { file: file.name });
        if (!confirm(warning)) return;
        this.set('busy', true);
        const res = await useThemesService().install(file);
        this.set('busy', false);
        if (res.error) {
            this._showReport([t('Could not install the theme: {error}', { error: res.error.error || '' })], 'error');
            return;
        }
        const theme = res.value.theme;
        window.showToast?.(res.value.updated
            ? t('{name} updated to version {version}', { name: theme.name, version: theme.version })
            : t('{name} {version} installed', { name: theme.name, version: theme.version }), 'success');
        this._showReport(res.value.warnings || [], 'warning');
        this.refresh();
    }

    async _toggle(item, enabled) {
        const res = await useThemesService().setEnabled(item.id, enabled);
        if (res.error) window.showToast?.(res.error.error || t('Could not update the theme'), 'error');
        await this.refresh();
        if (!enabled) window.app?.loadInterfaceTheme?.();
    }

    async _makeDefault(item) {
        const id = this.get('default') === item.id ? null : item.id;
        const res = await useThemesService().setDefault(id);
        if (res.error) window.showToast?.(res.error.error || t('Could not update the theme'), 'error');
        else window.showToast?.(id
            ? t('{name} is now the theme of everyone who has not picked one', { name: item.name })
            : t('Rainy\'s own look is the default again'), 'success');
        this.refresh();
    }

    async _remove(item) {
        if (!confirm(t('Remove the "{name}" theme from this server? Anyone wearing it goes back to the default.', { name: item.name }))) return;
        const res = await useThemesService().remove(item.id);
        if (res.error) window.showToast?.(res.error.error || t('Could not remove the theme'), 'error');
        else window.showToast?.(t('{name} removed', { name: item.name }), 'success');
        await this.refresh();
        window.app?.loadInterfaceTheme?.();
    }

    /** Check the theme in use on every view for controls it hides, covers or makes unreadable. */
    async _audit(button) {
        button.disabled = true;
        this._showReport([t('Checking every view…')], 'info');
        try {
            const { auditAllViews, describeReport } = await import('../theme/audit.js');
            const report = await auditAllViews();
            this._showReport(describeReport(report, t), report.problems.length ? 'error' : 'success');
        } catch (e) {
            this._showReport([String(e && e.message || e)], 'error');
        } finally {
            button.disabled = false;
        }
    }

    _showReport(lines, kind) {
        const box = this._report.value;
        if (!box) return;
        box.className = `settings-theme-report is-${kind}`;
        box.classList.toggle('hidden', !lines.length);
        box.replaceChildren(...lines.map((line) => h.div(line)));
    }

    _row(item) {
        const isDefault = this.get('default') === item.id;
        const details = [
            `v${item.version}`,
            item.author,
            item.colorScheme === 'light' ? t('Light') : t('Dark'),
            item.size ? formatSize(item.size) : '',
            item.entry ? t('Has code') : '',
            item.dev ? t('Development folder') : '',
        ].filter(Boolean).join(' · ');
        return h.div(a.class('settings-row', 'settings-env-row', item.enabled ? '' : 'is-off'),
            item.preview ? h.img(a.class('settings-env-thumb'), a.src(item.preview), a.alt(''), a.loading('lazy')) : null,
            h.div(a.class('settings-row-info'),
                h.div(a.class('settings-row-label'), item.name,
                    isDefault ? h.span(a.class('settings-env-tag'), t('Default')) : null),
                h.div(a.class('settings-row-hint'), details),
            ),
            h.div(a.class('settings-row-control', 'settings-env-actions'),
                item.enabled ? h.button(a.class('btn', 'btn-secondary', 'btn-sm'), a.type('button'),
                    a['aria-pressed'](String(isDefault)), on.click(() => this._makeDefault(item)),
                    isDefault ? t('Not default') : t('Make default')) : null,
                // A package served from the development folder is not installed: nothing to switch or remove.
                item.dev ? null : h.label(a.class('toggle-switch'), a.title(t('Enabled')),
                    (() => {
                        const input = h.input(a.type('checkbox'), on.change((e) => this._toggle(item, e.target.checked)));
                        input.checked = !!item.enabled;
                        return input;
                    })(),
                    h.span(a.class('toggle-slider')),
                ),
                item.dev ? null : h.button(a.class('btn', 'btn-secondary', 'btn-sm'), a.type('button'),
                    on.click(() => this._remove(item)), t('Remove')),
            ),
        );
    }

    _fill() {
        const list = this._list.value;
        if (!list) return;
        const items = this.get('items') || [];
        list.replaceChildren(...(items.length
            ? items.map((item) => this._row(item))
            : [h.div(a.class('settings-row-hint', 'settings-env-empty'), t('No themes installed. Rainy\'s own look is always available.'))]));
    }

    render() {
        const audit = h.button(a.class('btn', 'btn-secondary', 'btn-sm'), a.type('button'),
            on.click(() => this._audit(audit)), t('Check the theme in use'));
        const root = h.div(a.class('settings-env-manager'),
            h.div(this._list, a.class('settings-env-list')),
            h.div(this._report, a.class('settings-theme-report', 'hidden'), a.role('status')),
            h.div(a.class('settings-env-install'),
                h.input(this._file, a.type('file'), a.accept('.zip,application/zip'), a.hidden(''),
                    on.change((e) => {
                        const file = e.target.files && e.target.files[0];
                        e.target.value = '';
                        this._install(file);
                    })),
                h.button(this._button, a.class('btn', 'btn-secondary', 'btn-sm'), a.type('button'),
                    on.click(() => this._file.value.click()), t('Install package (.zip)')),
                audit,
            ),
        );
        queueMicrotask(() => this._fill());
        return root;
    }
}

customElements.define(ThemeManager.componentName, ThemeManager);
