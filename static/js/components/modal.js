import { a, Component, h, on, s } from "./index.js";

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
        this.set('hidden', true);
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
                        s.svg(a.viewBox('0 0 24 24'), a.fill('currentColor'),
                            s.path(a.d('M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z'))
                        )
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