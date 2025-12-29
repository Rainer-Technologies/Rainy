import { Logger } from "../helper/logger.js";
import { Utils } from "../modules/utils.js";
import { useMusicService } from "../services/music.js";
import { I } from "./icon.js";
import { a, Component, H, h, on, Ref, useRef } from "./index.js";
import { Modal } from "./modal.js";

export class AddMusicModal extends Component {
    static componentName = 'rainy-add-music-modal';

    created() {
        /** @type {Ref<HTMLDivElement>} */
        this._dropzone = useRef(null);
        /** @type {Ref<HTMLInputElement>} */
        this._fileInput = useRef(null);
        /** @type {Ref<HTMLDivElement>} */
        this._uploadProgress = useRef(null);
        /** @type {Ref<HTMLDivElement>} */
        this._uploadProgressFill = useRef(null);
        /** @type {Ref<HTMLSpanElement>} */
        this._uploadStatus = useRef(null);

        /** @type {Ref<HTMLInputElement>} */
        this._youtubeInput = useRef(null);
        /** @type {Ref<HTMLButtonElement>} */
        this._youtubeImportBtn = useRef(null);
        /** @type {Ref<HTMLDivElement>} */
        this._youtubeStatus = useRef(null);
        /** @type {Ref<HTMLSpanElement>} */
        this._youtubeStatusText = useRef(null);
        /** @type {Ref<HTMLDivElement>} */
        this._youtubeProgressFill = useRef(null);

        this.set('current-method', 'upload', { silent: true });

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
        if(this._youtubeInput.value) this._youtubeInput.value.value = '';
        if(this._fileInput.value) this._fileInput.value.value = '';
        this._uploadProgress.value?.classList.add('hidden');
        this._youtubeStatus.value?.classList.add('hidden');
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
        this._dropzone.value?.classList.remove('dragover');
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
        const dropzone = this._dropzone.value;
        const progress = this._uploadProgress.value;
        const progressFill = this._uploadProgressFill.value;
        const statusText = this._uploadStatus.value;

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
            Logger.error('Upload error:', error);
            statusText.textContent = 'Upload failed. Please try again.';
        } finally {
            setTimeout(() => {
                dropzone.classList.remove('hidden');
                progress.classList.add('hidden');
            }, 2000);
        }
    }

    async importFromYouTube() {
        const urlInput = this._youtubeInput.value;
        const importBtn = this._youtubeImportBtn.value;
        const status = this._youtubeStatus.value;
        const statusText = this._youtubeStatusText.value;
        const progressFill = this._youtubeProgressFill.value;

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
            Logger.error(data.error);

            importBtn.disabled = false;
            status.classList.add('hidden');
            progressFill.style.width = '0%';

            const errorMessage = data.error.error || data.error.message || 'Failed to import from YouTube. Please check the URL and try again.';
            Utils.showToast(errorMessage, 'error', 5000);

            return;
        }

        const result = data.value;
        if (!result) return Logger.error('unreachable');

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

        return H.of(Modal,
            I.Note('currentColor', a.slot('header-icon')),
            h.h2(a.slot('header-title'), 'Add Music'),
            h.p(a.slot('header-subtitle'), a.class('modal-subtitle'), 'Import songs to your library'),
            h.div(a.slot('body'), a.class('add-music-methods'),
                h.div(a.class('add-music-method', uploadActive), a.dataMethod('upload'), on.click(() => this.switchMethod('upload')),
                    h.div(a.class('method-icon'),
                        I.Upload()
                    ),
                    h.div(a.class('method-info'),
                        h.span(a.class('method-title'), 'Upload Files')
                    ),
                    h.div(a.class('method-check'),
                        I.Check()
                    )
                ),
                h.div(a.class('add-music-method', youtubeActive), a.dataMethod('youtube'), on.click(() => this.switchMethod('youtube')),
                    h.div(a.class('method-icon', 'youtube'),
                        I.Yt()
                    ),
                    h.div(a.class('method-info'),
                        h.span(a.class('method-title'), 'YouTube Import')
                    ),
                    h.div(a.class('method-check'),
                        I.Check()
                    )
                )
            ),
            h.div(a.slot('body'), a.class('add-music-content', uploadActive), a.dataMethod('upload'), a.id('upload-content'),
                h.div(this._dropzone, a.class('upload-dropzone-modern'), a.id('upload-dropzone'),
                    on.click(() => this._onDropzoneClick()),
                    on.dragover(() => this._onDragOver()),
                    on.dragleave(() => this._onDragLeave()),
                    on.drop(() => this._onDrop()),
                    h.div(a.class('dropzone-icon-wrapper'),
                        I.Note(),
                        h.div(a.class('dropzone-icon-glow'))
                    ),
                    h.div(a.class('dropzone-text-group'),
                        h.p(a.class('dropzone-title'), 'Drop your audio files here'),
                        h.p(a.class('dropzone-subtitle'),
                            'or ',
                            h.span(a.class('dropzone-browse'), 'browse'),
                            ' to choose files'
                        )
                    ),
                    h.div(a.class('dropzone-formats'),
                        h.span(a.class('format-tag'), 'MP3'),
                        h.span(a.class('format-tag'), 'FLAC'),
                        h.span(a.class('format-tag'), 'WAV'),
                        h.span(a.class('format-tag'), 'OGG'),
                    ),
                    h.input(this._fileInput, a.type('file'), a.id('file-upload-input'), a.accept('audio/*'), a.multiple(''), a.hidden(''), on.change(() => this._onFileChange()))
                ),
                h.div(this._uploadProgress, a.class('upload-progress-modern', 'hidden'), a.id('upload-progress'),
                    h.div(a.class('progress-info'),
                        I.Refresh('currentColor', a.class('progress-icon', 'spinning')),
                        h.span(this._uploadStatus, a.id('upload-status'), 'Uploading...')
                    ),
                    h.div(a.class('progress-bar-modern'),
                        h.div(this._uploadProgressFill, a.class('progress-fill-modern'), a.id('upload-progress-fill'))
                    )
                )
            ),
            h.div(a.slot('body'), a.class('add-music-content', youtubeActive), a.dataMethod('youtube'), a.id('youtube-content'),
                h.div(a.class('youtube-input-wrapper'),
                    h.div(a.class('youtube-input-field'),
                        I.Share('currentColor', a.class('input-icon-svg')),
                        h.input(this._youtubeInput, a.type('text'), a.id('youtube-url-input'), a.placeholder('Paste YouTube or YouTube Music URL...'), on.keypress(() => this._onYouTubeKeyPress()))
                    ),
                    h.button(this._youtubeImportBtn, a.class('btn', 'btn-primary', 'youtube-import-btn'), a.id('youtube-import-btn'), on.click(() => this.importFromYouTube()),
                        I.Import(),
                        'Import'
                    )
                ),
                h.div(this._youtubeStatus, a.class('youtube-status-modern', 'hidden'), a.id('youtube-status'),
                    h.div(a.class('status-card'),
                        h.div(a.class('status-icon'),
                            I.Refresh('currentColor', a.class('spinning'))
                        ),
                        h.div(a.class('status-info'),
                            h.span(this._youtubeStatusText, a.class('status-title'), a.id('youtube-status-text'), 'Importing from YouTube...'),
                            h.div(a.class('progress-bar-modern'),
                                h.div(this._youtubeProgressFill, a.class('progress-fill-modern'), a.id('youtube-progress-fill'))
                            )
                        )
                    )
                ),
                h.div(a.class('youtube-tips'),
                    h.div(a.class('tip-item'),
                        I.Info(),
                        h.span('Supports YouTube and YouTube Music URLs')
                    )
                )
            )
        );
    }
};

customElements.define(AddMusicModal.componentName, AddMusicModal);