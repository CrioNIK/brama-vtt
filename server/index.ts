import { resolve } from 'node:path';
import { startServer } from './app.ts';

const app = await startServer({ port: Number(process.env.PORT ?? 8015), dbPath: process.env.VTT_DB ? resolve(process.env.VTT_DB) : undefined });
console.log(`BRAMA VTT ready: ${app.url}`);
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await app.close(); process.exit(0); }
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
