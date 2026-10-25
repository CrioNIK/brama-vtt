/** Execute Rust contract assertions on the same WASM target without a host C linker. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const root = dirname(fileURLToPath(import.meta.url));
const candidate = join(homedir(), '.cargo/bin/cargo' + (process.platform === 'win32' ? '.exe' : ''));
const cargo = process.env.CARGO || (existsSync(candidate) ? candidate : 'cargo');
const target = join(root, 'target/contract-tests');
const build = spawnSync(cargo, ['build', '--locked', '--release', '--target', 'wasm32-unknown-unknown', '--features', 'contract-tests', '--target-dir', target], { cwd: root, stdio: 'inherit', windowsHide: true });
if (build.status !== 0) process.exit(build.status ?? 1);
const { instance } = await WebAssembly.instantiate(readFileSync(join(target, 'wasm32-unknown-unknown/release/brama_raycast.wasm')), {});
assert.equal(instance.exports.run_contract_tests(), 10);
console.log('PASS: 10 Rust contract assertions executed in wasm32-unknown-unknown');
