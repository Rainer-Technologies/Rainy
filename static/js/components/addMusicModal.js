import { Utils } from "../modules/utils.js";
import { useMusicService } from "../services/music.js";
import { Component, html } from "./index.js";

export class AddMusicModal extends Component {
    static componentName = 'rainy-add-music-modal';

    created() {
        this.set('current-method', 'upload');

        this.watch('current-method', (_path, _oldValue, methodName) => {
            const methods = this.root.querySelectorAll('.add-music-method');
            methods.forEach(method => {
                method.classList.toggle('active', method.dataset.method === methodName);
            });

            const contents = this.root.querySelectorAll('.add-music-content');
            contents.forEach(content => content.classList.remove('active'));
            const active = this.root.querySelector(`#${methodName}-content`);
            if (active) active.classList.add('active');
        });
    }

    show() {
        this.root.show();
        this.set('current-method', 'upload');
        const youtubeInput = this.root.querySelector('#youtube-url-input');
        const fileInput = this.root.querySelector('#file-upload-input');
        const uploadProgress = this.root.querySelector('#upload-progress');
        const youtubeStatus = this.root.querySelector('#youtube-status');
        if (youtubeInput) youtubeInput.value = '';
        if (fileInput) fileInput.value = '';
        uploadProgress?.classList.add('hidden');
        youtubeStatus?.classList.add('hidden');
    }

    hide() {
        this.root.hide();
    }

    hasActions() {
        return this.root.hasActions();
    }

    switchMethod(methodName) {
        this.set('current-method', methodName);
    }

    _onDropzoneClick = () => {
        const fileInput = this.root.querySelector('#file-upload-input');
        fileInput?.click();
    };

    _onDragOver = (e) => {
        e.preventDefault();
        const dropzone = this.root.querySelector('#upload-dropzone');
        dropzone?.classList.add('dragover');
    };

    _onDragLeave = () => {
        const dropzone = this.root.querySelector('#upload-dropzone');
        dropzone?.classList.remove('dragover');
    };

    _onDrop = (e) => {
        e.preventDefault();
        const dropzone = this.root.querySelector('#upload-dropzone');
        dropzone?.classList.remove('dragover');
        if (e.dataTransfer.files.length > 0) {
            this.uploadFiles(e.dataTransfer.files);
        }
    };

    _onFileChange = (e) => {
        if (e.target.files.length > 0) {
            this.uploadFiles(e.target.files);
        }
    };

    _onYouTubeKeyPress = (e) => {
        if (e.key === 'Enter') {
            this.importFromYouTube();
        }
    };

    async uploadFiles(files) {
        const dropzone = this.root.querySelector('#upload-dropzone');
        const progress = this.root.querySelector('#upload-progress');
        const progressFill = this.root.querySelector('#upload-progress-fill');
        const statusText = this.root.querySelector('#upload-status');

        dropzone.classList.add('hidden');
        progress.classList.remove('hidden');
        progressFill.style.width = '0%';

        const formData = new FormData();
        for (const file of files) {
            formData.append('files', file);
        }

        try {
            statusText.textContent = `Uploading ${files.length} file(s)...`;

            const response = await fetch('/api/music/upload', {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                throw new Error('Upload failed');
            }

            const result = await response.json();
            progressFill.style.width = '100%';
            statusText.textContent = `Successfully uploaded ${result.uploaded || files.length} file(s)!`;

            setTimeout(() => {
                this.hide();
                window.app?.loadLibrary();
            }, 1500);
        } catch (error) {
            console.error('Upload error:', error);
            statusText.textContent = 'Upload failed. Please try again.';
        } finally {
            setTimeout(() => {
                dropzone.classList.remove('hidden');
                progress.classList.add('hidden');
            }, 2000);
        }
    }

    async importFromYouTube() {
        const urlInput = this.root.querySelector('#youtube-url-input');
        const importBtn = this.root.querySelector('#youtube-import-btn');
        const status = this.root.querySelector('#youtube-status');
        const statusText = this.root.querySelector('#youtube-status-text');
        const progressFill = this.root.querySelector('#youtube-progress-fill');

        const url = urlInput.value.trim();
        if (!url) {
            urlInput.focus();
            return;
        }

        importBtn.disabled = true;
        status.classList.remove('hidden');
        progressFill.style.width = '0%';

        const updateProgress = (percent, message) => {
            progressFill.style.width = `${percent}%`;
            statusText.textContent = message;
        };

        updateProgress(10, 'Connecting to YouTube...');

        let currentProgress = 10;
        const progressInterval = setInterval(() => {
            if (currentProgress < 85) {
                currentProgress += Math.random() * 5;
                const messages = [
                    'Fetching video info...',
                    'Downloading audio...',
                    'Converting to MP3...',
                    'Downloading cover art...'
                ];
                const messageIndex = Math.min(Math.floor(currentProgress / 25), messages.length - 1);
                updateProgress(currentProgress, messages[messageIndex]);
            }
        }, 500);

        const data = await useMusicService().YouTube.import(url);
        clearInterval(progressInterval);

        if (data.error) {
            console.error(data.error);

            importBtn.disabled = false;
            status.classList.add('hidden');
            progressFill.style.width = '0%';

            const errorMessage = data.error.error || data.error.message || 'Failed to import from YouTube. Please check the URL and try again.';
            Utils.showToast(errorMessage, 'error', 5000);

            return;
        }

        const result = data.value;
        if (!result) return console.error('unreachable');

        updateProgress(100, `✓ Imported: ${result.title || 'song'}`);
        setTimeout(() => {
            this.hide();
            window.app?.loadLibrary();
        }, 1500);

        importBtn.disabled = false;
    }

    render() {
        const isUpload = this.get('current-method') === 'upload';
        const uploadActive = isUpload ? 'active' : '';
        const youtubeActive = !isUpload ? 'active' : '';

        return html(this)`<rainy-modal>
            <div slot='header-icon' class="modal-icon">
                <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
                </svg>
            </div>
            <h2 slot='header-title'>Add Music</h2>
            <p slot='header-subtitle' class='modal-subtitle'>Import songs to your library</p>
            <div slot='body' class="add-music-methods">
                <div class='add-music-method ${uploadActive}' :click=${() => this.switchMethod('upload')}>
                    <div class='method-icon'>
                        <svg viewBox='0 0 24 24' fill='currentColor'>
                            <path d='M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z' />
                        </svg>
                    </div>
                    <div class='method-info'>
                        <span class='method-title'>Upload Files</span>
                    </div>
                    <div class='method-check'>
                        <svg viewBox='0 0 24 24' fill='currentColor'>
                            <path d='M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z' />
                        </svg>
                    </div>
                </div>
                <div class='add-music-method ${youtubeActive}' :click=${() => this.switchMethod('youtube')}>
                    <div class='method-icon youtube'>
                        <svg viewBox='0 0 24 24' fill='currentColor'>
                            <path d='M10 15l5.19-3L10 9v6m11.56-7.83c.13.47.22 1.1.28 1.9.07.8.1 1.49.1 2.09L22 12c0 2.19-.16 3.8-.44 4.83-.25.9-.83 1.48-1.73 1.73-.47.13-1.33.22-2.65.28-1.3.07-2.49.1-3.59.1L12 19c-4.19 0-6.8-.16-7.83-.44-.9-.25-1.48-.83-1.73-1.73-.13-.47-.22-1.1-.28-1.9-.07-.8-.1-1.49-.1-2.09L2 12c0-2.19.16-3.8.44-4.83.25-.9.83-1.48 1.73-1.73.47-.13 1.33-.22 2.65-.28 1.3-.07 2.49-.1 3.59-.1L12 5c4.19 0 6.8.16 7.83.44.9.25 1.48.83 1.73 1.73z' />
                        </svg>
                    </div>
                    <div class='method-info'>
                        <span class='method-title'>YouTube Import</span>
                    </div>
                    <div class='method-check'>
                        <svg viewBox='0 0 24 24' fill='currentColor'>
                            <path d='M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z' />
                        </svg>
                    </div>
                </div>
            </div>
            <div slot='body' class='add-music-content ${uploadActive}' id='upload-content'>
                <div class='upload-dropzone-modern' id='upload-dropzone' :click=${this._onDropzoneClick} :dragover=${this._onDragOver} :dragleave=${this._onDragLeave} :drop=${this._onDrop}>
                    <div class='dropzone-icon-wrapper'>
                        <svg viewBox='0 0 24 24' fill='currentColor'>
                            <path d='M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z' />
                        </svg>
                        <div class='dropzone-icon-glow'></div>
                    </div>
                    <div class='dropzone-text-group'>
                        <p class='dropzone-title'>Drop your audio files here</p>
                        <p class='dropzone-subtitle'>or <span class='dropzone-browse'>browse</span> to choose files</p>
                    </div>
                    <div class='dropzone-formats'>
                        <span class='format-tag'>MP3</span>
                        <span class='format-tag'>FLAC</span>
                        <span class='format-tag'>WAV</span>
                        <span class='format-tag'>OGG</span>
                    </div>
                    <input type='file' id='file-upload-input' accept='audio/*' multiple hidden :change=${this._onFileChange}>
                </div>
                <div class='upload-progress-modern hidden' id='upload-progress'>
                    <div class='progress-info'>
                        <svg viewBox='0 0 24 24' fill='currentColor' class='progress-icon spinning'>
                            <path d='M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z' />
                        </svg>
                        <span id='upload-status'>Uploading...</span>
                    </div>
                    <div class='progress-bar-modern'>
                        <div class='progress-fill-modern' id='upload-progress-fill'></div>
                    </div>
                </div>
            </div>
            <div slot='body' class='add-music-content ${youtubeActive}' id='youtube-content'>
                <div class='youtube-input-wrapper'>
                    <div class="youtube-input-field">
                        <svg viewBox='0 0 24 24' fill='currentColor' class='input-icon-svg'>
                            <path d='M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z' />
                        </svg>
                        <input type='text' id='youtube-url-input' placeholder='Paste YouTube or YouTube Music URL...' :keypress=${this._onYouTubeKeyPress}>
                    </div>
                    <button class='btn btn-primary youtube-import-btn' id='youtube-import-btn' :click=${this.importFromYouTube}>
                        <svg viewBox='0 0 24 24' fill='currentColor'>
                            <path d='M5 4v2h14V4H5zm0 10h4v6h6v-6h4l-7-7-7 7z' />
                        </svg>
                        Import
                    </button>
                </div>
                <div class='youtube-status-modern hidden' id='youtube-status'>
                    <div class='status-card'>
                        <div class='status-icon'>
                            <svg viewBox='0 0 24 24' fill='currentColor' class='spinning'>
                                <path d='M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z' />
                            </svg>
                        </div>
                        <div class='status-info'>
                            <span class='status-title' id='youtube-status-text'>Importing from YouTube...</span>
                            <div class='progress-bar-modern'>
                                <div class='progress-fill-modern' id='youtube-progress-fill'></div>
                            </div>
                        </div>
                    </div>
                </div>
                <div class='youtube-tips'>
                    <div class='tip-item'>
                        <svg viewBox='0 0 24 24' fill='currentColor'>
                            <path d='M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z' />
                        </svg>
                        <span>Supports YouTube and YouTube Music URLs</span>
                    </div>
                </div>
            </div>
        </rainy-modal>`;
    }
};

customElements.define(AddMusicModal.componentName, AddMusicModal);