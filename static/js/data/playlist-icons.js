/**
 * Rainy Music Player - Playlist Icons Data
 * Collection of SVG icons for playlists
 */

export const PLAYLIST_ICONS = {
    'music-note': {
        name: 'Music Note',
        path: 'M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z'
    },
    'headphones': {
        name: 'Headphones',
        path: 'M12 1c-4.97 0-9 4.03-9 9v7c0 1.66 1.34 3 3 3h3v-8H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-4v8h3c1.66 0 3-1.34 3-3v-7c0-4.97-4.03-9-9-9z'
    },
    'heart': {
        name: 'Heart',
        path: 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z'
    },
    'star': {
        name: 'Star',
        path: 'M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z'
    },
    'fire': {
        name: 'Fire',
        path: 'M13.5.67s.74 2.65.74 4.8c0 2.06-1.35 3.73-3.41 3.73-2.07 0-3.63-1.67-3.63-3.73l.03-.36C5.21 7.51 4 10.62 4 14c0 4.42 3.58 8 8 8s8-3.58 8-8C20 8.61 17.41 3.8 13.5.67zM11.71 19c-1.78 0-3.22-1.4-3.22-3.14 0-1.62 1.05-2.76 2.81-3.12 1.77-.36 3.6-1.21 4.62-2.58.39 1.29.59 2.65.59 4.04 0 2.65-2.15 4.8-4.8 4.8z'
    },
    'bolt': {
        name: 'Lightning',
        path: 'M11 21h-1l1-7H7.5c-.58 0-.57-.32-.38-.66.19-.34.05-.08.07-.12C8.48 10.94 10.42 7.54 13 3h1l-1 7h3.5c.49 0 .56.33.47.51l-.07.15C12.96 17.55 11 21 11 21z'
    },
    'moon': {
        name: 'Moon',
        path: 'M9 2c-1.05 0-2.05.16-3 .46 4.06 1.27 7 5.06 7 9.54 0 4.48-2.94 8.27-7 9.54.95.3 1.95.46 3 .46 5.52 0 10-4.48 10-10S14.52 2 9 2z'
    },
    'sun': {
        name: 'Sun',
        path: 'M6.76 4.84l-1.8-1.79-1.41 1.41 1.79 1.79 1.42-1.41zM4 10.5H1v2h3v-2zm9-9.95h-2V3.5h2V.55zm7.45 3.91l-1.41-1.41-1.79 1.79 1.41 1.41 1.79-1.79zm-3.21 13.7l1.79 1.8 1.41-1.41-1.8-1.79-1.4 1.4zM20 10.5v2h3v-2h-3zm-8-5c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6zm-1 16.95h2V19.5h-2v2.95zm-7.45-3.91l1.41 1.41 1.79-1.8-1.41-1.41-1.79 1.8z'
    },
    'disc': {
        name: 'Vinyl',
        path: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z'
    },
    'guitar': {
        name: 'Guitar',
        path: 'M19.59 3H22v2h-1.59l-4.83 4.83c.79 1.31.74 3.01-.25 4.25-.86 1.07-2.16 1.59-3.46 1.49l-1.54 1.54c.61 2.17-.46 4.53-2.59 5.44-2.66 1.14-5.74-.2-6.88-3-.68-1.67-.52-3.49.38-5l1.54-1.54c-.1-1.3.42-2.6 1.49-3.46 1.24-.99 2.94-1.04 4.25-.25L13.94 5H16l3.59-2zm-5.03 7.03L12.44 8l-1.06 1.06 2.12 2.12 1.06-1.15z'
    }
};

// Default colors for playlist icons
export const PLAYLIST_ICON_COLORS = [
    '#888888', // Grey (default)
    '#fa586a', // Red
    '#007aff', // Blue
    '#34c759', // Green
    '#af52de', // Purple
    '#ff9500', // Orange
    '#ff2d55', // Pink
    '#ffcc00'  // Yellow
];

/**
 * Get SVG element for a playlist icon
 * @param {string} iconId - Icon identifier
 * @param {string} color - Icon color (optional)
 * @returns {string} SVG HTML string
 */
export function getPlaylistIconSvg(iconId, color = 'currentColor') {
    const icon = PLAYLIST_ICONS[iconId] || PLAYLIST_ICONS['music-note'];
    return `<svg viewBox="0 0 24 24" fill="${color}"><path d="${icon.path}"/></svg>`;
}
