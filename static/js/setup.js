/**
 * Rainy Music Player - Setup Wizard & Login
 * Handles first-time setup and user authentication
 */
import { Logger } from "./helper/logger.js";
import { fillLanguageSelect, getLanguage, setLanguage, t } from "./i18n/index.js";

export function initSetup() {
    const setupForm = document.getElementById('setup-form');
    const setupError = document.getElementById('setup-error');
    const setupSubmit = document.getElementById('setup-submit');

    if (!setupForm) return;

    // Language: previews live, and is saved as the admin account's language
    const languageSelect = document.getElementById('setup-language');
    if (languageSelect) {
        fillLanguageSelect(languageSelect);
        languageSelect.addEventListener('change', () => setLanguage(languageSelect.value));
    }

    setupForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        // Get form values
        const username = document.getElementById('setup-username').value.trim();
        const email = document.getElementById('setup-email').value.trim();
        const password = document.getElementById('setup-password').value;
        const musicPath = document.getElementById('setup-music-path').value.trim();

        // Validate
        if (!username || !email || !password || !musicPath) {
            showError(setupError, t('All fields are required'));
            return;
        }

        if (password.length < 8) {
            showError(setupError, t('Password must be at least 8 characters'));
            return;
        }

        // Disable button
        setupSubmit.disabled = true;
        setupSubmit.innerHTML = `<span>${t('Setting up...')}</span>`;

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
                    music_path: musicPath,
                    language: getLanguage()
                })
            });

            const data = await response.json();

            if (data.success) {
                // Reload to show main app
                window.location.reload();
            } else {
                showError(setupError, t(data.error || 'Setup failed'));
                setupSubmit.disabled = false;
                setupSubmit.innerHTML = `<span>${t('Complete Setup')}</span>`;
            }
        } catch (error) {
            Logger.error('Setup error:', error);
            showError(setupError, t('Connection error. Please try again.'));
            setupSubmit.disabled = false;
            setupSubmit.innerHTML = `<span>${t('Complete Setup')}</span>`;
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
            showError(loginError, t('Email and password are required'));
            return;
        }

        // Disable button
        loginSubmit.disabled = true;
        loginSubmit.innerHTML = `<span>${t('Signing in...')}</span>`;

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
                showError(loginError, t(data.error || 'Login failed'));
                loginSubmit.disabled = false;
                loginSubmit.innerHTML = `<span>${t('Sign In')}</span>`;
            }
        } catch (error) {
            Logger.error('Login error:', error);
            showError(loginError, t('Connection error. Please try again.'));
            loginSubmit.disabled = false;
            loginSubmit.innerHTML = `<span>${t('Sign In')}</span>`;
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
