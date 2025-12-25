/**
 * Rainy Music Player - Scan Module
 * Handles library scanning operations
 */

export const Scan = {
    /**
     * Get current scan status
     * @param {function} api - API function
     * @returns {Promise<object>} - Scan status
     */
    async getStatus(api) {
        return await api('/api/music/scan/status');
    },

    /**
     * Run a library scan
     * @param {function} api - API function
     * @param {boolean} fullScan - Whether to run full rescan
     * @returns {Promise<object>} - Scan results
     */
    async run(api, fullScan = false) {
        const endpoint = fullScan ? '/api/music/scan/full' : '/api/music/scan';
        return await api(endpoint, 'POST');
    },

    /**
     * Update scan status display
     * @param {object} status - Status from API
     */
    updateDisplay(status) {
        const libraryCount = document.getElementById('library-count');
        if (libraryCount) {
            libraryCount.textContent = `${status.library_total || 0} songs`;
        }

        const lastScanTime = document.getElementById('last-scan-time');
        if (lastScanTime && status.has_scan && status.scan) {
            if (status.scan.completed_at) {
                const date = new Date(status.scan.completed_at);
                lastScanTime.textContent = date.toLocaleString();
            } else if (status.scan.status === 'running') {
                lastScanTime.textContent = 'In progress...';
            }
        }
    },

    /**
     * Show scan result stats
     * @param {object} stats - Scan statistics
     */
    showResults(stats) {
        const filesFound = document.getElementById('scan-files-found');
        const filesAdded = document.getElementById('scan-files-added');
        const filesUpdated = document.getElementById('scan-files-updated');
        const filesRemoved = document.getElementById('scan-files-removed');

        if (filesFound) filesFound.textContent = stats.files_found || 0;
        if (filesAdded) filesAdded.textContent = stats.files_added || 0;
        if (filesUpdated) filesUpdated.textContent = stats.files_updated || 0;
        if (filesRemoved) filesRemoved.textContent = stats.files_removed || 0;
    }
};
