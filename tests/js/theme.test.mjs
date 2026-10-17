// UI themes: the registry, which theme to wear, what the page remembers, and
// the maths of the theme audit. Run with: node --test tests/js/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    THEMES, THEME_API, DEFAULT_THEME, buildTokenCss, cacheEntry, chooseTheme, cleanIcons, cleanStrings, cleanTokens,
    isThemeUrl,
    readCache, readSafeMode, setInstalled, themeIds, themeText, unsupportedReason, defaultTheme,
} from '../../static/js/theme/index.js';
import { compareSignatures, usable } from '../../static/js/theme/audit.js';
import { composite, contrastRatio, parseColor } from '../../static/js/theme/color.js';

const view = (id, extra = {}) => ({
    id, name: id[0].toUpperCase() + id.slice(1), version: '1.0.0', api: THEME_API, rev: 'abc123def456',
    base: `/themes/${id}/abc123def456/`, colorScheme: 'light', tokens: { '--accent-primary': '#e53935' },
    styles: [`/themes/${id}/abc123def456/style.css`], entry: null, preview: null, enabled: true, ...extra,
});

test('the contract and the code speak the same API version', () => {
    const contract = JSON.parse(readFileSync(new URL('../../static/js/theme/contract.json', import.meta.url)));
    assert.equal(contract.api, THEME_API);
});

test('registry: Rainy first, installed themes by name, disabled and impostors left out', () => {
    setInstalled([view('zeta'), view('alpha'), view('off', { enabled: false }), view('rainy', { name: 'Fake' })], null);
    assert.deepEqual(themeIds(), ['rainy', 'alpha', 'zeta']);
    assert.equal(THEMES.rainy.builtin, true);
    assert.equal(THEMES.rainy.name, 'Rainy');
    const alpha = THEMES.alpha;
    // Unchanged files keep the same entry; a new revision replaces it.
    assert.deepEqual(setInstalled([view('zeta'), view('alpha')], null), []);
    assert.equal(THEMES.alpha, alpha);
    assert.deepEqual(setInstalled([view('zeta'), view('alpha', { rev: 'ffffffffffff' })], null), ['alpha']);
    assert.deepEqual(setInstalled([view('alpha', { rev: 'ffffffffffff' })], null), ['zeta']);
    assert.equal(THEMES.zeta, undefined);
});

test('which theme to wear', () => {
    setInstalled([view('alpha'), view('beta'), view('future', { api: THEME_API + 1 })], 'beta');
    assert.equal(defaultTheme(), 'beta');
    assert.equal(chooseTheme('alpha'), 'alpha');
    assert.equal(chooseTheme('rainy'), 'rainy', 'picking Rainy\'s own look is a choice too');
    assert.equal(chooseTheme(null), 'beta', 'no pick: the server\'s default');
    assert.equal(chooseTheme('removed-since'), 'beta', 'a pick that is gone: the default');
    assert.equal(chooseTheme('future'), 'rainy', 'a theme for another contract is never worn');
    assert.equal(unsupportedReason('future'), 'api');
    assert.equal(chooseTheme('alpha', { failed: new Set(['alpha']) }), 'rainy');
    assert.equal(chooseTheme('alpha', { safe: true }), DEFAULT_THEME);
    setInstalled([view('alpha')], 'gone');
    assert.equal(chooseTheme(null), 'rainy', 'a default that is not installed: Rainy\'s own');
});

test('texts in the interface language', () => {
    setInstalled([view('alpha', { rev: 'aaaaaaaaaaaa', description: 'Plain', i18n: { es: { name: 'Alfa' } } })], null);
    assert.equal(themeText('alpha', 'name', 'es'), 'Alfa');
    assert.equal(themeText('alpha', 'name', 'es-ES'), 'Alfa');
    assert.equal(themeText('alpha', 'description', 'es'), 'Plain');
    assert.equal(themeText('alpha', 'name', 'ca'), 'Alpha');
});

test('tokens become the theme layer, and nothing else does', () => {
    const css = buildTokenCss({ colorScheme: 'light', tokens: {
        '--bg-primary': '#fff',
        '--accent-primary': 'red; } body { display: none',
        '--theme-x': 'url(https://evil.example)',
        '--text-primary': 'black !important',
        'color': 'red',
        '--theme-glow': '0 0 4px rgb(0 0 0 / 0.4)',
    } });
    assert.match(css, /^@layer theme \{\n:root \{/);
    assert.match(css, /color-scheme: light;/);
    assert.match(css, /--bg-primary: #fff;/);
    assert.match(css, /--theme-glow: 0 0 4px rgb\(0 0 0 \/ 0.4\);/);
    assert.doesNotMatch(css, /display: none|evil|important|color: red/);
    assert.deepEqual(Object.keys(cleanTokens({ '--a': 'x', '--b': '' })), ['--a']);
});

test('only theme files go into the page', () => {
    assert.ok(isThemeUrl('/themes/encore/abc123def456/style.css'));
    assert.ok(isThemeUrl('/themes/encore/dev-6ad14134/css/shell.css'));
    assert.ok(!isThemeUrl('https://evil.example/x.css'));
    assert.ok(!isThemeUrl('/themes/encore/abc/../../../api/x.css'));
    assert.ok(!isThemeUrl('/themes/encore/abc/x.css") ; @import url("evil'));
    assert.ok(!isThemeUrl('/js/app.js'));
});

test('what the page remembers between visits', () => {
    setInstalled([view('alpha', { styles: ['/themes/alpha/abc123def456/style.css', 'https://evil.example/x.css'] })], null);
    const entry = cacheEntry(THEMES.alpha);
    assert.deepEqual(entry.styles, ['/themes/alpha/abc123def456/style.css']);
    assert.equal(cacheEntry(THEMES.rainy), null, 'Rainy\'s own look needs nothing remembered');
    assert.deepEqual(readCache(JSON.stringify(entry)), entry);
    assert.equal(readCache('{not json'), null);
    assert.equal(readCache(JSON.stringify({ ...entry, api: THEME_API + 1 })), null);
    assert.equal(readCache(JSON.stringify({ ...entry, id: 'rainy' })), null);
    assert.equal(readCache(JSON.stringify({ ...entry, id: 'Bad Id' })), null);
    assert.equal(readCache(null), null);
});

test('safe mode follows ?theme= and the tab', () => {
    assert.deepEqual(readSafeMode('?theme=off', null), { safe: true, remember: true });
    assert.deepEqual(readSafeMode('?theme=on', '1'), { safe: false, remember: false });
    assert.deepEqual(readSafeMode('', '1'), { safe: true, remember: null });
    assert.deepEqual(readSafeMode('?q=x', null), { safe: false, remember: null });
});

test('colours: parsing, compositing and contrast', () => {
    assert.deepEqual(parseColor('#fff'), [255, 255, 255, 1]);
    assert.deepEqual(parseColor('#3d7dc480'), [61, 125, 196, 128 / 255]);
    assert.deepEqual(parseColor('rgba(255, 0, 0, 0.5)'), [255, 0, 0, 0.5]);
    assert.deepEqual(parseColor('rgb(1 2 3 / 50%)'), [1, 2, 3, 0.5]);
    assert.deepEqual(parseColor('color(srgb 1 1 1 / 0.1)'), [255, 255, 255, 0.1]);
    assert.deepEqual(parseColor('transparent'), [0, 0, 0, 0]);
    assert.equal(parseColor('papayawhip'), null);
    const grey = composite([255, 255, 255, 0.5], [0, 0, 0, 1]);
    assert.deepEqual(grey.map(Math.round), [128, 128, 128, 1]);
    assert.equal(Math.round(contrastRatio([0, 0, 0], [255, 255, 255])), 21);
    assert.equal(contrastRatio([10, 10, 10], [10, 10, 10]), 1);
});

test('audit: what a theme did to a control', () => {
    const ok = { visible: true, w: 40, h: 40, inView: true, hit: true, scrollable: false, contrast: 12 };
    assert.ok(usable(ok));
    assert.deepEqual(compareSignatures(ok, ok), []);
    assert.deepEqual(compareSignatures(ok, { ...ok, visible: false }), ['hidden']);
    assert.deepEqual(compareSignatures(ok, { ...ok, w: 2 }), ['tiny']);
    assert.deepEqual(compareSignatures(ok, { ...ok, hit: false }), ['covered']);
    assert.deepEqual(compareSignatures(ok, { ...ok, inView: false, hit: null }), ['offscreen']);
    assert.deepEqual(compareSignatures(ok, { ...ok, inView: false, hit: null, scrollable: true }), [],
        'out of view but reachable by scrolling is fine');
    assert.deepEqual(compareSignatures(ok, { ...ok, contrast: 1.4 }), ['contrast']);
    assert.deepEqual(compareSignatures({ ...ok, contrast: 2 }, { ...ok, contrast: 1.4 }), [],
        'a theme is not blamed for what was already hard to read');
    // A control that cannot be used without the theme is not the theme's fault.
    assert.deepEqual(compareSignatures({ ...ok, visible: false }, { ...ok, visible: false }), []);
    assert.deepEqual(compareSignatures({ ...ok, hit: false }, { ...ok, visible: false }), []);
});

test('icons point at the theme\'s own SVG files, words are plain text', () => {
    assert.deepEqual(cleanIcons({
        play: '/themes/encore/abc123def456/icons/play.svg',
        pause: 'https://evil.example/pause.svg',
        next: '/themes/encore/abc123def456/icons/next.png',
        'Bad Name': '/themes/encore/abc123def456/icons/x.svg',
    }), { play: '/themes/encore/abc123def456/icons/play.svg' });
    assert.deepEqual(cleanStrings({
        es: { Library: 'Inicio', Lyrics: '<b>Letra</b>', Long: 'x'.repeat(161), Num: 7 },
        'not a lang': { Library: 'x' },
        en: {},
    }), { es: { Library: 'Inicio' } });
});

test('what the page remembers carries the icons and the words', () => {
    setInstalled([view('alpha', {
        rev: 'bbbbbbbbbbbb',
        icons: { play: '/themes/alpha/bbbbbbbbbbbb/icons/play.svg', evil: 'javascript:alert(1)' },
        strings: { es: { Library: 'Inicio', Bad: '<i>x</i>' } },
    })], null);
    const entry = cacheEntry(THEMES.alpha);
    assert.deepEqual(entry.icons, { play: '/themes/alpha/bbbbbbbbbbbb/icons/play.svg' });
    assert.deepEqual(entry.strings, { es: { Library: 'Inicio' } });
    assert.deepEqual(readCache(JSON.stringify(entry)).strings, { es: { Library: 'Inicio' } });
    assert.deepEqual(THEMES.rainy.icons, {});
});
