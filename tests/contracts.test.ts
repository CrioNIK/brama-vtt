import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { startServer } from '../server/app.ts';
import { Store } from '../server/store.ts';
import type { Command } from '../shared/model.ts';

// A terminal authentication failure must be distinguishable from a transient
// disconnect, so a browser does not keep retrying the same invalid credential.
test('an invalid persisted session terminates WebSocket authentication with 4401', async () => {
  const app = await startServer({ port: 0, dbPath: ':memory:' });
  const socket = new WebSocket(app.url.replace('http:', 'ws:') + '/ws');
  const messages: { type: string; error?: string }[] = [];
  socket.on('message', data => messages.push(JSON.parse(data.toString())));
  try {
    await once(socket, 'open');
    const closed = once(socket, 'close');
    socket.send(JSON.stringify({ type: 'auth', token: 'unknown-session-credential-123456789' }));
    const [code] = await closed;
    assert.equal(code, 4401);
    assert.equal(messages.some(message => message.type === 'snapshot'), false);
    assert.ok(messages.some(message => message.type === 'error' && message.error));
  } finally {
    socket.terminate();
    await app.close();
  }
});

function combatFixture() {
  const store = new Store(':memory:');
  const auth = store.create('Combat contract', 'GM');
  const session = store.authenticate(auth.token);
  let commandNumber = 0;
  const command = (type: Command['type'], payload: Record<string, unknown> = {}) => {
    const result = store.command(session, { id: `contract-${++commandNumber}`, type, payload, expectedRevision: store.snapshot(session).campaign.revision });
    assert.equal(result.ack.ok, true, result.ack.error);
  };
  const state = () => store.snapshot(session).campaign;
  const tokens = state().scenes[0].tokens;
  for (const token of tokens) command('combat.add', { id: token.id });
  const ids = state().combat.combatants.map(entry => entry.id);
  ids.forEach((id, index) => command('combat.roll', { id, formula: String(20 - index * 5) }));
  command('combat.next'); // Start combat after preparing the roster and initiative.
  command('combat.next'); // Advance from the first participant to the second.
  assert.equal(state().combat.combatants[state().combat.turn].id, ids[1]);
  return { store, state, command, ids, tokens };
}

test('rerolling initiative preserves the participant whose turn is in progress', () => {
  const f = combatFixture();
  try {
    const round = f.state().combat.round;
    f.command('combat.roll', { id: f.ids[2], formula: '30' });
    const combat = f.state().combat;
    assert.equal(combat.combatants[combat.turn].id, f.ids[1]);
    assert.equal(combat.round, round);
  } finally { f.store.close(); }
});

test('removing a prior participant preserves the current participant', () => {
  const f = combatFixture();
  try {
    f.command('combat.remove', { id: f.ids[0] });
    const combat = f.state().combat;
    assert.equal(combat.combatants[combat.turn].id, f.ids[1]);
  } finally { f.store.close(); }
});

test('deleting a prior participant token preserves the current participant', () => {
  const f = combatFixture();
  try {
    f.command('token.delete', { id: f.tokens[0].id });
    const combat = f.state().combat;
    assert.equal(combat.combatants[combat.turn].id, f.ids[1]);
  } finally { f.store.close(); }
});
