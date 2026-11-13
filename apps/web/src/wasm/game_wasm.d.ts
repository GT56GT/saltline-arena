/* tslint:disable */
/* eslint-disable */

export class Predictor {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Predict one tick of local movement and remember the input for replay.
     */
    apply(seq: number, mx: number, mz: number, yaw: number, pitch: number, jump: boolean, sprint: boolean, crouch: boolean, fire: boolean): void;
    crouching(): boolean;
    eye_y(): number;
    last_error(): number;
    mantling(): boolean;
    /**
     * `map_json` is the `map` field of the server's Welcome message.
     */
    constructor(map_json: string);
    on_ground(): boolean;
    pending(): number;
    /**
     * Distance to the first wall along a ray (for drawing the local tracer instantly).
     */
    raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number): number;
    /**
     * Adopt the server's state for this player, then replay inputs it has not processed yet.
     */
    reconcile(ack: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, crouch: boolean, alive: boolean, mantle?: Float32Array | number[] | null): void;
    speed(): number;
    vx(): number;
    vy(): number;
    vz(): number;
    x(): number;
    y(): number;
    z(): number;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_predictor_free: (a: number, b: number) => void;
    readonly predictor_apply: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => void;
    readonly predictor_crouching: (a: number) => number;
    readonly predictor_eye_y: (a: number) => number;
    readonly predictor_last_error: (a: number) => number;
    readonly predictor_mantling: (a: number) => number;
    readonly predictor_new: (a: number, b: number) => [number, number, number];
    readonly predictor_on_ground: (a: number) => number;
    readonly predictor_pending: (a: number) => number;
    readonly predictor_raycast: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => number;
    readonly predictor_reconcile: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => void;
    readonly predictor_speed: (a: number) => number;
    readonly predictor_vx: (a: number) => number;
    readonly predictor_vy: (a: number) => number;
    readonly predictor_vz: (a: number) => number;
    readonly predictor_x: (a: number) => number;
    readonly predictor_y: (a: number) => number;
    readonly predictor_z: (a: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
