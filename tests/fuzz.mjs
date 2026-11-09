/**
 * Convergence fuzzer.
 *
 *   node tests/fuzz.mjs [runs] [--verbose] [--nopart]
 *
 * Boots 2-4 engines on a toy network, hammers them with concurrent inserts,
 * deletes, drags and text edits, kicks peers offline and back, lets the
 * sequencer role move around, then asserts every replica is byte-identical.
 *
 * The toy network has exactly one failure mode: a peer that is offline receives
 * nothing. Everything already in flight still lands, which mirrors a crashed
 * tab (its past writes survive, its future ones do not). Recovery therefore
 * has to go through the anti-entropy path, not through luck.
 */

import * as OT from '../src/engine/OT.js';
import * as BoardOT from '../src/engine/BoardOT.js';
import { SyncEngine } from '../src/engine/SyncEngine.js';
import { EventBus } from '../src/utils/EventBus.js';

const RUNS = Number(process.argv[2]) || 60;
const STEPS = Number(process.env.STEPS) || 90;
const VERBOSE = process.argv.includes('--verbose');
const NO_PART = process.argv.includes('--nopart');

let clock = 0;
const tick = () => (clock += 1);

const clone = (v) => JSON.parse(JSON.stringify(v));

let hubFlips = 0; // proves the runs actually exercise sequencer handoff
let netOutages = 0;

// ── toy network ───────────────────────────────────────────────────────────

class Net {
  constructor() {
    this.clients = [];
    this.queue = [];
  }

  join(client) {
    this.clients.push(client);
  }

  broadcast(from, msg) {
    for (const c of this.clients) {
      if (c === from) continue;
      if (!c.engine.online) continue; // offline peers miss everything
      if (msg.k === 'sync-ops' && msg.to && msg.to !== c.site) continue;
      this.queue.push({
        at: tick() + 1 + ((Math.random() * 3) | 0),
        to: c,
        msg: clone(msg),
      });
    }
  }

  /** Deliver everything in flight, including messages spawned by delivery. */
  drain() {
    let n = 0;
    while (this.queue.length) {
      this.queue.sort((a, b) => a.at - b.at);
      const item = this.queue.shift();
      if (item.to.engine.online) item.to.receive(item.msg);
      if (++n > 50000) throw new Error('network failed to quiesce');
    }
    return n;
  }
}

// ── peers ─────────────────────────────────────────────────────────────────

const NAMES = ['Quill', 'Marlowe', 'Wren', 'Aster', 'Leif', 'Odette'];

class Peer {
  constructor(net, site, name) {
    this.site = site;
    this.name = name;
    this.bus = new EventBus();
    this.sent = 0;
    this.provider = {
      send: (msg) => {
        if (!this.engine.online) return;
        this.sent += 1;
        net.broadcast(this, msg);
      },
      suspend: () => {},
      resume: () => {},
    };
    this.engine = new SyncEngine({
      site,
      provider: this.provider,
      bus: this.bus,
      now: () => clock,
      warmMs: 350,
    });
    this.bus.on('engine:role', ({ role }) => {
      if (role === 'hub') hubFlips += 1;
    });
    net.join(this);
  }

  receive(msg) {
    this.engine.receive(msg);
  }
}

/** Everyone online re-computes the winner from the same live peer list. */
function elect(peers) {
  const live = peers.filter((p) => p.engine.online).map((p) => p.site);
  for (const p of peers) if (p.engine.online) p.engine.setPeers(live);
}

// ── random intents ────────────────────────────────────────────────────────

function randomOp(peer) {
  const view = peer.engine.view;
  const all = view.nodes;
  const notes = all.filter((n) => n.kind === 'note');
  const r = Math.random();

  if ((r < 0.20 || all.length === 0) && all.length < 40) {
    const id = `${peer.site.toLowerCase()}-${peer.engine.seq + 1}-${Math.random().toString(36).slice(2, 6)}`;
    return BoardOT.ops.ins((Math.random() * (all.length + 1)) | 0, {
      id,
      kind: 'note',
      x: (Math.random() * 800) | 0,
      y: (Math.random() * 600) | 0,
      w: BoardOT.NOTE_W,
      h: BoardOT.NOTE_H,
      color: BoardOT.NOTE_COLORS[(Math.random() * 5) | 0],
      text: '',
    });
  }

  if (r < 0.34 && all.length) {
    const node = all[(Math.random() * all.length) | 0];
    const i = all.indexOf(node);
    return BoardOT.ops.del(i, node.id);
  }

  if (r < 0.70 && all.length) {
    const node = all[(Math.random() * all.length) | 0];
    const patch = Math.random() < 0.5
      ? { x: (Math.random() * 800) | 0, y: (Math.random() * 600) | 0 }
      : { color: BoardOT.NOTE_COLORS[(Math.random() * 5) | 0] };
    return BoardOT.ops.set(node.id, patch, peer.engine.stamp());
  }

  if (notes.length) {
    const node = notes[(Math.random() * notes.length) | 0];
    const before = node.text || '';
    const at = (Math.random() * (before.length + 1)) | 0;
    let after;
    if (Math.random() < 0.6 || before.length === 0) {
      const alphabet = 'abcdefghijklmnop ';
      let add = '';
      for (let i = 0, k = 1 + ((Math.random() * 4) | 0); i < k; i++) {
        add += alphabet[(Math.random() * alphabet.length) | 0];
      }
      after = before.slice(0, at) + add + before.slice(at);
    } else {
      const k = 1 + ((Math.random() * Math.min(4, before.length - at)) | 0);
      after = before.slice(0, at) + before.slice(at + k);
    }
    const o = OT.diff(before, after);
    return o ? BoardOT.ops.txt(node.id, o) : null;
  }

  return null;
}

// ── one scenario ──────────────────────────────────────────────────────────

function randomSite(seen) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += alphabet[(Math.random() * alphabet.length) | 0];
  return seen.has(s) ? randomSite(seen) : s;
}

function runScenario(run) {
  const net = new Net();
  const count = 2 + ((Math.random() * 3) | 0);
  const peers = [];
  const seen = new Set();

  for (let i = 0; i < count; i++) {
    const site = randomSite(seen);
    seen.add(site);
    peers.push(new Peer(net, site, NAMES[i % NAMES.length]));
  }

  net.drain();
  elect(peers);
  net.drain();

  let offline = 0;

  for (let step = 0; step < STEPS; step++) {
    if (!NO_PART && Math.random() < 0.05) {
      const p = peers[(Math.random() * peers.length) | 0];
      const next = !p.engine.online;
      // Never strand the room: at least one peer stays connected.
      if (!next && offline + 1 >= peers.length) continue;
      p.engine.setOnline(next);
      offline += next ? -1 : 1;
      netOutages += 1;
      elect(peers);
      net.drain();
      continue;
    }

    const live = peers.filter((p) => p.engine.online);
    if (!live.length) continue;
    const p = live[(Math.random() * live.length) | 0];
    const op = randomOp(p);
    if (op) p.engine.local(op);
    net.drain();
  }

  // heal, then run two anti-entropy rounds so nobody stays behind
  for (const p of peers) p.engine.setOnline(true);
  elect(peers);
  net.drain();
  for (const p of peers) p.engine.requestSync();
  net.drain();
  elect(peers);
  net.drain();
  for (const p of peers) p.engine.requestSync();
  net.drain();

  const docs = peers.map((p) => JSON.stringify(p.engine.doc.nodes));
  const head = docs[0];
  const ok = docs.every((d) => d === head) &&
    peers.every((p) => p.engine.unacked.length === 0) &&
    peers.every((p) => p.engine.rev === peers[0].engine.rev);

  if (!ok && (VERBOSE || run < 8)) {
    console.log(`\n✗ run ${run} diverged (${count} peers, ${peers.map((p) => p.site).join('/')})`);
    const base = JSON.parse(head);
    peers.forEach((p, i) => {
      const mine = JSON.parse(docs[i]);
      const tag = `${p.site} role=${p.engine.role} rev=${p.engine.rev} unacked=${p.engine.unacked.length} inbox=${p.engine.inbox.length} queued=${p.engine.outbox.length}`;
      if (mine.length !== base.length) console.log(`  ${tag} nodes=${mine.length} expected=${base.length}`);
      const n = Math.max(mine.length, base.length);
      for (let k = 0; k < n; k++) {
        if (JSON.stringify(mine[k]) === JSON.stringify(base[k])) continue;
        console.log(`  ${tag}`);
        console.log(`    @${k} mine=${JSON.stringify(mine[k])}`);
        console.log(`    @${k} head=${JSON.stringify(base[k])}`);
        break;
      }
      if (mine.length === base.length && JSON.stringify(mine) === JSON.stringify(base)) {
        console.log(`  ${tag} content matches (rev drift)`);
      }
    });
    const first = peers[0];
    console.log(`  head log ${first.engine.log.length} entries, last rev ${first.engine.rev - 1}`);
  }

  return { ok, size: JSON.parse(head).length };
}

// ── text OT property test (TP1) ───────────────────────────────────────────

function textPropertyTest(rounds = 400) {
  const alphabet = 'abcde f';
  let failures = 0;

  for (let i = 0; i < rounds; i++) {
    const base = Array.from({ length: 6 + ((Math.random() * 10) | 0) }, () => alphabet[(Math.random() * alphabet.length) | 0]).join('');

    const mutate = (s) => {
      const at = (Math.random() * (s.length + 1)) | 0;
      if (Math.random() < 0.6 || s.length === 0) {
        return s.slice(0, at) + alphabet[(Math.random() * alphabet.length) | 0] + s.slice(at);
      }
      const k = 1 + ((Math.random() * Math.min(3, s.length - at)) | 0);
      return s.slice(0, at) + s.slice(at + k);
    };

    const sa = mutate(mutate(base));
    const sb = mutate(mutate(base));
    const a = OT.diff(base, sa) || [];
    const b = OT.diff(base, sb) || [];
    if (!a.length || !b.length) continue;

    const aPrime = OT.transform(a, b, 'AAAAA', 'BBBBB');
    const bPrime = OT.transform(b, a, 'BBBBB', 'AAAAA');

    const r1 = OT.apply(OT.apply(base, b), aPrime || []);
    const r2 = OT.apply(OT.apply(base, a), bPrime || []);
    if (r1 !== r2) {
      failures++;
      if (failures < 4) console.log('TP1 failure', { base, sa, sb, a, b, aPrime, bPrime, r1, r2 });
    }
  }
  return failures;
}

// ── main ──────────────────────────────────────────────────────────────────

const tp1 = textPropertyTest();
console.log(`text TP1: ${tp1 === 0 ? '✓ passed' : `✗ ${tp1} failures`}`);

let failed = 0;
let bytes = 0;

for (let run = 0; run < RUNS; run++) {
  const res = runScenario(run);
  if (!res.ok) failed++;
  else bytes += res.size;
}

console.log(
  `convergence: ${failed === 0 ? '✓' : '✗'} ${RUNS - failed}/${RUNS} runs identical ` +
  `(avg ${Math.round(bytes / Math.max(1, RUNS - failed))} nodes, ` +
  `${netOutages} disconnects, ${hubFlips} sequencer handoffs)`
);
process.exit(failed === 0 && tp1 === 0 ? 0 : 1);
