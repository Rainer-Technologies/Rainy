/**
 * Rainy Music Player - Main Entry Point
 * Loads all modules and initializes the application
 * 
 * This file serves as the application's main entry point.
 * The modular JS files in /js/modules provide reusable functionality
 * that can be used by the main RainyApp class in app.js.
 * 
 * Module Loading Order:
 * 1. modules/api.js - API communication
 * 2. modules/utils.js - Utility functions
 * 3. modules/state.js - State management
 * 4. modules/ui.js - UI manipulation
 * 5. modules/auth.js - Authentication
 * 6. modules/library.js - Library rendering
 * 7. modules/scan.js - Library scanning
 * 8. modules/playlists.js - Playlist operations
 * 9. modules/metadata.js - Metadata search/apply
 * 10. modules/importer.js - File/YouTube import
 * 11. modules/context-menu.js - Context menu
 * 12. app.js - Main application class
 * 13. player.js - Audio player
 * 14. setup.js - Setup wizard
 */

// Document ready handler
document.addEventListener('DOMContentLoaded', () => {
    console.log('🎵 Rainy Music Player - Modules Loaded');

    // Make utility functions globally available (backwards compatibility)
    if (typeof Utils !== 'undefined') {
        window.formatDuration = Utils.formatDuration.bind(Utils);
        window.escapeHtml = Utils.escapeHtml.bind(Utils);
        window.showToast = Utils.showToast.bind(Utils);
    }
});
