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
     */
    watch(path, callback, deep = false) {
        const unsub = this._ctx.listen(path, callback, deep);
        this._unsubscribers.push(unsub);
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
                if (node.nodeType !== Node.ELEMENT_NODE && name) continue;
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

        this.root = root;
        this.append(this.root);
    }
};

const PLACEHOLDER_PREFIX = '#__rainy__';

/** 
 * @param {HTMLElement} el
 * @param {Array<any>} values
 * @param {any} userdata
 */
function _resolve(el, values, userdata) {
    for(const child of el.childNodes) {
        if(child.nodeType === Node.ELEMENT_NODE) {
            for(const attrName of child.getAttributeNames()) {
                const attr = child.getAttributeNode(attrName);
                
                if(attrName.startsWith(':')) {
                    const match = attr.value.match(/#__rainy__(\d+)/g);
                    if(!match) continue;

                    const idx = match[0].slice(PLACEHOLDER_PREFIX.length);
                    const eventName = attrName.slice(1);
                    const handler = values[idx];

                    child.removeAttributeNode(attr);
                    child.addEventListener(eventName, (ev) => handler.call(userdata, ev));
                } else if(attrName.startsWith('&')) {
                    const match = attr.value.match(/#__rainy__(\d+)/g);
                    let value = attr.value; if(match) {
                        const idx = match[0].slice(PLACEHOLDER_PREFIX.length);
                        value = values[idx];
                    }

                    child.removeAttributeNode(attr);
                    child.set(attrName.slice(1), value);
                } else {
                    attr.value = attr.value.replace(/#__rainy__(\d+)/, (_, idx) =>
                        (values[parseInt(idx)].toString()));
                }
            }
        
            _resolve(child, values, userdata);
        } else if(child.nodeType === Node.TEXT_NODE) {
            child.textContent = child.textContent.replace(/#__rainy__(\d+)/, (_, idx) => {
                const value = values[parseInt(idx)];
                if(Array.isArray(value)) {
                    for(const item of value) {
                        if(item instanceof HTMLElement || item instanceof SVGElement) {
                            child.parentElement.insertBefore(item, child.nextSibling);
                        }
                    }

                    return '';
                } else if(value instanceof HTMLElement || value instanceof SVGElement) {
                    child.parentElement.insertBefore(value, child.nextSibling);
                    return '';
                }

                return values[parseInt(idx)].toString();
            });
        }
    }
}

/**
 * @typedef {(strings: TemplateStringsArray, values: ...any) => void} Transform
 */

/**
 * @param {any} userdata 
 * @returns {Transform}
 */
export function html(userdata) {
    return (strings, ...values) => {
        const tmpl = strings.reduce((acc, str, i) => 
            acc + str + (values[i] ? `${PLACEHOLDER_PREFIX}${i}` : ''), '');

        const wrapper = document.createElement('div');
        wrapper.innerHTML = tmpl.trim();

        _resolve(
            wrapper, 
            values, 
            userdata
        );

        return wrapper.firstElementChild;
    }
}