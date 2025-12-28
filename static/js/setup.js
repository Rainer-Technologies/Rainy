/**
 * Rainy Music Player - Setup Wizard & Login
 * Handles first-time setup and user authentication
 */
import { Logger } from "./helper/logger.js";

export function initSetup() {
    const setupForm = document.getElementById('setup-form');
    const setupError = document.getElementById('setup-error');
    const setupSubmit = document.getElementById('setup-submit');

    if (!setupForm) return;

    setupForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        // Get form values
        const username = document.getElementById('setup-username').value.trim();
        const email = document.getElementById('setup-email').value.trim();
        const password = document.getElementById('setup-password').value;
        const musicPath = document.getElementById('setup-music-path').value.trim();

        // Validate
        if (!username || !email || !password || !musicPath) {
            showError(setupError, 'All fields are required');
            return;
        }

        if (password.length < 6) {
            showError(setupError, 'Password must be at least 6 characters');
            return;
        }

        // Disable button
        setupSubmit.disabled = true;
        setupSubmit.innerHTML = '<span>Setting up...</span>';

        try {
            const response = await fetch('/api/setup/complete', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                credentials: 'include',
                body: JSON.stringify({
                    username,
                    email,
                    password,
                    music_path: musicPath
                })
            });

            const data = await response.json();

            if (data.success) {
                // Reload to show main app
                window.location.reload();
            } else {
                showError(setupError, data.error || 'Setup failed');
                setupSubmit.disabled = false;
                setupSubmit.innerHTML = '<span>Complete Setup</span>';
            }
        } catch (error) {
            Logger.error('Setup error:', error);
            showError(setupError, 'Connection error. Please try again.');
            setupSubmit.disabled = false;
            setupSubmit.innerHTML = '<span>Complete Setup</span>';
        }
    });
}

export function initLogin() {
    const loginForm = document.getElementById('login-form');
    const loginError = document.getElementById('login-error');
    const loginSubmit = document.getElementById('login-submit');

    if (!loginForm) return;

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        // Get form values
        const email = document.getElementById('login-email').value.trim();
        const password = document.getElementById('login-password').value;

        // Validate
        if (!email || !password) {
            showError(loginError, 'Email and password are required');
            return;
        }

        // Disable button
        loginSubmit.disabled = true;
        loginSubmit.innerHTML = '<span>Signing in...</span>';

        try {
            const response = await fetch('/api/auth/login', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                credentials: 'include',
                body: JSON.stringify({ email, password })
            });

            const data = await response.json();

            if (data.success) {
                // Reload to show main app
                window.location.reload();
            } else {
                showError(loginError, data.error || 'Login failed');
                loginSubmit.disabled = false;
                loginSubmit.innerHTML = '<span>Sign In</span>';
            }
        } catch (error) {
            Logger.error('Login error:', error);
            showError(loginError, 'Connection error. Please try again.');
            loginSubmit.disabled = false;
            loginSubmit.innerHTML = '<span>Sign In</span>';
        }
    });
}

function showError(element, message) {
    element.textContent = message;
    element.classList.add('show');

    // Remove animation class after it completes
    setTimeout(() => {
        element.classList.remove('show');
        setTimeout(() => {
            element.classList.add('show');
        }, 50);
    }, 400);
}
