/**
 * Chrome: tools, zoom, the selection bar, the room controls and the status
 * line. Every button here ends up calling the same three or four verbs —
 * change tool, change color, delete, toggle the link — that the canvas and
 * the engine already expose.
 */

import * as BoardOT from '../engine/BoardOT.js';

const TOOLS = [
  {
    id: 'select',
    key: 'V',
    label: 'Select and move',
    svg: '<path d="M3 2v11l3.2-2.8 2.2 3.9 2.2-1.1-2.2-3.7 4-0.4z"/>',
  },
  {
    id: 'note',
    key: 'N',
    label: 'Sticky note',
    svg: '<rect x="2" y="2.5" width="12" height="11" rx="2"/><path d="M5 6h6M5 9.5h4"/>',
  },
  {
    id: 'link',
    key: 'L',
    label: 'Connect notes',
    svg: '<circle cx="4" cy="12" r="2.3"/><circle cx="12" cy="4" r="2.3"/><path d="M5.7 10.3 10.3 5.7"/>',
  },
];

function toast(text) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1900);
}

export class Toolbar {
  constructor({ bus, engine, viewport, renderer, canvas, presence, room, transport }) {
    this.bus = bus;
    this.engine = engine;
    this.viewport = viewport;
    this.canvas = canvas;
    this.presence = presence;
    this.room = room;
    this.transport = transport;

    this.tool = 'select';
    this.buildTools();
    this.buildContext();
    this.bindZoom();
    this.bindTopbar();

    this.bus.on('tool', (t) => {
      this.setTool(t);
      this.updateHint(t);
    });
    this.bus.on('selection', (sel) => this.updateContext(sel));
    this.bus.on('peers', ({ list }) => this.renderPeers(list));
    this.bus.on('net', () => this.updateStatus());
    this.bus.on('engine:changed', () => this.updateStatus());
    this.bus.on('engine:role', () => this.updateStatus());
    this.bus.on('zoom-fit', () => this.fit());

    viewport.onChange(() => this.updateZoom());
    this.renderPeers(presence.list());
    this.updateZoom();
    this.updateStatus();
  }

  // ── tools ─────────────────────────────────────────────────────

  buildTools() {
    const bar = document.getElementById('toolbar');
    bar.innerHTML = '';
    for (const t of TOOLS) {
      const btn = document.createElement('button');
      btn.className = 'tool';
      btn.dataset.tool = t.id;
      btn.title = `${t.label} · ${t.key}`;
      btn.setAttribute('aria-pressed', String(t.id === this.tool));
      btn.innerHTML =
        `<svg viewBox="0 0 16 16" width="17" height="17">${t.svg}</svg>` +
        `<span class="keycap">${t.key}</span>`;
      btn.addEventListener('click', () => this.bus.emit('tool', t.id));
      bar.appendChild(btn);
    }
  }

  setTool(id) {
    this.tool = id;
    for (const el of document.querySelectorAll('.tool')) {
      el.setAttribute('aria-pressed', String(el.dataset.tool === id));
    }
  }

  // ── selection context bar ─────────────────────────────────────

  buildContext() {
    const bar = document.getElementById('context');
    bar.innerHTML = '';

    const swatches = document.createElement('div');
    swatches.style.display = 'contents';
    for (const color of BoardOT.NOTE_COLORS) {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.dataset.color = color;
      b.style.background = BoardOT.COLOR_HEX[color];
      b.title = color;
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => this.bus.emit('color', color));
      swatches.appendChild(b);
    }
    bar.appendChild(swatches);

    const divider = document.createElement('span');
    divider.className = 'divider';
    bar.appendChild(divider);

    const del = document.createElement('button');
    del.className = 'ctx-btn';
    del.innerHTML =
      '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.6 4.5l.6 8.5h5.6l.6-8.5"/></svg><span>Delete</span>';
    del.addEventListener('click', () => this.bus.emit('delete-selection'));
    bar.appendChild(del);

    this.context = bar;
  }

  updateContext(sel) {
    const visible = sel.count > 0 && sel.hasNotes;
    this.context.hidden = !visible;
    if (!visible) return;
    for (const s of this.context.querySelectorAll('.swatch')) {
      s.setAttribute('aria-pressed', String(s.dataset.color === sel.color));
    }
  }

  // ── zoom ─────────────────────────────────────────────────────

  bindZoom() {
    const box = document.getElementById('zoom');
    box.addEventListener('click', (e) => {
      const action = e.target.closest('[data-zoom]')?.dataset.zoom;
      if (!action) return;
      const cx = this.canvas.clientWidth / 2;
      const cy = this.canvas.clientHeight / 2;
      if (action === 'in') this.viewport.zoomAt(cx, cy, 1.22);
      if (action === 'out') this.viewport.zoomAt(cx, cy, 0.82);
      if (action === 'fit') this.fit();
    });
  }

  updateZoom() {
    const el = document.getElementById('zoom-level');
    if (el) el.textContent = `${Math.round(this.viewport.zoom * 100)}%`;
  }

  updateHint(tool) {
    const hints = {
      select: 'drag to move · double-click to type · space to pan',
      note: 'click anywhere to drop a note',
      link: 'drag from one note onto another to connect them',
    };
    const el = document.getElementById('hint');
    if (el) el.textContent = hints[tool] || hints.select;
  }

  fit() {
    const notes = this.engine.view.nodes.filter((n) => n.kind === 'note');
    if (!notes.length) {
      this.viewport.zoom = 1;
      this.viewport.x = 0;
      this.viewport.y = 0;
      this.viewport.touch();
      return;
    }
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const n of notes) {
      x0 = Math.min(x0, n.x);
      y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x + n.w);
      y1 = Math.max(y1, n.y + n.h);
    }
    this.viewport.fit(
      { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
      this.canvas.clientWidth,
      this.canvas.clientHeight,
    );
  }

  // ── top bar ───────────────────────────────────────────────────

  bindTopbar() {
    const roomBtn = document.getElementById('room-btn');
    document.getElementById('room-code').textContent = this.room;
    roomBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(location.href);
        roomBtn.classList.add('copied');
        setTimeout(() => roomBtn.classList.remove('copied'), 1300);
        toast('Room link copied');
      } catch {
        toast('Copy failed — select the URL yourself');
      }
    });

    document.getElementById('btn-tab').addEventListener('click', () => {
      window.open(location.href, '_blank', 'noopener');
    });

    this.netBtn = document.getElementById('btn-net');
    this.netBtn.addEventListener('click', () => {
      const next = !this.engine.online;
      this.engine.setOnline(next);
      toast(next ? 'Network restored — replaying queued ops' : 'Transport dropped — editing locally');
      this.updateStatus();
    });
  }

  // ── peers + status ────────────────────────────────────────────

  renderPeers(list) {
    const box = document.getElementById('peers');
    box.innerHTML = '';
    for (const p of list) {
      const el = document.createElement('div');
      el.className = 'avatar' + (p.self ? ' self' : '');
      el.style.background = p.color;
      el.title = p.self ? `${p.name} (you)` : p.name;
      el.textContent = p.name.slice(0, 1).toUpperCase();
      box.appendChild(el);
    }
  }

  updateStatus() {
    const s = this.engine.stats();
    const dot = document.getElementById('net-dot');
    const label = document.getElementById('net-label');
    const offline = !this.engine.online;

    dot.className = `dot ${offline ? 'offline' : 'live'}`;
    label.textContent = offline ? 'offline · local only' : `connected · ${s.role}`;

    this.netBtn.dataset.state = offline ? 'offline' : 'online';
    this.netBtn.querySelector('span').textContent = offline ? 'Reconnect' : 'Disconnect';

    document.getElementById('transport-cell').textContent = this.transport;

    const queued = s.queued ? `${s.queued} queued` : `${s.unacked} in flight`;
    document.getElementById('stats-cell').textContent =
      `r${s.rev} · ${s.nodes} nodes · ${s.sent} tx · ${queued}`;
  }
}
