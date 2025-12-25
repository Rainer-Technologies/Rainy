/**
 * Rainy Music Player - Importer Module
 * Handles file upload and YouTube import
 */

const Importer = {
    /**
     * Upload audio files
     * @param {FileList} files - Files to upload
     * @param {function} onProgress - Progress callback
     * @param {function} onComplete - Completion callback
     * @param {function} onError - Error callback
     */
    async uploadFiles(files, onProgress, onComplete, onError) {
        const formData = new FormData();
        for (const file of files) {
            formData.append('files', file);
        }

        try {
            onProgress(0, 'Uploading...');

            const response = await fetch('/api/music/upload', {
                method: 'POST',
                body: formData,
                credentials: 'include'
            });

            const result = await response.json();

            if (result.success) {
                onProgress(100, `Uploaded ${result.count} file(s)`);
                onComplete(result);
            } else {
                throw new Error(result.error || 'Upload failed');
            }
        } catch (error) {
            onError(error);
        }
    },

    /**
     * Import from YouTube URL
     * @param {string} url - YouTube URL
     * @param {function} onProgress - Progress callback
     * @param {function} onComplete - Completion callback
     * @param {function} onError - Error callback
     */
    async importFromYouTube(url, onProgress, onComplete, onError) {
        if (!url || (!url.includes('youtube.com') && !url.includes('youtu.be') && !url.includes('music.youtube.com'))) {
            onError(new Error('Please enter a valid YouTube URL'));
            return;
        }

        try {
            onProgress(10, 'Connecting to YouTube...');

            // Simulate progress while waiting
            let currentProgress = 10;
            const progressInterval = setInterval(() => {
                if (currentProgress < 80) {
                    currentProgress += 5;
                    onProgress(currentProgress, 'Downloading and processing...');
                }
            }, 500);

            const response = await fetch('/api/music/import/youtube', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ url })
            });

            clearInterval(progressInterval);
            const result = await response.json();

            if (result.success) {
                onProgress(100, `Imported "${result.song.title}" successfully!`);
                onComplete(result);
            } else {
                throw new Error(result.error || 'Import failed');
            }
        } catch (error) {
            onError(error);
        }
    },

    /**
     * Open add music modal
     */
    openModal() {
        document.getElementById('add-music-modal')?.classList.remove('hidden');
        this.switchTab('upload');
        this.resetInputs();
    },

    /**
     * Close add music modal
     */
    closeModal() {
        document.getElementById('add-music-modal')?.classList.add('hidden');
    },

    /**
     * Switch between upload and youtube tabs
     * @param {string} tabName - 'upload' or 'youtube'
     */
    switchTab(tabName) {
        document.querySelectorAll('.add-music-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.tab === tabName);
        });

        document.querySelectorAll('.add-music-tab-content').forEach(content => {
            content.classList.remove('active');
        });
        document.getElementById(`${tabName}-tab`)?.classList.add('active');
    },

    /**
     * Reset all inputs
     */
    resetInputs() {
        document.getElementById('youtube-url-input').value = '';
        document.getElementById('file-upload-input').value = '';
        document.getElementById('upload-progress')?.classList.add('hidden');
        document.getElementById('youtube-status')?.classList.add('hidden');
        document.getElementById('upload-dropzone')?.classList.remove('hidden');
    }
};

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Importer;
}
