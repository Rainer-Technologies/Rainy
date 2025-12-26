/** 
 * @param {import('../services/auth.js').UserModel} data 
 * @param {import('../app').RainyApp} userdata
 */
export function handle(data, userdata) {
    const viewElement = document.getElementById('app-view');
    if(!viewElement) return console.error('app-view is missing!');

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

    userdata.loadPlaylists();
    userdata.loadLibrary();
};