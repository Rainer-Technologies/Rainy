/**
 * Rainy Music Player - Main Entry Point
 * Loads all modules and initializes the application
 */

import { RainyApp } from './app.js';
import { AudioPlayer } from './player.js';
import { initSetup, initLogin } from './setup.js';
import { Utils } from './modules/utils.js';

// Document ready handler
document.addEventListener('DOMContentLoaded', () => {
    console.log('🎵 Rainy Music Player - Initializing...');

    // Make utility functions globally available (for inline HTML event handlers)
    window.Utils = Utils;
    window.formatDuration = Utils.formatDuration.bind(Utils);
    window.escapeHtml = Utils.escapeHtml.bind(Utils);
    window.showToast = Utils.showToast.bind(Utils);
    window.handleCoverError = Utils.handleCoverError.bind(Utils);

    // Initialize player first as app depends on it
    window.player = new AudioPlayer();

    // Initialize main application
    window.app = new RainyApp();

    // Initialize setup and login wizards
    initSetup();
    initLogin();

    console.log('🎵 Rainy Music Player - Ready');
});
