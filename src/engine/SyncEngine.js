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
 * Replication layer: optimistic clients plus one single-writer sequencer.
 *
 * Position-based OT is only TP2-safe when a single authority decides the order
 * in which concurrent operations are folded into the document. Three sites
 * editing the same paragraph at the same moment cannot agree on a local
 * ordering rule — that is a property of the model, not a bug in the transform.
 * Every product that does this (production design tools, classic collaborative
 * editors, the original Jupiter paper) puts a sequencer in front.
 *
 * So the engine has two roles:
 *
 *   hub      transforms every incoming op against its own log, commits it with
 *            a monotonic revision number, then broadcasts the result. One
 *            writer, so the transform only ever needs to be TP1-correct.
 *   client   applies revisions strictly in order and keeps its own
 *            not-yet-acknowledged ops in a pending overlay for the renderer.
 *            That overlay is the optimistic UI.
 *
 * The hub is not a server, it is a role: the peer with the lowest site id.
 * When it disappears another peer takes over. Before it may sequence anything
 * it runs one anti-entropy round (`sync-request`) to pull every revision it
 * missed, then replays its log so laggards catch up. Point the transport at a
 * real Socket.io endpoint and the role collapses onto the backend with no
 * change to any other module.
 *
 * Message kinds on the wire:
 *
 *   op           client intent, carries a version vector
 *   op-applied   hub -> everyone, a numbered revision
 *   sync-request client -> everyone, "send me everything from my rev"
 *   sync-ops     peer -> requester, a slice of the log (or a full replay)
 */

import * as BoardOT from './BoardOT.js';

const seqKey = (site, seq) => `${site}:${seq}`;

export class SyncEngine {
  constructor({ site, provider, bus, now = () => Date.now(), warmMs = 350 }) {
    this.site = site;
    this.provider = provider;
    this.bus = bus;
    this.now = now;
    this.warmMs = warmMs;

    this.log = []; // total order, one entry per revision: { rev, site, seq, vv, op }
    this.rev = 0;
    this.doc = BoardOT.emptyDoc();
    this.vv = { [site]: 0 };
    this.seq = 0;
    this.seen = new Set(); // `${site}:${seq}` already sequenced by *some* hub

    this.role = 'warming';
    this.hubSite = null;
    this.peerSites = [site];
    this.online = true;

    this.unacked = []; // own ops the hub has not echoed yet
    this.inbox = []; // revisions that arrived out of order
    this.held = []; // op intents received while warming up as hub
    this.outbox = []; // everything written while offline

    this.roundKey = '';
    this.syncedPeers = '';
    this.replied = new Set();
    this.expected = 0;
    this.warmTimer = null;

    this.clock = 0;
    this.view_ = null;
    this.counters = { sent: 0, received: 0, sequenced: 0, dropped: 0 };
  }

  /** Monotonic timestamp, used as the LWW tie-break input. */
  stamp() {
    const t = this.now();
    this.clock = t > this.clock ? t : this.clock + 1;
    return this.clock;
  }

  // ── what the renderer draws ────────────────────────────────────

  /** Hub-ordered state plus my own unacknowledged edits. */
  get view() {
    if (!this.unacked.length) return this.doc;
    if (this.view_) return this.view_;
    const doc = { nodes: this.doc.nodes.map((n) => ({ ...n })) };
    for (const w of this.unacked) BoardOT.apply(doc, w.op);
    this.view_ = doc;
    return doc;
  }

  invalidate() {
    this.view_ = null;
  }

  // ── local intent ───────────────────────────────────────────────

  local(op) {
    if (!op) return null;

    this.seq += 1;
    const wire = { k: 'op', site: this.site, seq: this.seq, vv: { ...this.vv }, op };
    this.vv[this.site] = this.seq;
    this.unacked.push(wire);
    this.invalidate();

    if (!this.online) {
      this.outbox.push(wire);
      this.bus.emit('engine:changed');
      return wire;
    }

    if (this.role === 'hub') {
      this.sequence(wire);
      return wire;
    }

    this.provider.send(wire);
    this.counters.sent += 1;
    this.bus.emit('op', { op, site: this.site, seq: wire.seq, local: true, rev: this.rev });
    this.bus.emit('engine:changed');
    return wire;
  }

  // ── hub: transform, commit, broadcast ──────────────────────────

  sequence(wire) {
    if (this.seen.has(seqKey(wire.site, wire.seq))) return;
    const op = this.transformAgainstLog(wire);
    const entry = { rev: this.rev, site: wire.site, seq: wire.seq, vv: wire.vv, op };

    this.commit(entry);
    this.provider.send({ k: 'op-applied', ...entry });
    this.counters.sequenced += 1;

    this.bus.emit('op', {
      op: entry.op,
      site: entry.site,
      seq: entry.seq,
      local: entry.site === this.site,
      rev: entry.rev,
      dropped: !entry.op,
    });
    this.bus.emit('engine:changed');
  }

  /** Rebase an incoming op onto every log entry its author had not seen. */
  transformAgainstLog(wire) {
    let op = wire.op;
    const seen = wire.vv || {};
    for (const h of this.log) {
      if (h.seq <= (seen[h.site] || 0)) continue;
      if (!h.op) continue;
      op = BoardOT.transform(op, h.op, wire.site, h.site);
      if (!op) {
        this.counters.dropped += 1;
        return null;
      }
    }
    return op;
  }

  /** Shared by the hub path and the client path: one revision, applied. */
  commit(entry) {
    if (entry.op) BoardOT.apply(this.doc, entry.op);
    this.log.push(entry);
    this.seen.add(seqKey(entry.site, entry.seq));
    this.rev = entry.rev + 1;
    this.vv[entry.site] = Math.max(this.vv[entry.site] || 0, entry.seq);

    if (entry.site === this.site) {
      const i = this.unacked.findIndex((w) => w.seq === entry.seq);
      if (i !== -1) this.unacked.splice(i, 1);
    }
    this.invalidate();
  }

  // ── wire ───────────────────────────────────────────────────────

  receive(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.k) {
      case 'op':
        return this.onOpSend(msg);
      case 'op-applied':
        return this.onApplied(msg);
      case 'sync-request':
        return this.respondSync(msg);
      case 'sync-ops':
        return this.onSyncOps(msg);
      default:
    }
  }

  onOpSend(wire) {
    if (wire.site === this.site) return;
    if (this.role === 'warming') {
      this.held.push(wire);
      return;
    }
    if (this.role !== 'hub' || !this.online) return;
    this.sequence(wire);
  }

  onApplied(msg) {
    if (typeof msg.rev !== 'number') return;
    if (msg.rev < this.rev) return;
    if (msg.rev > this.rev) {
      if (!this.inbox.some((m) => m.rev === msg.rev)) this.inbox.push(msg);
      return;
    }
    this.applyRevision(msg);
  }

  applyRevision(entry) {
    this.commit(entry);
    this.counters.received += 1;
    this.bus.emit('op', {
      op: entry.op,
      site: entry.site,
      seq: entry.seq,
      local: entry.site === this.site,
      rev: entry.rev,
    });
    this.bus.emit('engine:changed');

    // Everything waiting for exactly the next revision can now land.
    while (this.inbox.length) {
      for (let i = this.inbox.length - 1; i >= 0; i--) {
        if (this.inbox[i].rev < this.rev) this.inbox.splice(i, 1);
      }
      const at = this.inbox.findIndex((m) => m.rev === this.rev);
      if (at === -1) break;
      const [next] = this.inbox.splice(at, 1);
      this.applyRevision(next);
    }
  }

  // ── anti-entropy ───────────────────────────────────────────────

  requestSync() {
    this.provider.send({ k: 'sync-request', site: this.site, rev: this.rev });
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => this.bus.emit('engine:resync-done', { rev: this.rev }), 500);
    if (this.syncTimer && this.syncTimer.unref) this.syncTimer.unref();
  }

  /**
   * Any peer with a log can answer — not just the hub. That is what lets a
   * freshly elected hub rebuild itself from a surviving secondary instead of
   * from the node that just died.
   */
  respondSync(msg) {
    if (!this.online || msg.site === this.site) return;
    const from = Number.isFinite(msg.rev) ? msg.rev : 0;
    const ops = this.log.filter((e) => e.rev >= from);
    this.provider.send({ k: 'sync-ops', to: msg.site, by: this.site, ops, tip: this.rev });
  }

  onSyncOps(msg) {
    if (msg.to && msg.to !== this.site) return;
    for (const entry of msg.ops || []) this.onApplied(entry);
    this.bus.emit('engine:changed');

    if (this.role === 'warming' && msg.by && msg.by !== this.site) {
      this.replied.add(msg.by);
      if (this.replied.size >= this.expected) this.settleHub();
    }
  }

  // ── connection ─────────────────────────────────────────────────

  setOnline(next) {
    if (next === this.online) return this.online;
    this.online = next;

    if (next) {
      this.provider.resume();
      if (this.role === 'hub') {
        this.becomeHub(); // re-run the round: someone may have moved on without us
      } else {
        this.flush();
        this.requestSync();
      }
    } else {
      this.provider.suspend();
    }

    this.bus.emit('net', { online: next, queued: this.outbox.length });
    this.bus.emit('engine:changed');
    return this.online;
  }

  /** Send (as client) or sequence (as hub) everything written while offline. */
  flush() {
    if (!this.online || !this.outbox.length) return;
    const queued = this.outbox.splice(0);
    for (const w of queued) {
      if (this.role === 'hub') {
        this.sequence(w);
      } else {
        this.provider.send(w);
        this.counters.sent += 1;
      }
    }
    this.invalidate();
    this.bus.emit('engine:changed');
  }

  /** Clients re-send unacknowledged edits when the sequencer changes. */
  resendUnacked() {
    if (!this.online || this.role === 'hub') return;
    for (const w of this.unacked) {
      this.provider.send(w);
      this.counters.sent += 1;
    }
  }

  // ── role election ──────────────────────────────────────────────

  /**
   * Called whenever the live peer set changes. The lowest site id wins, so the
   * result is identical on every replica without any negotiation.
   */
  setPeers(sites) {
    const list = Array.from(new Set([...(sites || []).filter(Boolean), this.site])).sort();
    this.peerSites = list;
    const key = list.join(',');
    const winner = list[0];
    const prevHub = this.hubSite;
    this.hubSite = winner;

    if (winner === this.site) {
      const stale = this.role === 'hub' && this.syncedPeers !== key;
      const late = this.role === 'client';
      const grown = this.role === 'warming' && this.roundKey !== key;
      if (stale || late || grown) this.becomeHub();
      return this.role;
    }

    if (this.role !== 'client') {
      clearTimeout(this.warmTimer);
      this.held.length = 0;
      this.role = 'client';
      this.bus.emit('engine:role', { role: 'client', hub: winner });
    }
    if (prevHub !== winner) {
      this.resendUnacked();
      this.requestSync();
    }
    return this.role;
  }

  becomeHub() {
    this.role = 'warming';
    clearTimeout(this.warmTimer);

    this.roundKey = this.peerSites.join(',');
    this.replied = new Set();
    this.expected = this.online ? Math.max(0, this.peerSites.length - 1) : 0;

    this.bus.emit('engine:role', { role: 'warming', site: this.site });
    if (this.online && this.expected > 0) this.requestSync();

    if (this.expected === 0) {
      this.settleHub();
    } else {
      this.warmTimer = setTimeout(() => this.settleHub(), this.warmMs);
      if (this.warmTimer && this.warmTimer.unref) this.warmTimer.unref();
    }
  }

  settleHub() {
    if (this.role !== 'warming') return;
    clearTimeout(this.warmTimer);
    this.role = 'hub';
    this.syncedPeers = this.peerSites.join(',');
    this.bus.emit('engine:role', { role: 'hub', site: this.site });

    // Our own ops still in flight when we were a client: sequence them here.
    for (const w of this.unacked.slice()) {
      if (!this.seen.has(seqKey(w.site, w.seq))) this.sequence(w);
    }
    for (const w of this.held.splice(0)) this.sequence(w);
    this.flush();

    // One replay so peers that lagged behind us catch up. Ahead peers ignore
    // every entry they already have; it is one message instead of a storm.
    if (this.online && this.log.length) {
      this.provider.send({ k: 'sync-ops', ops: this.log, tip: this.rev });
    }
    this.invalidate();
    this.bus.emit('engine:changed');
  }

  stats() {
    return {
      rev: this.rev,
      queued: this.outbox.length,
      unacked: this.unacked.length,
      sent: this.counters.sent,
      received: this.counters.received,
      sequenced: this.counters.sequenced,
      dropped: this.counters.dropped,
      nodes: this.view.nodes.length,
      vv: this.vv,
      role: this.role,
      hub: this.hubSite,
      online: this.online,
    };
  }
}
