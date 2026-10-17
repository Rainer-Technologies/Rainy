/**
 * Change which icon an <svg data-icon> shows. The svg keeps its name in
 * data-icon, so a UI theme that replaces icons (js/theme/icons.js) follows
 * the change: never rewrite an icon's path or markup by hand.
 */

/**
 * @param {SVGElement|null} svg   an icon (<svg data-icon="…">)
 * @param {string} name           the name themes know the new icon by (docs/THEMES.md#icons)
 * @param {string} path           Rainy's own drawing of it (a 24×24 path)
 */
export function setIcon(svg, name, path) {
    if (!svg) return;
    const drawing = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    drawing.setAttribute('d', path);
    svg.replaceChildren(drawing);
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('data-icon', name);
}
