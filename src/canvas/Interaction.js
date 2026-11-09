/**
 * Pointer and keyboard behavior.
 *
 * Two details worth calling out:
 *
 * 1. Dragging is painted from a local offset that is committed to the engine
 *    at ~25 Hz. The eye sees a 60 Hz drag, the network sees a fraction of the
 *    operations, and the final position is always flushed on release.
 *
 * 2. Every mutation goes through `engine.local()`. Nothing here knows whether
 *    a real socket or a BroadcastChannel is underneath, and nothing waits for
 *    an acknowledgement — the optimistic overlay makes the board respond
 *    immediately.
 */

import * as BoardOT from '../engine/BoardOT.js';
import { inRect } from '../utils/geom.js';

const DRAG_COMMIT_MS = 40;

function distanceToSegment(p, a, b) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const wx = p.x - a.x;
  const wy = p.y - a.y;
  const len2 = vx * vx + vy * vy;
  const t = len2 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t));
}

export class Interaction {
  constructor({ canvas, viewport, engine, renderer, bus, presence }) {
    this.canvas = canvas;
    this.viewport = viewport;
    this.engine = engine;
    this.renderer = renderer;
    this.bus = bus;
    this.presence = presence;

    this.tool = 'select';
    this.selection = new Set();
    this.color = 'butter';
    this.space = false;

    this.panning = null;
    this.drag = null;
    this.marquee = null;
    this.linkFrom = null;
    this.pointerId = null;

    this.bind();
  }

  // ── wiring ────────────────────────────────────────────────────

  bind() {
    const c = this.canvas;

    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointermove', (e) => this.onMove(e));
    c.addEventListener('pointerup', (e) => this.onUp(e));
    c.addEventListener('pointercancel', (e) => this.onUp(e));
    c.addEventListener('pointerleave', () => {
      this.renderer.hoverId = null;
    });
    c.addEventListener('dblclick', (e) => this.onDouble(e));
    c.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));

    this.bus.on('tool', (t) => {
      this.tool = t;
      this.cancelLink();
    });
    this.bus.on('delete-selection', () => this.deleteSelection());
    this.bus.on('color', (color) => this.applyColor(color));
  }

  capture(e) {
    try {
      this.canvas.setPointerCapture(e.pointerId);
      this.pointerId = e.pointerId;
    } catch {
      // Pointer already released (or synthetic): drag still works via move events.
    }
  }

  localPoint(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  worldPoint(e) {
    const p = this.localPoint(e);
    return this.viewport.screenToWorld(p.x, p.y);
  }

  // ── hit testing ───────────────────────────────────────────────

  hitTest(world) {
    const nodes = this.engine.view.nodes;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (n.kind === 'note' && inRect(world.x, world.y, n)) return n;
    }
    const slack = 8 / this.viewport.zoom;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const l = nodes[i];
      if (l.kind !== 'link') continue;
      const a = nodes.find((n) => n.id === l.from);
      const b = nodes.find((n) => n.id === l.to);
      if (!a || !b) continue;
      const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
      const cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
      if (distanceToSegment(world, ca, cb) < slack) return l;
    }
    return null;
  }

  // ── selection ─────────────────────────────────────────────────

  setSelection(ids) {
    this.selection = new Set(ids.filter(Boolean));
    this.renderer.selection = this.selection;
    this.presence.setSelection([...this.selection]);

    const nodes = this.engine.view.nodes;
    const notes = nodes.filter((n) => this.selection.has(n.id) && n.kind === 'note');
    this.bus.emit('selection', {
      ids: [...this.selection],
      count: this.selection.size,
      hasNotes: notes.length > 0,
      color: notes.length ? notes[0].color : null,
    });
  }

  applyColor(color) {
    this.color = color;
    const nodes = this.engine.view.nodes;
    const ts = this.engine.stamp();
    for (const id of this.selection) {
      const n = nodes.find((x) => x.id === id);
      if (!n || n.kind !== 'note') continue;
      this.engine.local(BoardOT.ops.set(id, { color }, ts));
    }
  }

  deleteSelection() {
    const doomed = new Set();
    const nodes = this.engine.view.nodes;
    for (const id of this.selection) {
      const n = nodes.find((x) => x.id === id);
      if (n) doomed.add(id);
    }
    // A note never leaves a dangling arrow behind.
    for (const n of nodes) {
      if (n.kind === 'link' && (doomed.has(n.from) || doomed.has(n.to))) doomed.add(n.id);
    }
    this.setSelection([]);

    while (doomed.size) {
      const list = this.engine.view.nodes;
      let target = null;
      for (const id of doomed) {
        const n = list.find((x) => x.id === id);
        if (n) {
          target = { node: n, index: list.indexOf(n) };
          break;
        }
      }
      if (!target) break;
      doomed.delete(target.node.id);
      this.engine.local(BoardOT.ops.del(target.index, target.node.id));
    }
  }

  // ── pointer ───────────────────────────────────────────────────

  onDown(e) {
    if (e.button === 1 || this.space) {
      this.panning = { x: e.clientX, y: e.clientY };
      this.canvas.classList.add('panning');
      this.capture(e);
      return;
    }
    if (e.button !== 0) return;

    const world = this.worldPoint(e);
    this.capture(e);

    if (this.tool === 'note') {
      const id = `${this.engine.site.toLowerCase()}-${this.engine.seq + 1}-n`;
      const node = {
        id,
        kind: 'note',
        x: Math.round(world.x - BoardOT.NOTE_W / 2),
        y: Math.round(world.y - BoardOT.NOTE_H / 2),
        w: BoardOT.NOTE_W,
        h: BoardOT.NOTE_H,
        color: this.color,
        text: '',
        by: this.engine.site,
      };
      this.engine.local(BoardOT.ops.ins(this.engine.view.nodes.length, node));
      this.setSelection([id]);
      this.bus.emit('tool', 'select');
      this.bus.emit('edit-note', id);
      return;
    }

    if (this.tool === 'link') {
      const hit = this.hitTest(world);
      if (hit && hit.kind === 'note') {
        this.linkFrom = hit.id;
        this.renderer.linkDraft = { from: hit.id, x: world.x, y: world.y };
      }
      return;
    }

    const hit = this.hitTest(world);
    if (!hit) {
      if (!e.shiftKey) this.setSelection([]);
      this.marquee = { x0: world.x, y0: world.y, x1: world.x, y1: world.y };
      this.renderer.marquee = { x: world.x, y: world.y, w: 0, h: 0 };
      return;
    }

    if (e.shiftKey) {
      const next = new Set(this.selection);
      if (next.has(hit.id)) next.delete(hit.id);
      else next.add(hit.id);
      this.setSelection([...next]);
      return;
    }

    if (!this.selection.has(hit.id)) this.setSelection([hit.id]);
    if (this.selection.has(hit.id) && hit.kind === 'note') this.beginDrag(world);
  }

  onMove(e) {
    const local = this.localPoint(e);
    const world = this.viewport.screenToWorld(local.x, local.y);
    this.presence.move(world.x, world.y);

    if (this.panning) {
      this.viewport.panBy(e.clientX - this.panning.x, e.clientY - this.panning.y);
      this.panning.x = e.clientX;
      this.panning.y = e.clientY;
      return;
    }

    if (this.drag) {
      this.extendDrag(world);
      return;
    }

    if (this.marquee) {
      this.marquee.x1 = world.x;
      this.marquee.y1 = world.y;
      const x = Math.min(this.marquee.x0, world.x);
      const y = Math.min(this.marquee.y0, world.y);
      this.renderer.marquee = { x, y, w: Math.abs(world.x - this.marquee.x0), h: Math.abs(world.y - this.marquee.y0) };
      return;
    }

    if (this.linkFrom) {
      this.renderer.linkDraft = { from: this.linkFrom, x: world.x, y: world.y };
      return;
    }

    const hit = this.tool === 'select' ? this.hitTest(world) : null;
    this.renderer.hoverId = hit ? hit.id : null;
  }

  onUp(e) {
    this.canvas.classList.remove('panning');

    if (this.panning) {
      this.panning = null;
      return;
    }

    if (this.drag) {
      this.commitDrag();
      this.renderer.drag = null;
      this.drag = null;
      return;
    }

    if (this.marquee) {
      const m = this.renderer.marquee;
      this.renderer.marquee = null;
      this.marquee = null;
      if (m && (m.w > 4 || m.h > 4)) {
        const hits = this.engine.view.nodes
          .filter((n) => n.kind === 'note')
          .filter((n) => {
            const cx = n.x + n.w / 2;
            const cy = n.y + n.h / 2;
            return cx >= m.x && cx <= m.x + m.w && cy >= m.y && cy <= m.y + m.h;
          })
          .map((n) => n.id);
        if (hits.length) this.setSelection(hits);
      }
      return;
    }

    if (this.linkFrom) {
      const world = this.worldPoint(e);
      const hit = this.hitTest(world);
      const from = this.linkFrom;
      this.cancelLink();
      if (hit && hit.kind === 'note' && hit.id !== from) this.createLink(from, hit.id);
      return;
    }
  }

  onDouble(e) {
    if (this.tool !== 'select') return;
    const hit = this.hitTest(this.worldPoint(e));
    if (hit && hit.kind === 'note') {
      this.setSelection([hit.id]);
      this.bus.emit('edit-note', hit.id);
    }
  }

  onWheel(e) {
    e.preventDefault();
    const local = this.localPoint(e);
    if (e.ctrlKey || e.metaKey) {
      this.viewport.zoomAt(local.x, local.y, Math.exp(-e.deltaY * 0.0025));
    } else {
      this.viewport.panBy(-e.deltaX, -e.deltaY);
    }
  }

  // ── drag ──────────────────────────────────────────────────────

  beginDrag(world) {
    const nodes = this.engine.view.nodes;
    const picked = nodes.filter((n) => n.kind === 'note' && this.selection.has(n.id));
    if (!picked.length) return;
    this.drag = {
      start: world,
      base: picked.map((n) => ({ id: n.id, x: n.x, y: n.y })),
      ids: new Set(picked.map((n) => n.id)),
      dx: 0,
      dy: 0,
      doneX: 0,
      doneY: 0,
      sentAt: 0,
    };
  }

  extendDrag(world) {
    const d = this.drag;
    d.dx = Math.round(world.x - d.start.x);
    d.dy = Math.round(world.y - d.start.y);
    this.renderer.drag = { ids: d.ids, dx: d.dx - d.doneX, dy: d.dy - d.doneY };

    const now = performance.now();
    if (now - d.sentAt >= DRAG_COMMIT_MS) this.commitDrag(now);
  }

  commitDrag(now = performance.now()) {
    const d = this.drag;
    if (!d) return;
    if (d.dx === d.doneX && d.dy === d.doneY) return;

    const ts = this.engine.stamp();
    for (const b of d.base) {
      this.engine.local(
        BoardOT.ops.set(b.id, { x: b.x + d.dx, y: b.y + d.dy }, ts),
      );
    }
    d.doneX = d.dx;
    d.doneY = d.dy;
    d.sentAt = now;
    this.renderer.drag = { ids: d.ids, dx: 0, dy: 0 };
  }

  createLink(from, to) {
    const nodes = this.engine.view.nodes;
    const dup = nodes.some(
      (n) => n.kind === 'link' && n.from === from && n.to === to,
    );
    if (dup) return;
    const id = `${this.engine.site.toLowerCase()}-${this.engine.seq + 1}-l`;
    this.engine.local(
      BoardOT.ops.ins(nodes.length, {
        id,
        kind: 'link',
        from,
        to,
        by: this.engine.site,
      }),
    );
  }

  cancelLink() {
    this.linkFrom = null;
    this.renderer.linkDraft = null;
  }

  // ── keyboard ──────────────────────────────────────────────────

  onKey(e, down) {
    const typing = e.target && (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT');
    if (typing) {
      if (down && e.key === 'Escape') this.bus.emit('end-editing');
      return;
    }

    if (e.code === 'Space') {
      this.space = down;
      e.preventDefault();
      return;
    }
    if (!down) return;

    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.selection.size) {
        e.preventDefault();
        this.deleteSelection();
      }
      return;
    }

    if (e.key === 'Escape') {
      if (this.linkFrom) this.cancelLink();
      else this.setSelection([]);
      return;
    }

    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'v' || e.key === 'V') this.bus.emit('tool', 'select');
    if (e.key === 'n' || e.key === 'N') this.bus.emit('tool', 'note');
    if (e.key === 'l' || e.key === 'L') this.bus.emit('tool', 'link');
    if (e.key === '0') this.bus.emit('zoom-fit');
  }
}
