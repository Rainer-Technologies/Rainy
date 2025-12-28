import { Logger } from "../helper/logger.js";

/**
 * @param {any} _
 * @param {import('../app').RainyApp} userdata
 */
export function handle(_, userdata) {
    const viewElement = document.getElementById('setup-view');
    if(!viewElement) return Logger.error('setup-view is missing!');

    document.getElementById('login-view')?.classList.add('hidden');
    document.getElementById('app-view')?.classList.add('hidden');
    viewElement.classList.remove('hidden');
}