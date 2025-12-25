/**
 * Rainy Music Player - Auth Module
 * Handles authentication and app state
 */

const Auth = {
    /**
     * Check if setup is needed
     * @param {function} api - API function
     * @returns {Promise<boolean>}
     */
    async needsSetup(api) {
        try {
            const response = await api('/api/setup/status');
            return response.needs_setup === true;
        } catch (error) {
            console.error('Error checking setup status:', error);
            return true;
        }
    },

    /**
     * Get current user if authenticated
     * @param {function} api - API function
     * @returns {Promise<object|null>}
     */
    async getCurrentUser(api) {
        try {
            const response = await api('/api/auth/me');
            if (response.authenticated) {
                return response.user;
            }
            return null;
        } catch (error) {
            console.error('Error checking auth:', error);
            return null;
        }
    },

    /**
     * Logout current user
     * @param {function} api - API function
     * @returns {Promise<void>}
     */
    async logout(api) {
        try {
            await api('/api/auth/logout', 'POST');
        } catch (error) {
            console.error('Error logging out:', error);
        }
        // Always reload to clear state
        window.location.reload();
    },

    /**
     * Check app state and determine initial view
     * @param {function} api - API function
     * @returns {Promise<{view: string, user: object|null}>}
     */
    async checkAppState(api) {
        // First check setup
        if (await this.needsSetup(api)) {
            return { view: 'setup', user: null };
        }

        // Check auth
        const user = await this.getCurrentUser(api);
        if (user) {
            return { view: 'app', user };
        }

        return { view: 'login', user: null };
    }
};

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Auth;
}
