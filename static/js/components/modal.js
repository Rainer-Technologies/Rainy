import { Component, html } from "./index.js";

export class Modal extends Component {
    created() {
        this.shadowRoot.append(html(this)`<link rel='stylesheet' href='/css/components/modals.css'>`);
        this.shadowRoot.append(html(this)`<link rel='stylesheet' href='/css/base.css'>`);

        this.set('hidden', true);
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
        const hiddenAttr = (this.get('hidden') ? 'hidden' : '')
        return html(this)`<div class='modal-overlay ${hiddenAttr}'>
            <div class='modal-content'>
                <div class='modal-header'>
                    <slot name='header'></slot>
                    <button class='modal-close' :click=${this.hide}>
                        <svg viewBox='0 0 24 24' fill='currentColor'>
                            <path d='M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z' />
                        </svg>
                    </button>
                </div>
                <div class='modal-body'>
                    <slot name='body'></slot>
                    ${this.hasActions()
                        ? html(this)`<div class='modal-actions'>
                            <slot name='action'></slot>
                        </div>`
                        : ''}
                </div>
            </div>
        </div>`;
    }
};

customElements.define('rainy-modal', Modal);