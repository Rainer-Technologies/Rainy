/**
 * @param {any} _
 * @param {import('../app').RainyApp} userdata
 */
export function handle(_, userdata) {
    const viewElement = document.getElementById('login-view');
    if(!viewElement) return console.error('login-view is missing!')

    document.getElementById('app-view')?.classList.add('hidden');
    document.getElementById('setup-view')?.classList.add('hidden');
    viewElement.classList.remove('hidden');
};
