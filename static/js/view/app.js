import { Logger } from '../helper/logger.js';

/** 
 * @param {import('../services/auth.js').UserModel} data 
 * @param {import('../app').RainyApp} userdata
 */
export async function handle(data, userdata) {
    const viewElement = document.getElementById('app-view');
    if(!viewElement) return Logger.error('app-view is missing!');

    document.getElementById('login-view')?.classList.add('hidden');
    document.getElementById('setup-view')?.classList.add('hidden');
    viewElement.classList.remove('hidden');

    document.getElementById('user-avatar').textContent = data.username.charAt(0).toUpperCase();
    document.getElementById('user-name').textContent = data.username;

    const serverSettingsItem = document.getElementById('menu-server-settings');
    if(serverSettingsItem) {
        if(data.role === 'sysadmin') {
            serverSettingsItem.classList.remove('hidden');
        } else {
            serverSettingsItem.classList.add('hidden');
        }
    }

    await Promise.allSettled([
        userdata.loadPlaylists(),
        userdata.loadLibrary()
    ]);
    userdata.libraryWatcher?.start();
    userdata.startRouting?.();
    document.dispatchEvent(new CustomEvent('rainy:ready'));
};
