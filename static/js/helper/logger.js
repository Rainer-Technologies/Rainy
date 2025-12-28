export class Logger {
    static LOG_INFO = 'info';
    static LOG_WARN = 'warn';
    static LOG_ERROR = 'error';

    /**
     * @returns {Array<{
     *  cls: string;
     *  method: string;
     *  uri: string;
     *  position: {
     *    line: number;
     *    column: number;
     *  };
     * }>}
     */
    static _traceback() {
        let traceback; try {
            throw new Error('traceback')
        } catch(e) {
            traceback = e;
        }

        return (traceback.stack ?? '').split('\n')
            .slice(0, -1)
            .map((raw) => {
                if(raw.startsWith('Error:')) return null;
                raw = raw.trim();

                // Probably chromium based browser
                if(raw.startsWith('at')) {
                    // at Logger._traceback (http://127.0.0.1:6969/js/helper/logger.js:19:19)
                    let method = raw.slice(3, raw.indexOf('('));
                    let cls = ''; if(method.includes('.')) {
                        cls = method.split('.')[0];
                        method = method.split('.').pop();
                    }

                    const uriWithPosition = raw.slice(raw.indexOf('(') + 1, raw.indexOf(')'));
                    const [match, line, column] = (uriWithPosition.match(/:(\d+):(\d+)$/) || []);

                    return {
                        cls,
                        method,
                        uri: uriWithPosition.replace(match, ''),
                        position: {
                            line: parseInt(line),
                            column: parseInt(column)
                        }
                    };
                }

                // _traceback@http://127.0.0.1:6969/js/helper/logger.js:4:19
                let [method, uriWithPosition] = raw.split('@');
                let cls = ''; if(method.includes('.')) {
                    [cls, method] = method.split('.');
                }

                const [match, line, column] = (uriWithPosition.match(/:(\d+):(\d+)$/) || []);

                return {
                    cls,
                    method,
                    uri: uriWithPosition.replace(match, ''),
                    position: {
                        line: parseInt(line),
                        column: parseInt(column)
                    }
                };
            })
            .filter(Boolean);
    }

    /**
     * @param {string} severity
     * @param {...any} message
     */
    static _log(severity, ...message) {
        // [{TYPE} ({DATE})] [{URI}:{LINE}:{COLUMN}] [{CLS ? `{CLS} + ::` : ''}{METHOD_NAME}] {MESSAGE}

        const d = new Date();
        const traceback = this._traceback();
        const { cls, method, uri, position } = traceback.at(traceback.length - 1) || {};
        const typ = severity.toUpperCase();

        console.group(`[${typ} ${d.toISOString()}] [${uri}:${position?.line}:${position?.column}] [${cls ? `${cls}::` : ''}${method || '<anon>'}]`, ...message);
            for(const trace of traceback) {
                console.log(`${trace.cls ? `${trace.cls}::` : ''}${trace.method || '<anon>'}@${trace.uri}:${trace.position?.line}:${trace.position?.column}`)
            }
        console.groupEnd();
    }

    /**
     * @param {...any} message
     */
    static log(...message) {
        this._log(this.LOG_INFO, ...message);
    }

    /**
     * @param {...any} message
     */
    static info(...message) {
        this._log(this.LOG_INFO, ...message);
    }

    /**
     * @param {...any} message
     */
    static warn(...message) {
        this._log(this.LOG_WARN, ...message);
    }

    /**
     * @param {...any} message
     */
    static error(...message) {
        this._log(this.LOG_ERROR, ...message);
    }
};