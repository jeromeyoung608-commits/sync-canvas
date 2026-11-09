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
 * Transport abstraction — the only place the rest of the app touches the
 * network.
 *
 * Two implementations share one interface (`open / send / close`):
 *
 *   BroadcastChannelLink  same-browser tabs, zero backend, used by default
 *   WebSocketLink         a real socket, enabled by passing ?ws=ws://host/path
 *
 * Swapping the backend is a one-line change in main.js. Nothing in the OT
 * engine, the renderer or the UI knows which one is running.
 */

const CHANNEL_PREFIX = 'sync-canvas/v1/';

class BroadcastChannelLink {
  constructor(room, onMessage) {
    this.channel = new BroadcastChannel(CHANNEL_PREFIX + room);
    this.channel.onmessage = (event) => onMessage(event.data);
  }

  post(msg) {
    this.channel.postMessage(msg);
  }

  close() {
    this.channel.onmessage = null;
    this.channel.close();
  }
}

class WebSocketLink {
  constructor(url, onMessage, onStatus) {
    this.url = url;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.queue = [];
    this.backoff = 400;
    this.ws = null;
    this.dead = false;
    this.connect();
  }

  connect() {
    if (this.dead) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = 400;
      this.onStatus({ state: 'open' });
      for (const msg of this.queue.splice(0)) ws.send(JSON.stringify(msg));
    };
    ws.onmessage = (event) => {
      try {
        this.onMessage(JSON.parse(event.data));
      } catch (err) {
        console.warn('[ws] dropped malformed frame', err);
      }
    };
    ws.onclose = () => {
      this.onStatus({ state: 'closed' });
      if (this.dead) return;
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 1.8, 8000);
    };
    ws.onerror = () => ws.close();
  }

  post(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    else this.queue.push(msg);
  }

  close() {
    this.dead = true;
    this.ws?.close();
  }
}

export class SocketProvider {
  constructor({ room, bus, url = null, onStatus }) {
    this.room = room;
    this.bus = bus;
    this.url = url;
    this.onStatus = onStatus || (() => {});
    this.link = null;
    this.suspended = false;
    this.transport = url ? 'WebSocket' : 'BroadcastChannel';
  }

  get state() {
    return this.suspended ? 'closed' : 'open';
  }

  open() {
    if (this.link) return;
    const handler = (msg) => this.bus.emit('wire', msg);
    this.link = this.url
      ? new WebSocketLink(this.url, handler, (s) => this.onStatus(s))
      : new BroadcastChannelLink(this.room, handler);
    this.onStatus({ state: this.suspended ? 'closed' : 'open' });
  }

  send(msg) {
    if (this.suspended || !this.link) return;
    this.link.post(msg);
  }

  /** Simulated network failure: the link is torn down, local edits continue. */
  suspend() {
    this.suspended = true;
    this.link?.close();
    this.link = null;
    this.onStatus({ state: 'closed' });
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
