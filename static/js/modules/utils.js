/**
 * Rainy Music Player - Utilities Module
 * Common helper functions used across the application
 */

const Utils = {
    /**
     * Format duration in seconds to mm:ss
     * @param {number} seconds - Duration in seconds
     * @returns {string} - Formatted time string
     */
    formatDuration(seconds) {
        if (!seconds) return '0:00';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    },

    /**
     * Escape HTML to prevent XSS
     * @param {string} text - Text to escape
     * @returns {string} - Escaped HTML string
     */
    escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    },

    /**
     * Show a toast notification
     * @param {string} message - Toast message
     * @param {string} type - 'success' or 'error'
     * @param {number} duration - Duration in ms
     */
    showToast(message, type = 'success', duration = 3000) {
        const container = document.getElementById('toast-container');
        if (!container) return;

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;

        const icon = type === 'success'
            ? '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>'
            : '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>';

        toast.innerHTML = `${icon}<span class="toast-message">${this.escapeHtml(message)}</span>`;
        container.appendChild(toast);

        // Auto-dismiss
        setTimeout(() => {
            toast.classList.add('hiding');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    },

    /**
     * Handle cover image loading errors with retry and fallback
     * @param {HTMLImageElement} img - The image element that failed to load
     */
    handleCoverError(img) {
        if (!img) return;

        const createFallback = () => {
            const div = document.createElement('div');
            div.innerHTML = `
                <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" class="cover-placeholder">
                    <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
                </svg>
            `;
            return div.querySelector('svg');
        };

        const retries = parseInt(img.dataset.retries || '0');

        if (retries < 3) {
            img.dataset.retries = retries + 1;
            img.style.display = 'none';

            let placeholder = null;
            if (img.nextElementSibling && img.nextElementSibling.classList.contains('cover-placeholder')) {
                placeholder = img.nextElementSibling;
            } else {
                placeholder = createFallback();
                if (placeholder && img.parentNode) {
                    img.parentNode.insertBefore(placeholder, img.nextSibling);
                }
            }

            img.onload = () => {
                img.style.display = '';
                if (placeholder) placeholder.remove();
                img.onload = null;
            };

            setTimeout(() => {
                const src = img.src.split('?')[0];
                img.src = `${src}?retry=${Date.now()}`;
            }, 1000 * (retries + 1));
            return;
        }

        // Final failure: Replace with SVG permanently
        if (img.parentNode) {
            const svgElement = createFallback();
            if (svgElement) {
                if (img.nextElementSibling && img.nextElementSibling.classList.contains('cover-placeholder')) {
                    img.nextElementSibling.remove();
                }
                img.parentNode.replaceChild(svgElement, img);
            }
        }
    }
};

// Make available globally for onerror handlers
window.Utils = Utils;

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Utils;
}
