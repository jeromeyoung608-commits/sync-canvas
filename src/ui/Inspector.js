/**
 * The right-hand panel: who is here, what just happened, and what the engine
 * thinks of itself. This is the part of the demo that makes the algorithm
 * visible instead of asking the viewer to take it on faith.
 */

import * as BoardOT from '../engine/BoardOT.js';
import { formatTime } from '../utils/geom.js';

const MAX_ROWS = 70;

export class Inspector {
  constructor({ bus, engine, presence }) {
    this.bus = bus;
    this.engine = engine;
    this.presence = presence;
    this.raw = false;
    this.rows = 0;
    this.pending = false;

    this.stream = document.getElementById('stream');
    this.vv = document.getElementById('vv');
    this.metrics = document.getElementById('metrics');

    this.stream.innerHTML = '<div class="stream-empty">Operations from every peer land here as they are sequenced.</div>';
    this.buildMetrics();

    const toggle = document.getElementById('stream-toggle');
    toggle.addEventListener('click', () => {
      this.raw = !this.raw;
      toggle.setAttribute('aria-pressed', String(this.raw));
      for (const row of this.stream.querySelectorAll('.op-row')) {
        const body = row.querySelector('.op-json');
        if (body) body.hidden = !this.raw;
      }
    });

    bus.on('peers', ({ list }) => this.renderPeers(list));
    bus.on('op', (e) => this.pushOp(e));
    bus.on('engine:changed', () => this.scheduleMetrics());
    bus.on('net', () => this.scheduleMetrics());

    this.renderPeers(presence.list());
    this.renderMetrics();
  }

  // ── people ────────────────────────────────────────────────────

  renderPeers(list) {
    const sig = list
      .map((p) => `${p.site}:${p.name}:${p.color}:${p.editing}:${p.site === this.engine.hubSite}`)
      .join('|');
    if (sig === this.peerSig) return;
    this.peerSig = sig;

    const box = document.getElementById('peers-list');
    document.getElementById('peer-count').textContent = String(list.length);
    box.innerHTML = '';

    for (const p of list) {
      const row = document.createElement('div');
      row.className = 'peer-row';

      const dot = document.createElement('i');
      dot.className = 'peer-dot';
      dot.style.background = p.color;

      const name = document.createElement('span');
      name.className = 'peer-name';
      name.textContent = p.name;

      const state = document.createElement('span');
      state.className = 'peer-state';
      if (p.editing) {
        state.textContent = 'typing';
        state.classList.add('editing');
      } else if (p.site === this.engine.hubSite) {
        state.textContent = 'hub';
        state.style.color = 'var(--fg-200)';
      }

      row.append(dot, name);
      if (p.self) {
        const you = document.createElement('span');
        you.className = 'peer-you';
        you.textContent = 'you';
        row.appendChild(you);
      }
      row.appendChild(state);
      box.appendChild(row);
    }
  }

  // ── operation stream ──────────────────────────────────────────

  pushOp(e) {
    if (this.rows === 0) this.stream.innerHTML = '';
    this.rows += 1;

    const op = e.op;
    const row = document.createElement('div');
    row.className = 'op-row' + (e.local ? ' is-local' : '');

    const time = document.createElement('span');
    time.className = 'op-time';
    time.textContent = formatTime(Date.now());

    const dot = document.createElement('i');
    dot.className = 'op-site';
    dot.style.background = this.presence.colorFor(e.site);

    const kind = document.createElement('span');
    kind.className = 'op-kind';
    const label = op ? BoardOT.label(op) : 'dropped';
    const preview = op ? BoardOT.preview(op) : 'no-op after transform';
    kind.innerHTML = `<b>${label}</b> ${escapeHtml(preview)}`;

    const delta = document.createElement('span');
    delta.className = 'op-delta';
    delta.textContent = `r${e.rev}`;

    row.append(time, dot, kind, delta);

    const body = document.createElement('div');
    body.className = 'op-json';
    body.hidden = !this.raw;
    body.textContent = JSON.stringify({ site: e.site, seq: e.seq, rev: e.rev, op }, null, 1);
    row.appendChild(body);

    row.addEventListener('click', () => {
      body.hidden = !body.hidden;
    });

    this.stream.insertBefore(row, this.stream.firstChild);
    while (this.stream.children.length > MAX_ROWS) this.stream.lastChild.remove();
  }

  // ── engine telemetry ──────────────────────────────────────────

  buildMetrics() {
    const keys = [
      ['rev', 'revision'],
      ['nodes', 'nodes'],
      ['sent', 'sent'],
      ['received', 'received'],
      ['queued', 'queued'],
      ['unacked', 'in flight'],
      ['sequenced', 'sequenced'],
      ['dropped', 'dropped'],
    ];
    this.metricEls = {};
    this.metrics.innerHTML = '';
    for (const [key, label] of keys) {
      const cell = document.createElement('div');
      cell.className = 'metric';
      const k = document.createElement('span');
      k.className = 'metric-k';
      k.textContent = label;
      const v = document.createElement('span');
      v.className = 'metric-v';
      v.textContent = '0';
      cell.append(k, v);
      this.metrics.appendChild(cell);
      this.metricEls[key] = v;
    }
  }

  scheduleMetrics() {
    if (this.pending) return;
    this.pending = true;
    setTimeout(() => {
      this.pending = false;
      this.renderMetrics();
    }, 120);
  }

  renderMetrics() {
    const s = this.engine.stats();
    for (const [key, el] of Object.entries(this.metricEls)) {
      el.textContent = String(s[key]);
      if (key === 'queued' || key === 'unacked') el.classList.toggle('warn', Number(s[key]) > 0);
    }

    const pairs = Object.entries(s.vv).sort((a, b) => b[1] - a[1]);
    this.vv.innerHTML =
      '<span class="vv-k">version vector · seq per site</span>' +
      pairs.map(([site, seq]) => `<b>${site}</b> ${seq}`).join(' · ');

    const peers = document.getElementById('peers-list');
    if (peers.children.length) this.renderPeers(this.presence.list());
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
