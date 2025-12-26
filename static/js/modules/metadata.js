/**
 * Rainy Music Player - Metadata Module
 * Handles metadata search and application
 */

export const Metadata = {
    /**
     * Search for metadata
     * @param {function} api - API function
     * @param {string} query - Search query
     * @returns {Promise<array>} - Search results
     */
    async search(api, query) {
        const response = await api('/api/music/metadata/search', 'POST', { query });
        if (response.success && response.results) {
            return response.results;
        }
        return [];
    },

    /**
     * Apply metadata to a song
     * @param {function} api - API function
     * @param {number} songId - Song ID
     * @param {object} metadata - Metadata to apply
     * @returns {Promise<object>} - Response
     */
    async apply(api, songId, metadata) {
        return await api(`/api/music/metadata/apply/${songId}`, 'POST', {
            title: metadata.title,
            artist: metadata.artist,
            album: metadata.album,
            year: metadata.year,
            cover_url: metadata.cover_url
        });
    },

    /**
     * Render metadata search results
     * @param {HTMLElement} container - Results container
     * @param {array} results - Search results
     * @param {function} escapeHtml - HTML escape function
     * @param {function} formatDuration - Duration format function
     * @param {function} onApply - Callback when apply button clicked
     */
    renderResults(container, results, escapeHtml, formatDuration, onApply) {
        container.innerHTML = results.map(result => `
            <div class="metadata-result-card" data-result='${JSON.stringify(result).replace(/'/g, "&#39;")}'>
                <div class="metadata-result-cover">
                    ${result.cover_url
                ? `<img src="${result.cover_url}" alt="Cover" loading="lazy">`
                : `<svg viewBox="0 0 24 24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>`
            }
                </div>
                <div class="metadata-result-info">
                    <div class="metadata-result-title">${escapeHtml(result.title)}</div>
                    <div class="metadata-result-artist">${escapeHtml(result.artist)}</div>
                    <div class="metadata-result-album">${escapeHtml(result.album)}</div>
                    <div class="metadata-result-duration">${result.duration_text || formatDuration(result.duration)}</div>
                </div>
                <div class="metadata-result-action">
                    <button class="btn btn-primary apply-metadata-btn">Apply</button>
                </div>
            </div>
        `).join('');

        // Add click listeners
        container.querySelectorAll('.apply-metadata-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const card = btn.closest('.metadata-result-card');
                const result = JSON.parse(card.dataset.result);
                onApply(result);
            });
        });
    },

    /**
     * Open metadata modal
     * @param {object} song - Selected song
     */
    openModal(song) {
        const modal = document.getElementById('metadata-modal');
        const songName = document.getElementById('metadata-song-name');
        const searchInput = document.getElementById('metadata-search-input');
        const resultsContainer = document.getElementById('metadata-results');
        const noResults = document.getElementById('metadata-no-results');
        const loading = document.getElementById('metadata-loading');

        if (resultsContainer) resultsContainer.innerHTML = '';
        if (noResults) noResults.classList.add('hidden');
        if (loading) loading.classList.add('hidden');

        if (songName) songName.textContent = `${song.title} - ${song.artist}`;
        if (searchInput) searchInput.value = `${song.title} ${song.artist}`;

        modal?.classList.remove('hidden');
    },

    /**
     * Close metadata modal
     */
    closeModal() {
        const modal = document.getElementById('metadata-modal');
        modal?.classList.add('hidden');
    }
};
