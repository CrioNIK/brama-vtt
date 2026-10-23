import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import type { ServerMessage } from '../shared/model.ts';
import { DomainError, fail, object } from './engine.ts';
import { Store, type Session } from './store.ts';

export interface ServerOptions { dbPath?: string; port?: number; host?: string; distDir?: string }
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const errorStatus: Record<string, number> = { UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, LIMIT: 413, VALIDATION: 400 };
export async function startServer(options: ServerOptions = {}) {
  const host = options.host ?? '127.0.0.1', port = options.port ?? 8015;
  const store = new Store(options.dbPath ?? resolve('server/data/vtt.sqlite'));
  const dist = resolve(options.distDir ?? 'dist');
  const authenticated = new Map<WebSocket, Session>();
  const send = (ws: WebSocket, message: ServerMessage) => { if (ws.readyState === WebSocket.OPEN) { if (ws.bufferedAmount > 8_000_000) ws.close(1013, 'Client too slow'); else ws.send(JSON.stringify(message)); } };
  const broadcast = (campaignId: string) => {
    for (const [ws, session] of authenticated) if (session.campaignId === campaignId) {
      try { send(ws, { type: 'snapshot', data: store.snapshot(session) }); } catch { ws.close(4401, 'Session invalid'); }
    }
  };
  function authenticate(req: IncomingMessage): Session {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return fail('UNAUTHORIZED', "A valid session is required.");
    return store.authenticate(header.slice(7));
  }
  function json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(body));
  }
  async function body(req: IncomingMessage) {
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of req) { size += chunk.length; if (size > 2_000_000) fail('LIMIT', "The request is too large."); chunks.push(chunk); }
    try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
    catch (error) { if (error instanceof DomainError) throw error; return fail('VALIDATION', "Invalid JSON."); }
  }
  function allowedOrigin(origin: string | undefined) {
    if (!origin) return true;
    try { const parsed = new URL(origin); return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname); }
    catch { return false; }
  }
  const server = createServer(async (req, res) => {
    try {
      if (!allowedOrigin(req.headers.origin)) return json(res, 403, { error: "Invalid Origin.", code: 'FORBIDDEN' });
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (req.method === 'POST' && pathname === '/api/campaigns') { const data = await body(req); return json(res, 201, store.create(data.name, data.gmName, data.locale)); }
      if (req.method === 'POST' && pathname === '/api/join') {
        const data = await body(req), auth = store.join(data.inviteCode, data.name); broadcast(auth.campaignId); return json(res, 201, auth);
      }
      if (req.method === 'GET' && pathname === '/api/snapshot') return json(res, 200, store.snapshot(authenticate(req)));
      if (req.method === 'GET' && pathname === '/api/export') {
        const campaign = store.export(authenticate(req)); res.setHeader('Content-Disposition', `attachment; filename="campaign-${campaign.id}.json"`); return json(res, 200, campaign);
      }
      if (req.method === 'GET' && pathname === '/api/imports') return json(res, 200, { imports: store.imports(authenticate(req)) });
      const archiveMatch = /^\/api\/imports\/([^/]+)\/download$/.exec(pathname);
      if (req.method === 'GET' && archiveMatch) {
        const archive = store.importArchive(authenticate(req), archiveMatch[1]);
        res.setHeader('Content-Disposition', `attachment; filename="neutral-source-${archiveMatch[1].replace(/[^a-zA-Z0-9-]/g, '')}.json"`);
        return json(res, 200, archive);
      }
      if (req.method === 'GET' && pathname === '/api/health') return json(res, 200, { ok: true, version: '0.1.0' });
      if (pathname.startsWith('/api/')) return json(res, 404, { code: 'NOT_FOUND', error: "API endpoint not found." });
      if (!['GET', 'HEAD'].includes(req.method ?? '')) return json(res, 405, { error: "Method not supported." });
      let decoded: string; try { decoded = decodeURIComponent(pathname); } catch { return json(res, 400, { error: "Invalid path." }); }
      if (decoded.includes('\0') || decoded.includes('\\')) return json(res, 400, { error: "Invalid path." });
      let file = resolve(dist, '.' + decoded);
      if (file !== dist && !file.startsWith(dist + sep)) return json(res, 403, { error: "Path unavailable." });
      let exists = await stat(file).catch(() => null);
      if (exists?.isDirectory()) { file = resolve(file, 'index.html'); exists = await stat(file).catch(() => null); }
      if (!exists?.isFile()) {
        if (extname(decoded)) return json(res, 404, { error: "File not found." });
        file = resolve(dist, 'index.html'); exists = await stat(file).catch(() => null);
      }
      if (!exists?.isFile()) return json(res, 503, { error: "The frontend has not been built. Run npm run build." });
      res.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600' });
      res.end(req.method === 'HEAD' ? undefined : await readFile(file));
    } catch (error) { const known = error instanceof DomainError; json(res, known ? errorStatus[error.code] ?? 400 : 500, { code: known ? error.code : 'INTERNAL', error: known ? error.message : "Server error." }); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2_000_000 });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://127.0.0.1').pathname !== '/ws' || !allowedOrigin(req.headers.origin)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', ws => {
    const authTimer = setTimeout(() => ws.close(4401, 'Authentication required'), 10000); authTimer.unref();
    let windowStart = Date.now(), received = 0;
    ws.on('error', () => {});
    ws.on('close', () => { clearTimeout(authTimer); authenticated.delete(ws); });
    ws.on('message', (raw, binary) => {
      try {
        if (Date.now() - windowStart > 1000) { windowStart = Date.now(); received = 0; }
        if (++received > 60) { ws.close(1008, 'Rate limit'); return; }
        if (binary) fail('VALIDATION', "A JSON text message is required.");
        let message: Record<string, unknown>; try { message = object(JSON.parse(raw.toString())); } catch { return fail('VALIDATION', "Invalid JSON."); }
        const session = authenticated.get(ws);
        if (!session) {
          if (message.type !== 'auth') fail('UNAUTHORIZED', "The first message must be auth.");
          const authenticatedSession = store.authenticate(message.token); authenticated.set(ws, authenticatedSession); clearTimeout(authTimer);
          send(ws, { type: 'snapshot', data: store.snapshot(authenticatedSession) }); return;
        }
        if (message.type !== 'command') fail('VALIDATION', "Expected command.");
        const { ack, changed } = store.command(session, message.command); send(ws, ack);
        if (changed) broadcast(session.campaignId);
        else send(ws, { type: 'snapshot', data: store.snapshot(session) });
      } catch (error) {
        send(ws, { type: 'error', error: error instanceof DomainError ? error.message : "The message could not be processed." });
        if (error instanceof DomainError && error.code === 'UNAUTHORIZED') ws.close(4401, 'Unauthorized');
      }
    });
  });
  await new Promise<void>((resolvePromise, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolvePromise(); }); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No TCP address');
  return {
    port: address.port, url: `http://${host}:${address.port}`, store,
    close: async () => { for (const ws of wss.clients) ws.terminate(); await new Promise<void>(resolvePromise => wss.close(() => resolvePromise())); await new Promise<void>((resolvePromise, reject) => server.close(error => error ? reject(error) : resolvePromise())); store.close(); }
  };
}
