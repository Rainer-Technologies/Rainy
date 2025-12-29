import { a, Component, h, on, s } from "./index.js";

/**
 * @typedef {Object} Position
 * @property {number} x
 * @property {number} y
 */

export class ContextSubMenu extends Component {
    static componentName = 'rainy-context-sub-menu';

    created() {
        this.set('hidden', true, { silent: true });
        this.set('position', 'right', { silent: true });

        this.watch('hidden', (_path, _oldValue, newValue) => {
            if(newValue === true) this.root.classList.add('hidden');
            else this.root.classList.remove('hidden');
        });

        this.watch('position', (_path, _oldValue, newValue) => {
            if(newValue === 'left') this.root.classList.add('show-left');
            else this.root.classList.remove('show-left');
        });
    }

    show() {
        this.set('hidden', false);
        const onOpen = this.get('on-open');
        if(typeof onOpen === 'function') onOpen.call(this);
    }

    hide() {
        this.set('hidden', true);
    }

    render() {
        const hiddenCls = (this.get('hidden') ? 'hidden' : '');
        return h.div(a.class('context-submenu', hiddenCls),
            h.slot()
        );
    }
};

export class ContextMenuItem extends Component {
    static componentName = 'rainy-context-menu-item';

    /** @returns {ContextSubMenu?} */
    get submenu() {
        return this.root.querySelector('rainy-context-sub-menu');
    }

    showSubMenu() {
        if(!this.hasAttribute('has-submenu')) return;
        this.submenu.show();

        const rect = this.root.getBoundingClientRect();
        const submenuWidth = this.submenu.root.offsetWidth;
        const viewportWidth = window.innerWidth;

        if(rect.right + submenuWidth > viewportWidth) {
            this.submenu.set('position', 'left');
        } else {
            this.submenu.set('position', 'right');
        }
    }

    hideSubMenu() {
        if(!this.hasAttribute('has-submenu')) return;
        let timeoutId = null;

        const listener = () => {
            if(timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }

            this.submenu.removeEventListener('mouseenter', listener);
        };

        timeoutId = setTimeout(() => {
            this.submenu.hide();
            this.submenu.removeEventListener('mouseenter', listener);
        }, 150);
        this.submenu.addEventListener('mouseenter', listener);
    }

    render() {
        const hasSubMenuCls = (this.hasAttribute('has-submenu') ? 'has-submenu' : '');
        const isDangerousCls = (this.hasAttribute('danger') ? 'danger' : '');
        return h.div(a.class('context-menu-item', hasSubMenuCls, isDangerousCls), on.mouseenter(() => this.showSubMenu()), on.mouseleave(() => this.hideSubMenu()),
            h.slot(),
            this.hasAttribute('has-submenu')
                ? s.svg(a.class('submenu-arrow'), a.viewBox('0 0 24 24'), a.fill('currentColor'),
                    s.path(a.d('M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z'))
                )
                : null
        );
    }
};

export class ContextMenu extends Component {
    static componentName = 'rainy-context-menu';

    created() {
        this.set('hidden', true);
        this.watch('hidden', (_path, _oldValue, newValue) => {
            if(newValue === true) this.root.classList.add('hidden');
            else this.root.classList.remove('hidden');
        });
    }

    _calculatePosition(desiredPos, viewportSize, elementSize) {
        const maxPos = viewportSize - elementSize;
        return Math.min(Math.max(desiredPos, 0), maxPos);
    }

    /**
     * @param {Position} pos 
     */
    setPosition(pos) {
        const rect = this.root.getBoundingClientRect();

        this.root.style.top = `${
            this._calculatePosition(pos.y, window.innerHeight, rect.height)}px`;
        this.root.style.left = `${
            this._calculatePosition(pos.x, window.innerWidth, rect.width)}px`;
    }

    /**
     * @param {Position?} pos 
     */
    show(pos) {
        this.set('hidden', false);
        if(pos) this.setPosition(pos);
    }

    hide() {
        this.set('hidden', true);
    }

    render() {
        const hiddenCls = (this.get('hidden') ? 'hidden' : '');
        return h.div(a.class('context-menu', hiddenCls),
            h.slot()
        );
    }
};

customElements.define(ContextSubMenu.componentName, ContextSubMenu);
customElements.define(ContextMenuItem.componentName, ContextMenuItem);
customElements.define(ContextMenu.componentName, ContextMenu);