/**
 * Rainy Music Player - API Module
 * Handles all HTTP API communication
 */

export const API = {
    /**
     * Make an API request
     * @param {string} url - API endpoint
     * @param {string} method - HTTP method (GET, POST, PUT, DELETE)
     * @param {object} data - Request body data (optional)
     * @returns {Promise<object>} - Response JSON
     */
    async request(url, method = 'GET', data = null) {
        const options = {
            method,
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include'
        };

        if (data) {
            options.body = JSON.stringify(data);
        }

        const response = await fetch(url, options);
        return response.json();
    },

    // Convenience methods
    async get(url) {
        return this.request(url, 'GET');
    },

    async post(url, data) {
        return this.request(url, 'POST', data);
    },

    async put(url, data) {
        return this.request(url, 'PUT', data);
    },

    async delete(url) {
        return this.request(url, 'DELETE');
    }
};
