import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, copyFileSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const root = dirname(fileURLToPath(import.meta.url));
const suffix = process.platform === 'win32' ? '.exe' : '';
const localCargo = join(homedir(), '.cargo/bin/cargo' + suffix);
const cargo = process.env.CARGO || (existsSync(localCargo) ? localCargo : 'cargo');
const localRustc = join(dirname(cargo), 'rustc' + suffix);
const rustc = existsSync(localRustc) ? localRustc : 'rustc';
const check = process.argv.includes('--check');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// Cargo passes this source filename with a backslash on Windows. Rust embeds
// it in panic locations even in stripped builds. Normalize it in the compiler,
// not by modifying the finished binary; Linux already uses the canonical path.
const rustFlags = ['--remap-path-prefix=src\\lib.rs=src/lib.rs'];
const buildEnvironment = { ...process.env, CARGO_ENCODED_RUSTFLAGS: rustFlags.join('\x1f') };
const result = spawnSync(cargo, ['build', '--locked', '--release', '--target', 'wasm32-unknown-unknown'], { cwd: root, stdio: 'inherit', windowsHide: true, env: buildEnvironment });
if (result.status !== 0) process.exit(result.status ?? 1);
const target = join(root, '../../public/wasm');
mkdirSync(target, { recursive: true });
const file = join(target, 'brama_raycast.wasm');
const buildRoot = process.env.CARGO_TARGET_DIR ? resolve(root, process.env.CARGO_TARGET_DIR) : join(root, 'target');
const compiled = join(buildRoot, 'wasm32-unknown-unknown/release/brama_raycast.wasm');
const bytes = readFileSync(compiled);
const compiler = spawnSync(rustc, ['--version'], { cwd: root, encoding: 'utf8', windowsHide: true });
assert.equal(compiler.status, 0, 'Unable to identify Rust compiler');
const sources = Object.fromEntries(['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'src/lib.rs', 'build.mjs'].map(name => [name, hash(readFileSync(join(root, name)))]));
const manifest = { schema: 'brama-raycast-build/1', abi: 1, compiler: compiler.stdout.trim(), target: 'wasm32-unknown-unknown', profile: 'release', features: [], rustFlags, scalarF64: true, bytes: bytes.length, sha256: hash(bytes), sources };
const manifestFile = join(target, 'brama_raycast.build.json');
if (check) {
  assert.equal(hash(readFileSync(file)), hash(bytes), 'Distributed WASM differs from the reproducible build');
  assert.deepEqual(JSON.parse(readFileSync(manifestFile, 'utf8')), manifest, 'Distributed WASM source manifest is stale');
} else {
  copyFileSync(compiled, file);
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
}
console.log(JSON.stringify({ status: check ? 'REPRODUCIBLE_BUILD_VERIFIED' : 'BUILT', file, bytes: bytes.length, sha256: hash(bytes) }));
