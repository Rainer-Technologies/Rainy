// Exercise the production navigation/search methods with a minimal DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const appSource = readFileSync(new URL('../../static/js/app.js', import.meta.url), 'utf8');
const viewsSource = readFileSync(new URL('../../static/js/modules/newViews.js', import.meta.url), 'utf8');
function method(source, name) {
    const plainStart = source.indexOf(`    ${name}(`);
    const start = plainStart >= 0 ? plainStart : source.indexOf(`    async ${name}(`);
    assert.ok(start >= 0, `${name} exists`);
    const end = source.indexOf('\n    }', start) + 6;
    return source.slice(start, end);
}
function harness(view, mode = 'grid') {
    const elements = new Map();
    const element = id => {
        if (!elements.has(id)) {
            const classes = new Set(['hidden']);
            elements.set(id, { value: '', textContent: '', classList: {
                add: c => classes.add(c), remove: c => classes.delete(c),
                contains: c => classes.has(c),
            } });
        }
        return elements.get(id);
    };
    const viewIds = ['smartmix-view', 'albums-view', 'recent-view', 'artists-view', 'discover-view', 'friends-view'];
    const activeId = { smartmix: 'smartmix-view', albums: 'albums-view', recent: 'recent-view', artists: 'artists-view', discover: 'discover-view', friends: 'friends-view' }[view];
    if (activeId) element(activeId).classList.remove('hidden');
    let currentView = view;
    const context = { get: () => currentView, set: (_, value) => { currentView = value; } };
    const window = { location: new URL(`http://rainy.test/${view}`), history: {
        pushState: (_, __, path) => { window.location = new URL(path, window.location); },
        replaceState: (_, __, path) => { window.location = new URL(path, window.location); },
    } };
    // English pass-through for the i18n helper the methods call.
    const t = (key, params = {}) => key.replace(/\{(\w+)\}/g, (m, name) => params[name] ?? m);
    const sandbox = vm.createContext({ window, URL, URLSearchParams, t, useContext: () => context, document: {
        getElementById: element, querySelector: element, querySelectorAll: () => [],
    } });
    const app = vm.runInContext(`({${['handleSearch', 'switchToLibraryView', 'navigateTo', 'handleRoute', 'updateStats'].map(n => method(appSource, n)).join(',')}})`, sandbox);
    window.newViews = vm.runInContext(`({${method(viewsSource, 'hideNewViews')}})`, sandbox);
    app.user = { id: 1 };
    element('app-view').classList.remove('hidden');
    app.librarySongs = [{ id: 1, title: 'Rain', artist: 'Someone', album: 'Clouds' }, { id: 2, title: 'Sun', artist: 'Other', album: 'Sky' }];
    app.librarySections = [{ songs: app.librarySongs }];
    app.songs = view === 'playlist' ? [app.librarySongs[1]] : [...app.librarySongs];
    app.sections = [{ songs: app.songs }];
    app.currentPlaylistId = view === 'playlist' ? 9 : null;
    app.currentViewMode = mode;
    app.renderSidebarPlaylists = () => {};
    let renders = 0;
    const showResults = () => {
        renders++;
        element('songs-grid').classList[mode === 'grid' ? 'remove' : 'add']('hidden');
        element('songs-list').classList[mode === 'list' ? 'remove' : 'add']('hidden');
    };
    app.renderSongs = showResults;
    app.renderSections = showResults;
    return { app, window, element, viewIds, get currentView() { return currentView; }, get renders() { return renders; } };
}

test('blank header input does not render Library over another section', () => {
    const h = harness('smartmix');
    h.app.handleSearch('   ');
    assert.equal(h.currentView, 'smartmix');
    assert.equal(h.renders, 0);
    assert.ok(h.element('songs-grid').classList.contains('hidden'));
    assert.ok(!h.element('smartmix-view').classList.contains('hidden'));
});

for (const view of ['smartmix', 'albums', 'recent', 'artists', 'discover', 'friends', 'playlist', 'library']) {
    for (const mode of ['grid', 'list']) {
        test(`header search from ${view} in ${mode} belongs only to Library`, () => {
            const h = harness(view, mode);
            h.element('search-input').value = '  RAIN  ';
            h.app.handleSearch('  RAIN  ');
            assert.equal(h.currentView, 'library');
            assert.equal(h.window.location.pathname, '/library');
            assert.equal(h.element('search-input').value, '  RAIN  ');
            assert.equal(h.app.currentPlaylistId, null);
            assert.deepEqual(Array.from(h.app.filteredSongs, s => s.id), [1]);
            for (const id of h.viewIds) assert.ok(h.element(id).classList.contains('hidden'), `${id} must not overlap`);
            assert.ok(!h.element(mode === 'grid' ? 'songs-grid' : 'songs-list').classList.contains('hidden'));
            assert.equal(h.element('stat-songs').textContent, 1);
            h.app.handleSearch('');
            assert.deepEqual(Array.from(h.app.filteredSongs, s => s.id), [1, 2]);
            assert.equal(h.currentView, 'library');
        });
    }
}
