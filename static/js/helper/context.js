/**
 * @typedef {(path: string, oldValue: any, newValue: any) => void} ListenerCallback
 */

/**
 * @typedef {Object} Listener
 * @property {string} path
 * @property {ListenerCallback} callback
 * @property {boolean} deep
 */

export class Context {
    constructor(raw) {
        /** @type {any} */
        this._raw = raw;
        /** @type {Set<Listener>} */
        this._listeners = new Set();
    }

    /**
     * @param {string} path 
     */
    _resolve(path) {
        let curr = this._raw;
        let parent = null;

        for(const part of path.split('.')) {
            if (curr == null || typeof curr !== 'object') {
                return {};
            }

            parent = curr;
            curr = curr[part];
        }

        return { parent, value: curr };
    }

    /**
     * @param {string} path 
     * @returns {any}
     */
    get(path) {
        const { value } = this._resolve(path);
        return value ?? null;
    }

    _emit(path, oldValue, newValue) {
        for(const listener of this._listeners) {
            if(
                path === listener.path 
                || (listener.deep && path.startsWith(listener.path + '.'))
            ) {
                try {
                    listener.callback(path, oldValue, newValue);
                } catch {};
            }
        }
    }

    /**
     * @param {string} path
     * @param {any} value
     * @param {{
     *  silent: boolean;
     * }} config
     */
    set(path, value, config = { silent: false }) {
        const key = path.split('.').pop();
        const { parent, value: oldValue } = this._resolve(path);
        if(!parent) return;

        if(oldValue !== value) {
            parent[key] = value;
            if(!config.silent) 
                this._emit(path, oldValue, value);
        }
    }

    /**
     * @param {string} path
     * @param {ListenerCallback} callback
     * @param {boolean} deep
     */
    listen(path, callback, deep = false) {
        const listener = { path, callback, deep };
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }
};

const __singleton = new Context({});

/**
 * @returns {Context}
 */
export function useContext() {
    return __singleton;
};

/**
 * @returns {Context}
 */
export function createContext(initial = {}) {
    return new Context(initial);
}