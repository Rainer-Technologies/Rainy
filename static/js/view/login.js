/**
 * @param {any} _
 * @param {import('../app').RainyApp} userdata
 */
export function handle(_, userdata) {
    const viewElement = document.getElementById('login-view');
    if(!viewElement) return console.error('login-view is missing!')

    viewElement.classList.remove('hidden');
};