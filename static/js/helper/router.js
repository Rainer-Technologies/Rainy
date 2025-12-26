export class View {
    /**
     * @template T
     * @param {string} path
     * @param {T} data
     */
    constructor(path, data) {
        /** @type {string} */
        this.path = path;
        /** @type {T} */
        this.data = data;
    }
};

export class Router {
    /** @type {Record<string, (data: any, userdata: any) => void>} */
    static views = {};

    /**
     * @template T
     * @param {string} path
     * @param {(data: T, userdata: any) => void} handler
     */
    static register(path, handler) {
        this.views[path] = handler;
    }

    /** 
     * @template T
     * @param {View<T>} view
     * @param {any} userdata
     */
    static navigate(view, userdata) {
        console.log('[Router] navigate to', view);

        const handler = this.views[view.path];
        if(!handler) return;

        handler(view.data, userdata);
    }
};