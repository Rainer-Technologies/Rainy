import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const appSource = readFileSync(new URL('../../static/js/app.js', import.meta.url), 'utf8');

function method(source, name) {
    const plainStart = source.indexOf(`    ${name}(`);
    const start = plainStart >= 0 ? plainStart : source.indexOf(`    async ${name}(`);
    assert.ok(start >= 0, `${name} exists`);
    const end = source.indexOf('\n    }', start) + 6;
    return source.slice(start, end);
}

test('loadLibrary while in friends view does not hijack view or unhide library', async () => {
    const elements = new Map();
    const element = id => {
        if (!elements.has(id)) {
            const classes = new Set(['hidden']);
            elements.set(id, {
                value: '', textContent: '', innerHTML: '', classList: {
                    add: c => classes.add(c), remove: c => classes.delete(c),
                    toggle: (c, force) => force ? classes.add(c) : classes.delete(c),
                    contains: c => classes.has(c),
                }
            });
        }
        return elements.get(id);
    };

    element('friends-view').classList.remove('hidden');

    let currentView = 'friends';
    const context = {
        get: (key) => key === 'current-view-type' ? currentView : null,
        set: (key, value) => { if (key === 'current-view-type') currentView = value; }
    };

    let libraryFetched = false;
    const mockMusicService = {
        library: async () => {
            libraryFetched = true;
            return {
                value: {
                    version: 2,
                    all_songs: [{ id: 10, title: 'Sent Song', artist: 'Artist' }],
                    sections: []
                }
            };
        }
    };

    const sandbox = vm.createContext({
        useContext: () => context,
        useMusicService: () => mockMusicService,
        document: {
            getElementById: element,
            querySelector: element,
            querySelectorAll: () => [],
        },
        Logger: { warn: () => {}, error: () => {} },
    });

    const app = vm.runInContext(`({
        ${method(appSource, 'loadLibrary')},
        ${method(appSource, 'applyLibraryUpdate')},
        renderSections() { throw new Error('renderSections should not be called while in friends view'); },
        refreshLibraryQueue() {},
        updateViewModeControls() {},
        updateStats() {},
    })`, sandbox);

    app.libraryWatcher = { noteSongsVersion: () => {} };
    app.librarySongs = [];
    app.librarySections = [];

    // Call loadLibrary without silent flag (e.g. from an unflagged call)
    const result = await app.loadLibrary();

    assert.ok(result);
    assert.ok(libraryFetched);
    // current view must still be 'friends'
    assert.equal(currentView, 'friends');
    // songs-grid must still be hidden
    assert.ok(element('songs-grid').classList.contains('hidden'));
    // friends-view must still NOT be hidden
    assert.ok(!element('friends-view').classList.contains('hidden'));
    // librarySongs cache was updated
    assert.equal(app.librarySongs.length, 1);
    assert.equal(app.librarySongs[0].title, 'Sent Song');
});
