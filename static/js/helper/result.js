/** 
 * @template T 
 * @template E
 */
export class Result {
    /** 
     * @param {T | null} value 
     * @param {E | null} error
     */
    constructor(value, error) {
        /** @type {T | null} */
        this._value = value;
        /** @type {E | null} */
        this._error = error;
    }

    /** @returns {T | null} */
    get value() {
        if(this._error) return null;
        return this._value;
    }

    /** @returns {E | null} */
    get error() {
        if(this._value) return null;
        return this._error;
    }

    /**
     * Throws {@link err} or {@link value} if {@link value} contains an error or is null
     * 
     * @param {E} err
     * @returns {T}
     * @throws {E}
     */
    expect(err) {
        if(!this.ok()) {
            throw (err ?? this._value);
        }

        return this._value;
    }

    toString() {
        return `Result { ok = ${this.ok()} }`;
    }
};

/**
 * @template T
 * @param {T} value
 * @returns {Result<T>}
 */
export function Ok(value) {
    return new Result(value, null);
};

/**
 * @param {E} err
 * @returns {Result<never>}
 */
export function Err(err) {
    return new Result(null, err);
};