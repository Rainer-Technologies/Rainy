/**
 * A UI theme's icons (docs/THEMES.md#icons).
 *
 * Every icon Rainy draws is an <svg data-icon="name">. A theme may bring its
 * own drawing for any name in the contract; this module puts them in place of
 * Rainy's, in what is on the page now and in whatever the app draws later (a
 * MutationObserver), and puts Rainy's back when the theme comes off. An icon
 * the theme does not bring stays Rainy's.
 *
 * A theme's SVG files are read as data: only shapes and their paint are kept
 * (no scripts, links, images, styles, text or foreign content), whatever the
 * file holds. The server refuses files with any of that already.
 */
const SVG_NS = 'http://www.w3.org/2000/svg';
const TAGS = new Set(['svg', 'g', 'path', 'circle', 'rect', 'ellipse', 'line', 'polyline', 'polygon']);
const ATTRS = new Set([
    'd', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'width', 'height', 'points',
    'fill', 'fill-rule', 'fill-opacity', 'clip-rule', 'opacity', 'transform',
    'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit',
    'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity',
]);
const SAFE_VALUE = /^[^<>"'`\\]*$/;
const LOAD_TIMEOUT = 5000;

/** A shape's attribute value is kept only if it is plain geometry or paint. */
function safeValue(name, value) {
    if (!SAFE_VALUE.test(value) || /url\s*\(|javascript:|expression/i.test(value)) return false;
    return name !== 'width' && name !== 'height' ? true : /^[\d.]+(px|%)?$/.test(value);
}

function copyShape(node) {
    const tag = node.localName;
    if (node.nodeType !== 1 || !TAGS.has(tag) || tag === 'svg') return null;
    const el = document.createElementNS(SVG_NS, tag);
    for (const { name, value } of [...node.attributes]) {
        if (ATTRS.has(name) && safeValue(name, value)) el.setAttribute(name, value);
    }
    for (const child of node.childNodes) {
        const copy = copyShape(child);
        if (copy) el.appendChild(copy);
    }
    return el;
}

/**
 * The shapes of an SVG file, safe to put in the page: { viewBox, shapes } or null.
 * @param {string} text
 */
export function sanitizeSvg(text) {
    if (typeof text !== 'string' || text.length > 64 * 1024) return null;
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const root = doc.documentElement;
    if (!root || root.localName !== 'svg' || doc.querySelector('parsererror')) return null;
    const viewBox = root.getAttribute('viewBox') || '0 0 24 24';
    if (!/^[-\d.\s,]+$/.test(viewBox)) return null;
    const shapes = [...root.childNodes].map(copyShape).filter(Boolean);
    return shapes.length ? { viewBox, shapes } : null;
}

// ------------------------------------------------------------ the page

let current = new Map();        // name → { viewBox, shapes }
const applied = new WeakMap();  // svg → { name, nodes, original: { viewBox, children } }
let observer = null;

function themeIcon(svg) {
    const icon = current.get(svg.getAttribute('data-icon'));
    const record = applied.get(svg);
    // Still showing the theme's drawing? (The app may have switched to another icon since, with Rainy's.)
    const themed = !!record && svg.firstChild === record.nodes[0];
    if (themed && record.icon === icon) return;
    if (!icon) {
        if (themed) restoreIcon(svg);
        return;
    }
    const original = themed ? record.original : { viewBox: svg.getAttribute('viewBox'), children: [...svg.childNodes] };
    const nodes = icon.shapes.map((shape) => shape.cloneNode(true));
    svg.replaceChildren(...nodes);
    svg.setAttribute('viewBox', icon.viewBox);
    applied.set(svg, { icon, nodes, original });
}

function restoreIcon(svg) {
    const record = applied.get(svg);
    if (!record || svg.firstChild !== record.nodes[0]) return;
    svg.replaceChildren(...record.original.children);
    if (record.original.viewBox) svg.setAttribute('viewBox', record.original.viewBox);
    else svg.removeAttribute('viewBox');
    applied.delete(svg);
}

function iconsIn(node) {
    if (node.nodeType !== 1) return [];
    const found = node.matches('svg[data-icon]') ? [node] : [];
    return found.concat([...node.querySelectorAll('svg[data-icon]')]);
}

function watch() {
    if (observer) return;
    // Mutation records already come in batches, once per task: theme what they bring right away.
    observer = new MutationObserver((records) => {
        const seen = new Set();
        for (const r of records) {
            const svgs = r.type === 'attributes' ? [r.target] : [...r.addedNodes].flatMap(iconsIn);
            for (const svg of svgs) {
                if (seen.has(svg) || !svg.isConnected) continue;
                seen.add(svg);
                themeIcon(svg);
            }
        }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-icon'] });
}

/**
 * Fetch and check a theme's icons: { name: url } → Map(name → { viewBox, shapes }).
 * An icon that does not load or is not a clean SVG is left out (Rainy's stays).
 */
export async function loadIcons(urls) {
    const entries = Object.entries(urls || {});
    const loaded = await Promise.all(entries.map(async ([name, url]) => {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), LOAD_TIMEOUT);
            const res = await fetch(url, { signal: controller.signal, credentials: 'same-origin' });
            clearTimeout(timer);
            if (!res.ok) return null;
            const icon = sanitizeSvg(await res.text());
            return icon ? [name, icon] : null;
        } catch (e) {
            return null;
        }
    }));
    return new Map(loaded.filter(Boolean));
}

/** Show these icons (from loadIcons) in place of Rainy's, now and from now on. An empty map puts Rainy's back. */
export function useIcons(icons) {
    current = icons instanceof Map ? icons : new Map();
    for (const svg of document.querySelectorAll('svg[data-icon]')) {
        if (current.size) themeIcon(svg);
        else restoreIcon(svg);
    }
    if (current.size) watch();
}
