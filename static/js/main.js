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

    // Run migration for ratings table (one-time per browser)
    runRatingsMigration();

    Logger.log('🎵 Rainy Music Player - Ready');
});

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
