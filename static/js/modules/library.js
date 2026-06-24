/**
 * Rainy Music Player - Library Module
 * Handles library rendering and song display
 */

export const Library = {
    /**
     * Render library sections (horizontal and grid)
     * @param {HTMLElement} container - Container element
     * @param {array} sections - Array of section objects
     * @param {array} songs - All songs for index lookup
     * @param {function} escapeHtml - HTML escape function
     * @param {function} formatDuration - Duration format function
     * @param {string} currentSort - Current sort value
     * @param {object} coverOverrides - Optional cover overrides
     * @param {object} coverVersions - Optional cover versions
     */
    renderSections(container, sections, songs, escapeHtml, formatDuration, currentSort, coverOverrides = {}, coverVersions = {}) {
        container.innerHTML = '';

        let html = '';
        for (const section of sections) {
            if (section.type === 'horizontal') {
                html += this.renderHorizontalSection(section, songs, escapeHtml, coverOverrides, coverVersions);
            } else {
                html += this.renderGridSection(section, escapeHtml, formatDuration, currentSort, coverOverrides, coverVersions);
            }
        }

        container.innerHTML = html;
    },

    /**
     * Render horizontal scrolling section
     */
    renderHorizontalSection(section, allSongs, escapeHtml, coverOverrides = {}, coverVersions = {}) {
        const songsHtml = section.songs.map((song) => {
            const overridePath = coverOverrides[song.id] || song.cover_path;
            const bust = coverVersions[song.id] ? `?t=${coverVersions[song.id]}` : '';
            const coverHtml = overridePath
                ? `<img src="/api/music/cover/${encodeURIComponent(overridePath)}${bust}" alt="Cover" loading="lazy" onerror="window.Utils.handleCoverError(this)">`
                : `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>`;

            const globalIndex = allSongs.findIndex(s => s.id === song.id);

            const artistNames = (song.artist || 'Unknown Artist').split(',').map(s => s.trim()).filter(Boolean);
            const artistLinksHtml = artistNames.map(name => `<span class="song-artist-link" data-artist="${escapeHtml(name)}">${escapeHtml(name)}</span>`).join(', ');

            return `
            <div class="song-card-horizontal fade-in" data-index="${globalIndex}" data-id="${song.id}">
                <button class="song-menu-btn" data-song-id="${song.id}" data-song-title="${escapeHtml(song.title)}" data-song-artist="${escapeHtml(song.artist)}">
                    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                        <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/>
                    </svg>
                </button>
                <div class="song-artwork">
                    ${coverHtml}
                    <div class="song-artwork-overlay">
                        <div class="play-btn-overlay">
                            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                                <path d="M8 5v14l11-7z"/>
                            </svg>
                        </div>
                    </div>
                </div>
                <div class="song-info">
                    <div class="song-title">${escapeHtml(song.title)}</div>
                    <div class="song-artist">${artistLinksHtml}</div>
                </div>
            </div>
            `;}).join('');

        return `
        <div class="library-section" data-section-id="${section.id}">
            <h2 class="section-heading">${section.title}</h2>
            <div class="horizontal-scroll-container">
                <div class="horizontal-scroll-content">
                    ${songsHtml}
                </div>
            </div>
        </div>
        `;
    },

    /**
     * Render grid section
     */
    renderGridSection(section, escapeHtml, formatDuration, currentSort, coverOverrides = {}, coverVersions = {}) {
            const songsHtml = section.songs.map((song, index) => {
            const overridePath = coverOverrides[song.id] || song.cover_path;
            const bust = coverVersions[song.id] ? `?t=${coverVersions[song.id]}` : '';
            const coverHtml = overridePath
                ? `<img src="/api/music/cover/${encodeURIComponent(overridePath)}${bust}" alt="Cover" loading="lazy" onerror="window.Utils.handleCoverError(this)">`
                : `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>`;

            const artistNames = (song.artist || 'Unknown Artist').split(',').map(s => s.trim()).filter(Boolean);
            const artistLinksHtml = artistNames.map(name => `<span class="song-artist-link" data-artist="${escapeHtml(name)}">${escapeHtml(name)}</span>`).join(', ');

            return `
            <div class="song-card fade-in" data-index="${index}" data-id="${song.id}">
                <button class="song-menu-btn" data-song-id="${song.id}" data-song-title="${escapeHtml(song.title)}" data-song-artist="${escapeHtml(song.artist)}">
                    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                        <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/>
                    </svg>
                </button>
                <div class="song-artwork">
                    ${coverHtml}
                    <div class="song-artwork-overlay">
                        <div class="play-btn-overlay">
                            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                                <path d="M8 5v14l11-7z"/>
                            </svg>
                        </div>
                    </div>
                </div>
                <div class="song-info">
                    <div class="song-title">${escapeHtml(song.title)}</div>
                    <div class="song-artist">${artistLinksHtml}</div>
                    <div class="song-duration">${formatDuration(song.duration)}</div>
                </div>
            </div>
            `;}).join('');

        const sortFilterHtml = section.id === 'all-songs' ? `
            <div class="section-header-row">
                <h2 class="section-heading">${section.title}</h2>
                <div class="section-sort">
                    <svg viewBox="0 0 24 24" fill="currentColor">
                        <path d="M3 18h6v-2H3v2zM3 6v2h18V6H3zm0 7h12v-2H3v2z"/>
                    </svg>
                    <select id="sort-select" class="sort-select">
                        <option value="default" ${currentSort === 'default' ? 'selected' : ''}>Default Order</option>
                        <option value="title-asc" ${currentSort === 'title-asc' ? 'selected' : ''}>Title (A-Z)</option>
                        <option value="title-desc" ${currentSort === 'title-desc' ? 'selected' : ''}>Title (Z-A)</option>
                    </select>
                </div>
            </div>
        ` : `<h2 class="section-heading">${section.title}</h2>`;

        return `
        <div class="library-section" data-section-id="${section.id}">
            ${sortFilterHtml}
            <div class="songs-grid-section">
                ${songsHtml}
            </div>
        </div>
        `;
    },

    /**
     * Render list view
     * @param {HTMLElement} container - List container
     * @param {array} songs - Songs to render
     * @param {function} escapeHtml - HTML escape function
     * @param {function} formatDuration - Duration format function
     * @param {object} coverOverrides - Optional cover overrides
     * @param {object} coverVersions - Optional cover versions
     */
    renderListView(container, songs, escapeHtml, formatDuration, coverOverrides = {}, coverVersions = {}) {
        const html = songs.map((song, index) => {
            const overridePath = coverOverrides[song.id] || song.cover_path;
            const bust = coverVersions[song.id] ? `?t=${coverVersions[song.id]}` : '';
            const coverHtml = overridePath
                ? `<img src="/api/music/cover/${encodeURIComponent(overridePath)}${bust}" alt="Cover" loading="lazy" onerror="window.Utils.handleCoverError(this)">`
                : `<svg viewBox="0 0 24 24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>`;

            const artistNames = (song.artist || 'Unknown Artist').split(',').map(s => s.trim()).filter(Boolean);
            const artistLinksHtml = artistNames.map(name => `<span class="song-artist-link" data-artist="${escapeHtml(name)}">${escapeHtml(name)}</span>`).join(', ');

            return `
            <div class="song-row fade-in" data-index="${index}" data-id="${song.id}">
                <span class="song-row-number">${index + 1}</span>
                <div class="song-row-main">
                    <div class="song-row-artwork">${coverHtml}</div>
                    <div class="song-row-info">
                        <div class="song-row-title">${escapeHtml(song.title)}</div>
                        <div class="song-row-artist">${artistLinksHtml}</div>
                    </div>
                </div>
                <span class="song-row-album">${escapeHtml(song.album || '')}</span>
                <span class="song-row-duration">${formatDuration(song.duration)}</span>
                <button class="song-menu-btn" data-song-id="${song.id}" data-song-title="${escapeHtml(song.title)}" data-song-artist="${escapeHtml(song.artist)}">
                    <svg viewBox="0 0 24 24"><path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>
                </button>
            </div>
            `;
        }).join('');

        container.innerHTML = html;
    }
};
