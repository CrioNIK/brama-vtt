import { getRaycastBackendStatus, installRaycastKernel, validateRayBatch, type RaycastBackendStatus, type RaycastKernel } from './raycast-backend.js';

interface RaycastExports {
  memory: WebAssembly.Memory; abi_version(): number; prepare(walls: number, rays: number): number;
  walls_ptr(): number; rays_ptr(): number; output_ptr(): number; cast(ox: number, oy: number): number;
}

/** Instantiate BRAMA's dependency-free ABI. Does not install a process-global backend. */
export async function createGeometryWasmKernel(source: BufferSource | WebAssembly.Module): Promise<RaycastKernel> {
  const instance = source instanceof WebAssembly.Module ? await WebAssembly.instantiate(source, {}) : (await WebAssembly.instantiate(source, {})).instance;
  const exports = instance.exports as unknown as RaycastExports;
  for (const name of ['abi_version', 'prepare', 'walls_ptr', 'rays_ptr', 'output_ptr', 'cast'] as const) {
    if (typeof exports[name] !== 'function') throw new Error(`Missing ray kernel export: ${name}`);
  }
  if (!(exports.memory instanceof WebAssembly.Memory) || exports.abi_version() !== 1) throw new Error('Unsupported ray kernel ABI');
  return { name: 'wasm', cast(ox, oy, walls, rays) {
    validateRayBatch(ox, oy, walls, rays);
    if (exports.prepare(walls.length / 5, rays.length / 3) !== 0) throw new RangeError('Ray kernel capacity exceeded');
    // prepare may grow memory. Obtain fresh views only after it returns.
    new Float64Array(exports.memory.buffer, exports.walls_ptr(), walls.length).set(walls);
    new Float64Array(exports.memory.buffer, exports.rays_ptr(), rays.length).set(rays);
    if (exports.cast(ox, oy) !== 0) throw new Error('Ray kernel execution failed');
    // Detach results from scratch storage before the next batch reuses it.
    return new Float64Array(new Float64Array(exports.memory.buffer, exports.output_ptr(), rays.length / 3));
  } };
}

/** Await before mounting the tabletop so its first cached geometry uses the selected backend.
 * A failed fetch/compile retains the TypeScript reference and reports the reason.
 */
export async function initializeGeometryWasm(url = '/wasm/brama_raycast.wasm'): Promise<Readonly<RaycastBackendStatus>> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`Ray kernel download failed: HTTP ${response.status}`);
    const kernel = await createGeometryWasmKernel(await response.arrayBuffer());
    // ABI smoke check catches a wrong module before making it the global backend.
    const values = kernel.cast(0, 0, new Float64Array([5, -5, 5, 5, 0]), new Float64Array([10, 0, 10]));
    if (values.length !== 1 || values[0] !== 0.5) throw new Error('Ray kernel self-check failed');
    installRaycastKernel(kernel);
  } catch (error) {
    installRaycastKernel(null, error instanceof Error ? error.message : String(error));
  }
  return getRaycastBackendStatus();
}
