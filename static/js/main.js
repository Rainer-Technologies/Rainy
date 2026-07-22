/**
 * Rainy Music Player - Main Entry Point
 * Loads all modules and initializes the application
 */

import { RainyApp } from './app.js';
import { Logger } from './helper/logger.js';
import { Utils } from './modules/utils.js';
import { AudioPlayer } from './player.js';
import { initLogin, initSetup } from './setup.js';
import { useRatingService } from './services/rating.js';
import { KeyboardShortcuts } from './modules/keyboardShortcuts.js';
import { GlobalSearch } from './modules/globalSearch.js';
import { ShortcutOverlay } from './modules/shortcutOverlay.js';
import { NewViews } from './modules/newViews.js';

// Document ready handler
document.addEventListener('DOMContentLoaded', () => {
    Logger.log('🎵 Rainy Music Player - Initializing...');

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

    // Initialize global keyboard shortcuts (Space, arrows, Ctrl+K, etc.)
    window.keyboardShortcuts = new KeyboardShortcuts(window.player, window.app);

    // Initialize global search overlay (Ctrl+K / Cmd+K)
    window.globalSearch = new GlobalSearch(window.app, window.player);

    // Initialize keyboard shortcut cheat sheet overlay (? key)
    window.shortcutOverlay = new ShortcutOverlay();

    // Initialize new views (Albums, Recently Played, Smart Mix)
    window.newViews = new NewViews(window.app, window.player);

    // Register service worker for PWA support
    registerServiceWorker();

    // Run migration for ratings table (one-time per browser)
    runRatingsMigration();

    Logger.log('🎵 Rainy Music Player - Ready');
});

/**
 * Register the service worker for PWA / offline shell support.
 */
function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('/sw.js')
                .then((reg) => Logger.log('Service worker registered:', reg.scope))
                .catch((err) => Logger.warn('Service worker registration failed:', err));
        });
    }
}

/**
 * Migrate existing likes from Liked Music playlist to song_ratings table
 * and clear old localStorage dislikes
 */
async function runRatingsMigration() {
    try {
        // Check if migration has already been run in this browser
        const migrationDone = localStorage.getItem('rainy_ratings_migrated');
        if (migrationDone) {
            // Still run cleanup to fix any existing duplicates
            try {
                await useRatingService().cleanupDuplicates();
            } catch (e) {
                // Ignore cleanup errors
            }
            return;
        }

        // Clear old localStorage dislikes
        localStorage.removeItem('rainy_disliked_song_ids');
        localStorage.removeItem('rainy_liked_song_ids');

        // Run migration
        const result = await useRatingService().migrateLikes();
        if (result.value && result.value.success) {
            Logger.log(`Migrated ${result.value.migrated} likes to ratings table`);
        }

        // Run cleanup to remove any duplicates
        try {
            const cleanupResult = await useRatingService().cleanupDuplicates();
            if (cleanupResult.value && cleanupResult.value.removed > 0) {
                Logger.log(`Removed ${cleanupResult.value.removed} duplicate entries`);
            }
        } catch (e) {
            Logger.warn('Cleanup failed:', e);
        }

        // Mark migration as done
        localStorage.setItem('rainy_ratings_migrated', 'true');
    } catch (e) {
        Logger.warn('Ratings migration failed:', e);
        // Don't set migration flag on error, so it will retry next time
    }
}
