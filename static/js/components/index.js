import { createContext } from '../helper/context.js';

export class Component extends HTMLElement {
    constructor() {
        super();

        /** @type {HTMLElement} */
        this.root = null;

        /** @type {import('../helper/context.js').Context} */
        this._ctx = createContext({});

        /** @type {Array<() => boolean>} */
        this._unsubscribers = [];
        this._mounted = false;

        this.attachShadow({ mode: 'open' });

        if(this.created) this.created();
    }

    get(path) {
        return this._ctx.get(path);
    }

    set(path, value) {
        this._ctx.set(path, value);
    }

    watch(path, callback, deep = false) {
        const unsub = this._ctx.listen(path, callback, deep);
        this._unsubscribers.push(unsub);
    }

    connectedCallback() {
        this._mounted = true;
        this._render();
    }

    disconnectedCallback() {
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
        if(this.render) {
            const node = this.render();
            if(!node) return;

            console.log(node);
            this.root = node;
            this.shadowRoot.append(this.root);
        }
    }
};

const PLACEHOLDER_PREFIX = '#__rainy__';

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

        const template = document.createElement('template');
        template.innerHTML = tmpl.trim();
        const treeWalker = document.createTreeWalker(
            template.content, 
            NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT
        );

        while(treeWalker.nextNode()) {
            const node = treeWalker.currentNode;
            if(node.nodeType === node.ELEMENT_NODE) {
                for(const attrName of node.getAttributeNames()) {
                    const attr = node.getAttributeNode(attrName);
                    
                    if(attrName.startsWith(':')) {
                        const match = attr.value.match(/#__rainy__(\d+)/g);
                        if(!match) continue;

                        const idx = match[0].slice(PLACEHOLDER_PREFIX.length);
                        const eventName = attrName.slice(1);
                        const handler = values[idx];

                        node.removeAttributeNode(attr);
                        node.addEventListener(eventName, (ev) => handler.call(userdata, ev));
                    }

                    attr.value = attr.value.replace(/#__rainy__(\d+)/, (_, idx) =>
                        (values[parseInt(idx)].toString()));
                }
            } else if(node.nodeType === node.TEXT_NODE) {
                node.textContent = node.textContent.replace(/#__rainy__(\d+)/, (_, idx) => {
                    const value = values[parseInt(idx)];
                    if(value instanceof HTMLElement) {
                        node.parentElement.insertBefore(value, node.nextSibling);
                        return '';
                    }

                    return values[parseInt(idx)].toString();
                });
            }
        }

        return template
            .content
            .firstElementChild
            .cloneNode(true);
    }
}