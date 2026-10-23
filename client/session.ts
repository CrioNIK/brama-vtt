import { t as tr, translateSystemMessage } from '../shared/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuthResult, Command, CommandResult, CommandType, ServerMessage, Snapshot } from '../shared/model';
import { hasOperationReceipt, newOperation, readOperations, writeOperations } from './reliable';
import type { PendingOperation, ReliableController, ReliableResult } from './reliable';

const STORAGE = 'brama-vtt-session-v1';
export async function authenticate(mode: 'create' | 'join', data: Record<string, string>): Promise<AuthResult> {
  const response = await fetch(mode === 'create' ? '/api/campaigns' : '/api/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || tr("Could not open the campaign"));
  return result;
}
export function useSession() {
  const [auth, setAuth] = useState<AuthResult | null>(() => {
    if (new URLSearchParams(location.search).has('invite')) return null;
    try { return JSON.parse(sessionStorage.getItem(STORAGE) || 'null'); } catch { return null; }
  });
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [status, setStatus] = useState<'connecting' | 'online' | 'offline'>('connecting');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const snapshotRef = useRef<Snapshot | null>(null);
  const waiting = useRef(new Map<string, { resolve: (value: ReliableResult) => void; promise: Promise<ReliableResult>; timeout: ReturnType<typeof setTimeout> }>());
  const [operations, setOperations] = useState<PendingOperation[]>([]), [storageError, setStorageError] = useState(''), [sending, setSending] = useState<string[]>([]);
  const operationsRef = useRef<PendingOperation[]>([]), storageErrorRef = useRef(''), authRef = useRef(auth); authRef.current = auth;
  const updateStorageError = useCallback((message: string) => { storageErrorRef.current = message; setStorageError(message); }, []);
  const persist = useCallback((next: PendingOperation[]) => {
    const current = authRef.current; if (!current) throw new Error(tr("Session closed."));
    try { writeOperations(sessionStorage, current.campaignId, current.memberId, next); }
    catch { const message = tr("Could not save the operation state in this tab. Operations are blocked until storage recovers."); updateStorageError(message); throw new Error(message); }
    operationsRef.current = next; setOperations(next); updateStorageError('');
  }, [updateStorageError]);
  const settle = useCallback((id: string) => {
    if (!operationsRef.current.some(operation => operation.command.id === id)) return;
    try { persist(operationsRef.current.filter(operation => operation.command.id !== id)); } catch { /* Keep the exact envelope for safe recovery. */ }
  }, [persist]);
  useEffect(() => {
    try { const next = auth ? readOperations(sessionStorage, auth.campaignId, auth.memberId) : []; operationsRef.current = next; setOperations(next); updateStorageError(''); }
    catch (e) { operationsRef.current = []; setOperations([]); updateStorageError(e instanceof Error ? translateSystemMessage(e.message) : tr("Operation storage unavailable.")); }
  }, [auth, updateStorageError]);
  useEffect(() => { snapshotRef.current = snapshot; }, [snapshot]);
  const login = useCallback((value: AuthResult) => { sessionStorage.setItem(STORAGE, JSON.stringify(value)); history.replaceState({}, '', location.pathname); setAuth(value); setError(''); }, []);
  const logout = useCallback(() => { sessionStorage.removeItem(STORAGE); setAuth(null); setSnapshot(null); setStatus('offline'); operationsRef.current = []; setOperations([]); }, []);
  useEffect(() => {
    if (!auth) return;
    let disposed = false; let retry: ReturnType<typeof setTimeout>; let attempt = 0;
    function rejectPending(message: string) {
      for (const request of waiting.current.values()) { clearTimeout(request.timeout); request.resolve({ status: 'unknown', error: message }); }
      if (waiting.current.size) setError(message);
      waiting.current.clear(); setPending(0); setSending([]);
    }
    function connect() {
      if (disposed) return;
      setStatus('connecting');
      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
      wsRef.current = socket;
      socket.onopen = () => { if (!disposed && wsRef.current === socket) socket.send(JSON.stringify({ type: 'auth', token: auth!.token })); };
      socket.onmessage = (event) => {
        if (disposed || wsRef.current !== socket) return;
        let message: ServerMessage;
        try { message = JSON.parse(event.data); } catch { setError(tr("The server sent an invalid response")); return; }
        if (message.type === 'snapshot') {
          setSnapshot(message.data); snapshotRef.current = message.data; setStatus('online'); attempt = 0;
          // Matching immutable receipts are proof of success, even when the ACK was lost.
          for (const operation of [...operationsRef.current]) if (hasOperationReceipt(operation, message.data.campaign)) {
            const id = operation.command.id, request = waiting.current.get(id);
            settle(id);
            if (request) { clearTimeout(request.timeout); waiting.current.delete(id); request.resolve({ status: 'ack', ack: { type: 'ack', id, ok: true, revision: message.data.campaign.revision } }); }
          }
          setPending(waiting.current.size); setSending([...waiting.current.keys()]);
        }
        if (message.type === 'error') setError(message.error);
        if (message.type === 'ack') {
          const ack = message as CommandResult, request = waiting.current.get(ack.id);
          // A late ACK is definitive even after the UI timed out.
          settle(ack.id);
          if (request) { clearTimeout(request.timeout); waiting.current.delete(ack.id); setPending(waiting.current.size); setSending([...waiting.current.keys()]); request.resolve({ status: 'ack', ack }); }
          if (!ack.ok) setError(ack.error || tr("Change rejected"));
        }
      };
      socket.onclose = (event) => {
        if (disposed || wsRef.current !== socket) return;
        setStatus('offline'); rejectPending(tr("Connection lost. The state will be checked after reconnecting."));
        if (event.code === 4001 || event.code === 4401) { setError(tr("Session invalid. Sign in to the campaign again.")); return; }
        retry = setTimeout(connect, Math.min(1000 * 2 ** attempt++, 8000));
      };
      socket.onerror = () => { if (!disposed && wsRef.current === socket) setStatus('offline'); };
    }
    connect();
    return () => { disposed = true; clearTimeout(retry); wsRef.current?.close(); rejectPending(tr("Session closed")); };
  }, [auth, settle]);
  const sendEnvelope = useCallback((cmd: Command): Promise<ReliableResult> => {
    const existing = waiting.current.get(cmd.id); if (existing) return existing.promise;
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !snapshotRef.current) return Promise.resolve({ status: 'unknown', error: tr("Offline. The original command is saved; check the result after reconnecting.") });
    let resolve!: (result: ReliableResult) => void;
    const promise = new Promise<ReliableResult>(done => { resolve = done; });
    const timeout = setTimeout(() => {
      waiting.current.delete(cmd.id); setPending(waiting.current.size); setSending([...waiting.current.keys()]);
      const message = tr("No server confirmation. The result is unknown; check the original operation before making another change.");
      setError(message); resolve({ status: 'unknown', error: message });
    }, 10000);
    waiting.current.set(cmd.id, { resolve, promise, timeout }); setPending(waiting.current.size); setSending([...waiting.current.keys()]);
    try { socket.send(JSON.stringify({ type: 'command', command: cmd })); }
    catch { clearTimeout(timeout); waiting.current.delete(cmd.id); setPending(waiting.current.size); setSending([...waiting.current.keys()]); resolve({ status: 'unknown', error: tr("Sending interrupted. Check the result of the original operation.") }); }
    return promise;
  }, []);
  const command = useCallback((type: CommandType, payload: Record<string, unknown> = {}, useRevision: boolean | number = false): Promise<boolean> => {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !snapshotRef.current) { setError(tr("No server connection. Your draft is preserved in the form.")); return Promise.resolve(false); }
    const id = crypto.randomUUID();
    const cmd: Command = { id, type, payload, ...(useRevision !== false ? { expectedRevision: typeof useRevision === 'number' ? useRevision : snapshotRef.current.campaign.revision } : {}) };
    return sendEnvelope(cmd).then(result => result.status === 'ack' && result.ack.ok);
  }, [sendEnvelope]);
  const execute = useCallback<ReliableController['execute']>(async (actorId, type, payload, revision, label) => {
    const current = authRef.current;
    if (!current || wsRef.current?.readyState !== WebSocket.OPEN) return { status: 'not-sent', error: tr("Wait for a connection before sending.") };
    if (storageErrorRef.current) return { status: 'not-sent', error: storageErrorRef.current };
    if (operationsRef.current.some(operation => operation.actorId === actorId)) return { status: 'not-sent', error: tr("Check the saved operation result for this queue first.") };
    let operation: PendingOperation;
    try { operation = newOperation(current.campaignId, current.memberId, actorId, type, payload, revision, label); persist([...operationsRef.current, operation]); }
    catch (e) { return { status: 'not-sent', error: e instanceof Error ? translateSystemMessage(e.message) : tr("Could not save the operation.") }; }
    return sendEnvelope(operation.command);
  }, [persist, sendEnvelope]);
  const retry = useCallback<ReliableController['retry']>(async actorId => {
    if (storageErrorRef.current) return { status: 'not-sent', error: storageErrorRef.current };
    const operation = operationsRef.current.find(entry => entry.actorId === actorId);
    if (!operation) return { status: 'not-sent', error: tr("The saved operation no longer exists. Check the result history.") };
    return sendEnvelope(operation.command);
  }, [sendEnvelope]);
  const reliable: ReliableController = { operations, sending, storageError, execute, retry };
  return { auth, snapshot, status, error, setError, pending, login, logout, command, reliable };
}
export type SendCommand = ReturnType<typeof useSession>['command'];
