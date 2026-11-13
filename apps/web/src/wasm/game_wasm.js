/* @ts-self-types="./game_wasm.d.ts" */

export class Predictor {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PredictorFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_predictor_free(ptr, 0);
    }
    /**
     * Predict one tick of local movement and remember the input for replay.
     * @param {number} seq
     * @param {number} mx
     * @param {number} mz
     * @param {number} yaw
     * @param {number} pitch
     * @param {boolean} jump
     * @param {boolean} sprint
     * @param {boolean} crouch
     * @param {boolean} fire
     */
    apply(seq, mx, mz, yaw, pitch, jump, sprint, crouch, fire) {
        wasm.predictor_apply(this.__wbg_ptr, seq, mx, mz, yaw, pitch, jump, sprint, crouch, fire);
    }
    /**
     * @returns {boolean}
     */
    crouching() {
        const ret = wasm.predictor_crouching(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {number}
     */
    eye_y() {
        const ret = wasm.predictor_eye_y(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    last_error() {
        const ret = wasm.predictor_last_error(this.__wbg_ptr);
        return ret;
    }
    /**
     * `map_json` is the `map` field of the server's Welcome message.
     * @param {string} map_json
     */
    constructor(map_json) {
        const ptr0 = passStringToWasm0(map_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.predictor_new(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        PredictorFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {boolean}
     */
    on_ground() {
        const ret = wasm.predictor_on_ground(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {number}
     */
    pending() {
        const ret = wasm.predictor_pending(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Distance to the first wall along a ray (for drawing the local tracer instantly).
     * @param {number} ox
     * @param {number} oy
     * @param {number} oz
     * @param {number} dx
     * @param {number} dy
     * @param {number} dz
     * @param {number} max
     * @returns {number}
     */
    raycast(ox, oy, oz, dx, dy, dz, max) {
        const ret = wasm.predictor_raycast(this.__wbg_ptr, ox, oy, oz, dx, dy, dz, max);
        return ret;
    }
    /**
     * Adopt the server's state for this player, then replay inputs it has not processed yet.
     * @param {number} ack
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @param {number} vx
     * @param {number} vy
     * @param {number} vz
     * @param {boolean} crouch
     * @param {boolean} alive
     */
    reconcile(ack, x, y, z, vx, vy, vz, crouch, alive) {
        wasm.predictor_reconcile(this.__wbg_ptr, ack, x, y, z, vx, vy, vz, crouch, alive);
    }
    /**
     * @returns {number}
     */
    speed() {
        const ret = wasm.predictor_speed(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    vx() {
        const ret = wasm.predictor_vx(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    vy() {
        const ret = wasm.predictor_vy(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    vz() {
        const ret = wasm.predictor_vz(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    x() {
        const ret = wasm.predictor_x(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    y() {
        const ret = wasm.predictor_y(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    z() {
        const ret = wasm.predictor_z(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) Predictor.prototype[Symbol.dispose] = Predictor.prototype.free;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_4c88d8bf264fd984: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbindgen_generic_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            table.set(0, undefined);
            table.set(1024, undefined);
            table.set(1025, null);
            table.set(1026, true);
            table.set(1027, false);
        },
    };
    return {
        __proto__: null,
        "./game_wasm_bg.js": import0,
    };
}

const PredictorFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_predictor_free(ptr, 1));

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(bytes) {
    numBytesDecoded += bytes.length;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
        cachedTextDecoder.decode();
        numBytesDecoded = bytes.length;
    }
    return cachedTextDecoder.decode(bytes);
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

let __wbg_init_promise;
async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;
    if (__wbg_init_promise === undefined) {
        __wbg_init_promise = __wbg_init_once(module_or_path);
        __wbg_init_promise.catch(() => { __wbg_init_promise = undefined; });
    }
    return __wbg_init_promise;
}

async function __wbg_init_once(module_or_path) {

    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('game_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
