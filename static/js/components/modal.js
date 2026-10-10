import { I } from "./icon.js";
import { a, Component, h, on } from "./index.js";

export class Modal extends Component {
    static componentName = 'rainy-modal';

    created() {
        this.set('hidden', true, { silent: true });
        this.watch('hidden', (_path, _oldValue, newValue) => {
            if(newValue === true) this.root.classList.add('hidden');
            else this.root.classList.remove('hidden');
        });
    }

    show() {
        this.set('hidden', false);
    }

    hide() {
        if(this.get('hidden')) return;
        this.set('hidden', true);
        // Lets the owner stop work that only matters while the modal is open
        // (pass p.onHide), whichever way it was closed.
        const onHide = this.get('on-hide');
        if(typeof onHide === 'function') onHide.call(this);
    }

    hasActions() {
        return this.querySelectorAll('[slot="action"]').length > 0;
    }

    render() {
        return h.div(a.class('modal-overlay', (this.get('hidden') ? 'hidden' : '')),
            h.div(a.class('modal-content'),
                h.div(a.class('modal-header'),
                    h.div(a.class('modal-header-info'),
                        h.div(a.class('modal-icon'),
                            h.slot(a.name('header-icon'))
                        ),
                        h.div(a.class('modal-header-title'),
                            h.slot(a.name('header-title')),
                            h.p(a.class('modal-subtitle'),
                                h.slot(a.name('header-subtitle'))
                            )
                        )
                    ),
                    h.button(a.class('modal-close'), on.click(() => this.hide()),
                        I.Times()
                    )
                ),
                h.div(a.class('modal-body'),
                    h.slot(a.name('body')),
                    this.hasActions()
                        ? h.div(a.class('modal-actions'),
                            h.slot(a.name('action'))
                        )
                        : null
                )
            )
        );
    }
};

customElements.define(Modal.componentName, Modal);