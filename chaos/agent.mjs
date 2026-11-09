#!/usr/bin/env node
/**
 * ========================================================================
 * sync-canvas — Distributed State & Real-time Collaboration Engine
 * Copyright (c) 2026 Jerome Young. All Rights Reserved.
 *
 * This source code is licensed under the AGPL-3.0 license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * WARNING: Unauthorized removal of this notice, or deploying this code
 * in a closed-source commercial SaaS without purchasing a commercial
 * license from the author, will result in legal action.
 * Contact: jeromeyoung608@gmail.com
 * ========================================================================
 */

/**
 * Chaos agent: hosts N real SyncEngine replicas and exposes one control
 * socket to the Python orchestrator.
 *
 * The engine under test is the JavaScript module shipped in src/engine.
 * Re-implementing OT in Python would only prove that a second implementation
 * agrees with itself, so the bots are thin WebSocket shells around the real
 * `SyncEngine`, and Python owns everything that happens *around* the engine:
 * the relay, the outage schedule, the operation storm, snapshots and hashing.
 *
 * Each replica is a separate `SyncEngine` instance with its own site id,
 * provider, presence roster and timer. They share one Node process purely to
 * keep the demo laptop-friendly; nothing in the engine depends on it.
 *
 * Control protocol (JSON over WebSocket, one message per command):
 *
 *   { cmd: "spam",   site, count }   generate count random txt/ins/set ops
 *   { cmd: "offline", site }         tear the replica's link down
 *   { cmd: "online",  site }         reconnect the link
 *   { cmd: "seed",    site, notes }  insert the shared hot notes
 *   { cmd: "sync" }                  run one anti-entropy round on everyone
 *   { cmd: "roles" }                 compact roster snapshot
 *   { cmd: "snapshot" }              full document snapshot for hashing
 *   { cmd: "stop" }                  shut down
 */

import { createHash } from 'node:crypto';
import * as OT from '../src/engine/OT.js';
import * as BoardOT from '../src/engine/BoardOT.js';
import { SyncEngine } from '../src/engine/SyncEngine.js';
import { EventBus } from '../src/utils/EventBus.js';

/** Key-sorted JSON so two replicas hash the same document to the same bytes. */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function docHash(nodes) {
  return createHash('sha256').update(stable(nodes)).digest('hex');
}

// ── arguments ───────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};

const RELAY = arg('relay', 'ws://127.0.0.1:9910');
const CONTROL = arg('control', 'ws://127.0.0.1:9911');
const ROOM = arg('room', 'CHAOS');
const COUNT = Number(arg('clients', '50'));
const PREFIX = arg('prefix', 'BOT');
const SEED = Number(arg('seed', '1'));

// ── deterministic-ish randomness ────────────────────────────────────────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  'vertex', 'canvas', 'offset', 'glyph', 'matrix', 'delta', 'signal', 'echo',
  'kernel', 'vector', 'anchor', 'layer', 'beacon', 'quartz', 'harbor', 'atlas',
];
const COLORS = BoardOT.NOTE_COLORS;

// ── transport ───────────────────────────────────────────────────────────────

/**
 * One WebSocket per replica. `suspend()` really closes the socket, so the
 * peer disappears from the relay exactly like a laptop lid closing would.
 */
class WsLink {
  constructor(url, onMessage) {
    this.url = url;
    this.onMessage = onMessage;
    this.queue = [];
    this.ws = null;
    this.connect();
  }

  connect() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.addEventListener('open', () => {
      for (const frame of this.queue.splice(0)) ws.send(frame);
    });
    ws.addEventListener('message', (event) => {
      try {
        this.onMessage(JSON.parse(event.data));
      } catch {
        // A malformed frame would be a relay bug; drop it like the browser link does.
      }
    });
    ws.addEventListener('error', () => {});
    ws.addEventListener('close', () => {});
  }

  post(msg) {
    const frame = JSON.stringify(msg);
    if (this.ws && this.ws.readyState === 1) this.ws.send(frame);
    else this.queue.push(frame);
  }

  close() {
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      // already gone
    }
  }
}

class Provider {
  constructor(url, bus) {
    this.url = url;
    this.bus = bus;
    this.link = null;
    this.suspended = true;
  }

  open() {
    if (this.link) return;
    this.link = new WsLink(this.url, (msg) => this.bus.emit('wire', msg));
  }

  send(msg) {
    if (this.suspended || !this.link) return;
    this.link.post(msg);
  }

  suspend() {
    this.suspended = true;
    this.link?.close();
    this.link = null;
  }

  resume() {
    this.suspended = false;
    this.open();
  }

  close() {
    this.link?.close();
    this.link = null;
  }
}

// ── presence roster ─────────────────────────────────────────────────────────

/**
 * The browser `Presence` class without cursors. It exists for one reason:
 * `SyncEngine` never decides who is in the room, it is told. The 3s heartbeat
 * and 8s expiry are copied verbatim so the chaos harness exercises the same
 * election timing as the real UI.
 */
const HEARTBEAT_MS = 3000;
const EXPIRE_MS = 8000;
const SWEEP_MS = 1000;

class BotPresence {
  constructor({ site, provider, bus }) {
    this.site = site;
    this.provider = provider;
    this.bus = bus;
    this.peers = new Map();
    this.online = true;

    bus.on('net', ({ online }) => {
      this.online = online;
      if (!online) return;
      const now = Date.now();
      for (const peer of this.peers.values()) peer.last = now;
      this.emitPeers();
      this.announce(true);
    });

    this.heartbeat = setInterval(() => {
      if (this.online) this.announce(false);
    }, HEARTBEAT_MS);
    this.sweeper = setInterval(() => this.sweep(), SWEEP_MS);
    this.heartbeat.unref?.();
    this.sweeper.unref?.();

    this.announce(false);
  }

  announce(hello) {
    this.provider.send({
      k: 'presence',
      site: this.site,
      name: this.site,
      color: '#888888',
      x: 0,
      y: 0,
      sel: [],
      editing: null,
      hello: Boolean(hello),
      t: Date.now(),
    });
  }

  receive(msg) {
    if (msg.site === this.site) return;
    const now = Date.now();
    const known = this.peers.has(msg.site);
    this.peers.set(msg.site, { last: now });
    if (!known) {
      this.emitPeers();
      this.announce(false);
    }
    if (msg.hello) this.emitPeers();
  }

  sweep() {
    if (!this.online) return;
    const now = Date.now();
    const expired = [];
    for (const [site, peer] of this.peers) {
      if (now - peer.last > EXPIRE_MS) {
        this.peers.delete(site);
        expired.push(site);
      }
    }
    if (expired.length) {
      if (process.env.CHAOS_TRACE) {
        console.error(`[trace] ${this.site} expired ${expired.join(',')} roster=${this.sites().length}`);
      }
      this.emitPeers();
    }
  }

  sites() {
    return [this.site, ...this.peers.keys()].sort();
  }

  emitPeers() {
    this.bus.emit('peers', { sites: this.sites() });
  }
}

// ── one replica ─────────────────────────────────────────────────────────────

class BotClient {
  constructor(index, relayUrl) {
    this.index = index;
    this.site = `${PREFIX}-${String(index + 1).padStart(2, '0')}`;
    this.rng = mulberry32(SEED * 1000 + index + 1);
    this.bus = new EventBus();
    this.outbox = 0;
    this.hubTerms = 0;
    this.localOps = 0;

    this.provider = new Provider(
      `${relayUrl}/?room=${encodeURIComponent(ROOM)}&site=${this.site}`,
      this.bus,
    );
    this.presence = new BotPresence({
      site: this.site,
      provider: this.provider,
      bus: this.bus,
    });
    this.engine = new SyncEngine({
      site: this.site,
      provider: this.provider,
      bus: this.bus,
      now: () => Date.now(),
      warmMs: 350,
    });

    this.bus.on('wire', (msg) => {
      if (!msg || typeof msg !== 'object' || typeof msg.k !== 'string') return;
      if (msg.k === 'presence') this.presence.receive(msg);
      else this.engine.receive(msg);
    });
    this.bus.on('peers', ({ sites }) => {
      if (process.env.CHAOS_TRACE && sites.length !== COUNT) {
        console.error(
          `[trace] ${this.site} roster=${sites.length} winner=${sites[0]} hasSeedHub=${sites.includes(`${PREFIX}-01`)}`,
        );
      }
      this.engine.setPeers(sites);
    });
    this.bus.on('engine:role', ({ role }) => {
      if (role === 'hub') this.hubTerms += 1;
      if (process.env.CHAOS_TRACE) {
        console.error(`[trace] ${this.site} role=${role} hub=${this.engine.hubSite} peers=${this.presence.peers.size}`);
      }
    });

    this.provider.resume();
    this.engine.setPeers(this.presence.sites());
    this.presence.announce(false);
  }

  /** Real-world intent generation: character-level text, inserts and patches. */
  randomOp() {
    const view = this.engine.view.nodes;
    const notes = view.filter((n) => n.kind === 'note');
    const r = this.rng();

    if (r < 0.28 || view.length === 0) {
      if (view.length > 150) return null;
      const id = `${this.site.toLowerCase()}-ins-${this.localOps}-${Math.floor(this.rng() * 65536)}`;
      return BoardOT.ops.ins(Math.floor(this.rng() * (view.length + 1)), {
        id,
        kind: 'note',
        x: Math.floor(this.rng() * 1600),
        y: Math.floor(this.rng() * 1000),
        w: BoardOT.NOTE_W,
        h: BoardOT.NOTE_H,
        color: COLORS[Math.floor(this.rng() * COLORS.length)],
        text: '',
        by: this.site,
      });
    }

    if (r < 0.86 && notes.length) {
      // Prefer the shared hot notes so concurrent text edits collide by design.
      const hot = notes.filter((n) => /^seed-/.test(n.id));
      const pool = hot.length && this.rng() < 0.8 ? hot : notes;
      const node = pool[Math.floor(this.rng() * pool.length)];
      const before = node.text || '';
      const at = Math.floor(this.rng() * (before.length + 1));
      let after;
      if (before.length > 120) {
        after = before.slice(0, at) + before.slice(Math.min(before.length, at + 8));
      } else if (this.rng() < 0.62 || before.length === 0) {
        const word = `${WORDS[Math.floor(this.rng() * WORDS.length)]}-${Math.floor(this.rng() * 999)}`;
        const chunk = before.length ? ` ${word}` : word;
        after = before.slice(0, at) + chunk + before.slice(at);
      } else {
        const n = 1 + Math.floor(this.rng() * Math.min(6, before.length));
        after = before.slice(0, at) + before.slice(at + n);
      }
      const o = OT.diff(before, after);
      return o ? BoardOT.ops.txt(node.id, o) : null;
    }

    if (view.length) {
      const node = notes[Math.floor(this.rng() * notes.length)];
      if (!node) return null;
      if (this.rng() < 0.6) {
        return BoardOT.ops.set(
          node.id,
          { x: Math.floor(this.rng() * 1600), y: Math.floor(this.rng() * 1000) },
          this.engine.stamp(),
        );
      }
      return BoardOT.ops.set(
        node.id,
        { color: COLORS[Math.floor(this.rng() * COLORS.length)] },
        this.engine.stamp(),
      );
    }
    return null;
  }

  spam(count) {
    for (let i = 0; i < count; i += 1) {
      const op = this.randomOp();
      if (!op) continue;
      if (this.engine.local(op)) this.localOps += 1;
    }
  }

  seed(notes) {
    if (this.engine.role !== 'hub') return 0;
    let made = 0;
    for (let i = 0; i < notes; i += 1) {
      const op = BoardOT.ops.ins(i, {
        id: `seed-${String(i + 1).padStart(2, '0')}`,
        kind: 'note',
        x: 80 + i * 230,
        y: 160,
        w: BoardOT.NOTE_W,
        h: BoardOT.NOTE_H,
        color: COLORS[i % COLORS.length],
        text: '',
        by: this.site,
      });
      if (this.engine.local(op)) made += 1;
    }
    return made;
  }

  summary() {
    const s = this.engine.stats();
    return {
      site: this.site,
      online: s.online,
      role: s.role,
      hub: s.hub,
      rev: s.rev,
      nodes: s.nodes,
      unacked: s.unacked,
      queued: s.queued,
      inbox: this.engine.inbox.length,
      sent: s.sent,
      received: s.received,
      sequenced: s.sequenced,
      dropped: s.dropped,
      hubTerms: this.hubTerms,
      localOps: this.localOps,
      peers: this.presence.peers.size,
      docHash: docHash(this.engine.doc.nodes),
    };
  }

  snapshot() {
    return {
      ...this.summary(),
      doc: this.engine.doc,
      viewNodes: this.engine.view.nodes.length,
    };
  }

  stop() {
    clearInterval(this.presence.heartbeat);
    clearInterval(this.presence.sweeper);
    this.provider.close();
  }
}

// ── cluster ─────────────────────────────────────────────────────────────────

const clients = [];
for (let i = 0; i < COUNT; i += 1) {
  clients.push(new BotClient(i, RELAY));
}

const bySite = new Map(clients.map((c) => [c.site, c]));

const control = new WebSocket(CONTROL);

control.addEventListener('open', () => {
  control.send(JSON.stringify({ k: 'ready', sites: clients.map((c) => c.site) }));
});

control.addEventListener('error', () => {
  process.exit(2);
});

control.addEventListener('message', (event) => {
  let msg;
  try {
    msg = JSON.parse(event.data);
  } catch {
    return;
  }

  const client = msg.site ? bySite.get(msg.site) : null;
  let reply = null;

  switch (msg.cmd) {
    case 'spam':
      client?.spam(Math.max(0, Number(msg.count) || 0));
      return;

    case 'offline':
      if (!client || !client.engine.online) return;
      client.engine.setOnline(false);
      return;

    case 'online':
      if (!client || client.engine.online) return;
      client.engine.setOnline(true);
      return;

    case 'seed':
      reply = { k: 'seeded', id: msg.id, site: client?.site ?? null, created: client ? client.seed(Number(msg.notes) || 0) : 0 };
      break;

    case 'sync':
      if (msg.site && client) client.engine.requestSync();
      else for (const c of clients) c.engine.requestSync();
      reply = { k: 'synced', id: msg.id, clients: msg.site ? 1 : clients.length };
      break;

    case 'roles':
      reply = { k: 'roles', id: msg.id, clients: clients.map((c) => c.summary()) };
      break;

    case 'snapshot':
      reply = { k: 'snapshot', id: msg.id, clients: clients.map((c) => c.snapshot()) };
      break;

    case 'stop':
      for (const c of clients) c.stop();
      reply = { k: 'stopped', id: msg.id };
      if (control.readyState === 1) control.send(JSON.stringify(reply));
      setTimeout(() => process.exit(0), 120);
      return;

    default:
      return;
  }

  if (reply && control.readyState === 1) control.send(JSON.stringify(reply));
});

process.on('SIGTERM', () => {
  for (const c of clients) c.stop();
  process.exit(0);
});
process.on('SIGINT', () => {
  for (const c of clients) c.stop();
  process.exit(0);
});
