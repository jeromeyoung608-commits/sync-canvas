/**
 * Presence: who is in the room, where their cursor is, what they have selected.
 *
 * Coordinates travel in *world* units, so a peer who is zoomed in on a corner
 * still points at the same pixel of the board as a peer looking at the whole
 * thing. Outgoing updates are throttled to ~25 Hz; incoming positions are
 * eased toward their target every frame so the cursor glides instead of
 * teleporting on each packet.
 */

import { lerp } from '../utils/geom.js';

const NAMES = ['Quill', 'Marlowe', 'Wren', 'Aster', 'Leif', 'Odette'];
const COLORS = ['#cf5f3c', '#2f8d82', '#5a6fc4', '#b1832b', '#8a5cb8', '#3f8ac4'];

const SEND_MS = 40;
const HEARTBEAT_MS = 3000;
const EXPIRE_MS = 8000;
const SWEEP_MS = 1000;

function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}

export class Presence {
  constructor({ site, provider, bus }) {
    this.site = site;
    this.provider = provider;
    this.bus = bus;

    const slot = hash(site) % NAMES.length;
    this.name = NAMES[slot];
    this.color = COLORS[slot];

    this.peers = new Map();
    this.me = { x: 0, y: 0, sel: [], editing: null };
    this.lastSend = 0;
    this.lastSweep = 0;
    this.dirty = true;
    this.online = true;

    // While the link is down we receive nothing, so every peer we know looks
    // silent. Freezing the sweep keeps them on the roster instead of pruning
    // the whole room and electing ourselves hub. On reconnect we re-announce
    // with a hello flag so both sides run role election again.
    bus.on('net', ({ online }) => {
      this.online = online;
      if (!online) return;
      const now = performance.now();
      for (const peer of this.peers.values()) peer.last = now;
      this.emitPeers();
      this.announce(true);
    });

    this.announce();
  }

  colorFor(site) {
    if (site === this.site) return this.color;
    const peer = this.peers.get(site);
    if (peer) return peer.color;
    return COLORS[hash(site || '') % COLORS.length];
  }

  nameFor(site) {
    if (site === this.site) return this.name;
    const peer = this.peers.get(site);
    return peer ? peer.name : site;
  }

  // ── outgoing ──────────────────────────────────────────────────

  announce(hello = false) {
    this.provider.send({
      k: 'presence',
      site: this.site,
      name: this.name,
      color: this.color,
      x: this.me.x,
      y: this.me.y,
      sel: this.me.sel,
      editing: this.me.editing,
      hello,
      t: Date.now(),
    });
    this.lastSend = performance.now();
    this.dirty = false;
  }

  move(x, y) {
    this.me.x = x;
    this.me.y = y;
    this.dirty = true;
  }

  setSelection(ids) {
    this.me.sel = ids.slice(0, 24);
    this.announce();
  }

  setEditing(id) {
    this.me.editing = id;
    this.announce();
  }

  // ── incoming ──────────────────────────────────────────────────

  receive(msg) {
    if (msg.site === this.site) return;
    const now = performance.now();

    if (msg.leave) {
      if (this.peers.delete(msg.site)) this.emitPeers();
      return;
    }

    let peer = this.peers.get(msg.site);
    if (!peer) {
      peer = {
        site: msg.site,
        name: msg.name,
        color: msg.color,
        x: msg.x,
        y: msg.y,
        tx: msg.x,
        ty: msg.y,
        sel: [],
        editing: null,
        last: now,
      };
      this.peers.set(msg.site, peer);
      this.emitPeers();
      // Say hello back immediately. Without this, two tabs that open at the
      // same moment would not see each other until the next 3s heartbeat —
      // and for those seconds both of them would believe they are the hub.
      this.announce();
    }

    peer.name = msg.name;
    peer.color = msg.color;
    peer.tx = msg.x;
    peer.ty = msg.y;
    peer.sel = msg.sel || [];
    peer.editing = msg.editing || null;
    peer.last = now;

    // A peer coming back from an offline stretch is still in our roster, so
    // the branch above never runs. Re-elect explicitly — otherwise the
    // returning peer can decide it is hub while we keep believing we are.
    if (msg.hello) this.emitPeers();
  }

  // ── per-frame ─────────────────────────────────────────────────

  tick(now = performance.now()) {
    const gap = now - this.lastSend;
    if (this.dirty ? gap >= SEND_MS : gap >= HEARTBEAT_MS) this.announce();

    for (const peer of this.peers.values()) {
      peer.x = lerp(peer.x, peer.tx, 0.3);
      peer.y = lerp(peer.y, peer.ty, 0.3);
    }

    if (this.online && now - this.lastSweep >= SWEEP_MS) {
      this.lastSweep = now;
      let dropped = false;
      for (const [site, peer] of this.peers) {
        if (now - peer.last > EXPIRE_MS) {
          this.peers.delete(site);
          dropped = true;
        }
      }
      if (dropped) this.emitPeers();
    }
  }

  emitPeers() {
    this.bus.emit('peers', { sites: this.sites(), list: this.list() });
  }

  sites() {
    return [this.site, ...this.peers.keys()].sort();
  }

  list() {
    const out = [
      {
        site: this.site,
        name: this.name,
        color: this.color,
        self: true,
        editing: this.me.editing,
        idle: false,
      },
    ];
    for (const peer of this.peers.values()) {
      out.push({
        site: peer.site,
        name: peer.name,
        color: peer.color,
        self: false,
        editing: peer.editing,
        idle: false,
      });
    }
    return out;
  }

  cursors() {
    return this.peers;
  }

  leave() {
    this.provider.send({ k: 'presence', site: this.site, leave: true });
  }
}
