import { createContext } from '../helper/context.js';

export class Component extends HTMLElement {
    constructor() {
        super();

        /** @type {HTMLElement} */
        this.root = null;

        /** @type {Array<Node>} */
        this._children = [];

        /** @type {import('../helper/context.js').Context} */
        this._ctx = createContext({});

        /** @type {Array<() => boolean>} */
        this._unsubscribers = [];
        this._mounted = false;

        if(this.created) this.created();
    }

    /** @returns {Component} */
    static new() {
        if(!this.componentName) return;
        return document.createElement(this.componentName);
    }

    /**
     * @param {string} path 
     * @returns {any}
     */
    get(path) {
        return this._ctx.get(path);
    }

    /**
     * @param {string} path 
     * @param {any} value
     * @param {{
     *  silent: boolean;
     * }} config
     */
    set(path, value, config = { silent: false }) {
        this._ctx.set(path, value, config);
    }

    /**
     * @param {string} path 
     * @param {import('../helper/context.js').ListenerCallback} callback 
     * @param {boolean} deep 
     * @returns {() => boolean}
     */
    watch(path, callback, deep = false) {
        const unsub = this._ctx.listen(path, callback, deep);
        this._unsubscribers.push(unsub);
        return unsub;
    }

    connectedCallback() {
        if(this._mounted) return;
        this._mounted = true;

        if(this._children.length === 0) {
            this._children = Array.from(this.childNodes);
        }

        this._render();
    }

    disconnectedCallback() {
        if(this.parentElement !== null) return;
        this._mounted = false;

        for (const unsub of this._unsubscribers) {
            unsub();
        }
        this._unsubscribers.length = 0;

        if(this.destroyed) this.destroyed();
    }

    /**
     * This is not actually used.
     * It exists only to prevent invocation of
     * connectedCallback and disconnectedCallback
     * when the node is moved between parents.
     */
    connectedMoveCallback() {}

    _render() {
        if(!this._mounted) return;
        if(!this.render) return;

        for(const attrName of this.getAttributeNames()) {
            const attr = this.getAttributeNode(attrName);
            if(attrName.startsWith('&')) {
                this.set(attrName.slice(1), attr.value);
                this.removeAttributeNode(attr);
            }
        }

        const root = this.render();
        if(!root) return;

        const slots = root.querySelectorAll('slot');
        for(const slot of slots) {
            const name = slot.getAttribute('name');
            const assigned = [];

            for(const node of this._children) {
                if(node.nodeType !== Node.ELEMENT_NODE && name) continue;
                const slotName = node.nodeType === Node.ELEMENT_NODE
                    ? node.getAttribute('slot')
                    : null;

                if((name && slotName === name) || (!name && !slotName)) {
                    assigned.push(node);
                }
            }
            if(assigned.length > 0) {
                for(const node of assigned) slot.before(node);
                slot.remove();
            } else {
                while(slot.firstChild) slot.before(slot.firstChild);
                slot.remove();
            }
        }

        if(this.root) this.root.remove();
        this.root = root;
        this.append(this.root);
    }
};

/**
 * Converts camelCase to kebab-case
 * @param {string} camelCase
 */
function toKebabCase(camelCase) {
    return camelCase
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .toLowerCase();
}

/**
 * @template T
 */
export class Ref {
    /**
     * @param {T} value
     */
    constructor(value) {
        this.value = value;
    }
};

/**
 * @template T
 * @param {T} value 
 * @returns {Ref<T>}
 */
export function useRef(value) {
    return new Ref(value);
}

export class Attr {
    /**
     * @param {string} name 
     * @param {any} value 
     */
    constructor(name, value) {
        this.name = name;
        this.value = value;
    }

    /**
     * @param {string} name 
     * @param {any} value 
     * @returns {Attr}
     */
    static of(name, value) {
        return new Attr(name, value);
    }
};

/**
 * @type {Record<string, (...attrValue: any) => Attr}
 */
export const a = new Proxy({}, {
    get: (_, attrName) => (...attrValue) => new Attr(attrName, attrValue.join(' ')),
});

/**
 * @typedef {Object} Event
 * @property {boolean} __event
 * @property {string} typ
 * @property {(ev: Event) => void} listener
 * @property {{
 *  capture?: boolean;
 *  once?: boolean;
 *  passive?: boolean;
 *  signal?: AbortSignal
 * }?} options
 */

/**
 * @type {Record<string, (listener: Event['listener'], options?: Event['options']) => Event}
 */
export const on = new Proxy({}, {
    get: (_, typ) => (listener, options) => ({
        __event: true,
        typ,
        listener,
        options: options ?? null
    })
});

/**
 * @typedef {Object} Prop
 * @property {boolean} __prop
 * @property {string} name
 * @property {any} value
 */

/**
 * @type {Record<string, (value: any) => Prop}
 */
export const prop = new Proxy({}, {
    get: (_, name) => (value) => ({
        __prop: true,
        name,
        value
    })
});

export const p = prop;

/**
 * @param {string | Component} tag
 * @param {string?} ns
 * @param {...(Attr | Event | Prop | Element)} rest
 * @returns {HTMLElement}
 */
export function _html(tag, ns, ...rest) {
    const isComponent = (typeof tag === 'function' && ('componentName' in tag));
    const el = isComponent 
        ? tag.new() 
        : ns
            ? document.createElementNS(ns, tag)
            : document.createElement(tag);
    const n = ns
        ? r => r
        : toKebabCase;

    for(const item of rest) {
        if(item === null || item === undefined) continue;
        if(item instanceof Attr) {
            el.setAttribute(n(item.name), item.value);
        } else if(isComponent && typeof item === 'object' && '__prop' in item) {
            el.set(n(item.name), item.value, { silent: true });
        } else if(typeof item === 'object' && '__event' in item) {
            el.addEventListener(n(item.typ), (ev) => item.listener(ev), item.options ?? null);
        } else if(item instanceof Ref) {
            item.value = el;
        } else if(item instanceof HTMLElement || item instanceof SVGElement) {
            el.appendChild(item);
        } else if(typeof item === 'string') {
            el.appendChild(document.createTextNode(item));
        }
    }

    return el;
};

export class H {
    /**
     * @param {string | Component} tag 
     * @param {...(Attr | Event | Prop | Element)} rest 
     * @returns {HTMLElement}
     */
    static of(tag, ...rest) {
        return _html(tag, null, ...rest);
    }
};

/**
 * @type {Record<string, (...rest: (Attr | Event | Prop | Element)) => HTMLElement}
 */
export const h = new Proxy({}, {
    get: (_, tag) => (...rest) => _html(tag, null, ...rest),
});

/**
 * @type {Record<string, (...rest: (Attr | Event | Prop | Element)) => HTMLElement}
 */
export const s = new Proxy({}, {
    get: (_, tag) => (...rest) => _html(tag, 'http://www.w3.org/2000/svg', ...rest),
});