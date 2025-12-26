export function handle(_, userdata) {
    const viewElement = document.getElementById('setup-view');
    if(!viewElement) return console.error('setup-view is missing!');

    document.getElementById('login-view')?.classList.add('hidden');
    document.getElementById('app-view')?.classList.add('hidden');
    viewElement.classList.remove('hidden');
}

