/**
 * Pieces the settings of installable packages share (light show environments
 * in Settings → Light Show, interface themes in Settings → Appearance).
 */
import { a, h, s } from "./index.js";

/** What stands in for a package's picture when it has none. */
export const plateIcon = () => s.svg(a.viewBox('0 0 24 24'), a.fill('none'), a.stroke('currentColor'), a['stroke-width']('1.5'),
    a['stroke-linejoin']('round'), a['aria-hidden']('true'),
    s.path(a.d('M12 2.5 3.5 7v10l8.5 4.5 8.5-4.5V7z')),
    s.path(a.d('M3.5 7 12 11.5 20.5 7M12 11.5v10')));

export const formatSize = (bytes) => (bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/**
 * A package's picture: the preview it brought, or `fallback()` (a plain plate
 * by default) when it has none or it does not load.
 */
export function packagePicture(preview, fallback = plateIcon) {
    if (!preview) return h.div(a.class('settings-env-picture', 'is-blank'), fallback());
    const img = h.img(a.src(preview), a.alt(''), a.loading('lazy'), a.decoding('async'));
    const picture = h.div(a.class('settings-env-picture'), img);
    img.addEventListener('error', () => {
        img.remove();
        picture.classList.add('is-blank');
        picture.append(fallback());
    }, { once: true });
    return picture;
}
