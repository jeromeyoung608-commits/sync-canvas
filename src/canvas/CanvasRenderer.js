/**
 * Canvas painting. Everything is drawn in world coordinates under one
 * transform, so zooming is a single matrix change rather than a per-shape
 * calculation. Only the ghost cursors are drawn in screen space, because they
 * should not shrink when you zoom out.
 */

import { COLOR_HEX, NOTE_W, NOTE_H, findNode } from '../engine/BoardOT.js';
import { edgePoint } from '../utils/geom.js';

const PAPER = '#f2f0e9';
const DOT = '#d5d0c2';
const INK = '#24282d';
const ACCENT = '#e2a03f';
const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif';
const MONO = 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace';

const GRID = 28;
const TEXT_PAD_X = 13;
const TEXT_TOP = 33;

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export class CanvasRenderer {
  constructor({ canvas, viewport, engine, colorFor, getCursors }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.viewport = viewport;
    this.engine = engine;
    this.colorFor = colorFor || (() => '#888');
    this.getCursors = getCursors || (() => new Map());

    this.selection = new Set();
    this.hoverId = null;
    this.editingId = null;
    this.linkDraft = null; // { from: id, x, y } while a link is being dragged
    this.marquee = null; // world-space rect
    this.drag = null; // { ids: Set<string>, dx, dy } live offset not yet committed

    this.textCache = new Map();
    this.dpr = 1;
    this.width = 0;
    this.height = 0;
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === this.width && h === this.height && dpr === this.dpr) return;
    this.width = w;
    this.height = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
  }

  // ── geometry helpers that respect the uncommitted drag offset ──

  offsetOf(n) {
    if (this.drag && this.drag.ids.has(n.id)) return this.drag;
    return null;
  }

  rectOf(n) {
    const d = this.offsetOf(n);
    return { x: n.x + (d ? d.dx : 0), y: n.y + (d ? d.dy : 0), w: n.w, h: n.h };
  }

  // ── frame ─────────────────────────────────────────────────────

  draw() {
    this.resize();
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, this.width, this.height);

    this.drawGrid();

    const vp = this.viewport;
    ctx.save();
    ctx.translate(vp.x, vp.y);
    ctx.scale(vp.zoom, vp.zoom);

    const nodes = this.engine.view.nodes;
    this.drawLinks(ctx, nodes);
    for (const n of nodes) if (n.kind === 'note') this.drawNote(ctx, n);
    this.drawSelection(ctx, nodes);
    this.drawRemoteFocus(ctx, nodes);
    this.drawLinkDraft(ctx, nodes);
    this.drawMarquee(ctx);

    ctx.restore();
    this.drawCursors(ctx);
  }

  drawGrid() {
    const ctx = this.ctx;
    const vp = this.viewport;
    let step = GRID * vp.zoom;
    while (step < 15) step *= 2;

    const ox = ((vp.x % step) + step) % step;
    const oy = ((vp.y % step) + step) % step;

    const path = new Path2D();
    const size = 1.6;
    for (let x = ox - step; x < this.width + step; x += step) {
      for (let y = oy - step; y < this.height + step; y += step) {
        path.rect(x, y, size, size);
      }
    }
    ctx.fillStyle = DOT;
    ctx.fill(path);
  }

  // ── links ─────────────────────────────────────────────────────

  drawLinks(ctx, nodes) {
    for (const l of nodes) {
      if (l.kind !== 'link') continue;
      const a = findNode({ nodes }, l.from);
      const b = findNode({ nodes }, l.to);
      if (!a || !b) continue;

      const ra = this.rectOf(a);
      const rb = this.rectOf(b);
      const p1 = edgePoint(ra, rb);
      const p2 = edgePoint(rb, ra);
      const active = this.selection.has(l.id);
      this.strokeCurve(ctx, p1, p2, active ? ACCENT : 'rgba(36,40,45,0.30)', active ? 2 : 1.4, true);
    }
  }

  strokeCurve(ctx, p1, p2, color, width, arrow) {
    const z = this.viewport.zoom;
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy) || 1;
    const bow = Math.min(38, len * 0.1);
    const mx = (p1.x + p2.x) / 2 - (dy / len) * bow;
    const my = (p1.y + p2.y) / 2 + (dx / len) * bow;

    ctx.strokeStyle = color;
    ctx.lineWidth = width / z;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.quadraticCurveTo(mx, my, p2.x, p2.y);
    ctx.stroke();

    if (!arrow) return;
    const angle = Math.atan2(p2.y - my, p2.x - mx);
    const s = 9 / z;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(p2.x, p2.y);
    ctx.lineTo(p2.x - s * Math.cos(angle - 0.38), p2.y - s * Math.sin(angle - 0.38));
    ctx.lineTo(p2.x - s * Math.cos(angle + 0.38), p2.y - s * Math.sin(angle + 0.38));
    ctx.closePath();
    ctx.fill();
  }

  // ── notes ─────────────────────────────────────────────────────

  drawNote(ctx, n) {
    const r = this.rectOf(n);
    const z = this.viewport.zoom;

    ctx.fillStyle = 'rgba(44,38,28,0.10)';
    roundRect(ctx, r.x + 2.5, r.y + 3.5, r.w, r.h, 7);
    ctx.fill();

    ctx.fillStyle = COLOR_HEX[n.color] || COLOR_HEX.butter;
    roundRect(ctx, r.x, r.y, r.w, r.h, 7);
    ctx.fill();

    ctx.strokeStyle = 'rgba(24,20,14,0.10)';
    ctx.lineWidth = 1 / z;
    ctx.stroke();

    // Attribution stamp: the engine author's mark on every note.
    ctx.fillStyle = ACCENT;
    ctx.beginPath();
    ctx.arc(r.x + 12, r.y + 15, 3.4, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = 'rgba(36,40,45,0.42)';
    ctx.font = `500 8.5px ${MONO}`;
    ctx.textBaseline = 'middle';
    ctx.fillText('JEROME YOUNG', r.x + 20, r.y + 15.5);

    if (this.hoverId === n.id && !this.selection.has(n.id)) {
      ctx.strokeStyle = 'rgba(226,160,63,0.55)';
      ctx.lineWidth = 1.5 / z;
      roundRect(ctx, r.x - 1, r.y - 1, r.w + 2, r.h + 2, 8);
      ctx.stroke();
    }

    if (this.editingId === n.id) return; // the textarea owns the glyphs

    const body = n.text || '';
    if (!body) {
      ctx.fillStyle = 'rgba(36,40,45,0.28)';
      ctx.font = `italic 500 12px ${SANS}`;
      ctx.textBaseline = 'top';
      ctx.fillText('double-click to write', r.x + TEXT_PAD_X, r.y + TEXT_TOP);
      return;
    }

    const maxW = r.w - TEXT_PAD_X * 2;
    const lines = this.wrap(ctx, body, maxW, `500 13px ${SANS}`);

    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x + 6, r.y + TEXT_TOP - 3, r.w - 12, r.h - TEXT_TOP - 4);
    ctx.clip();
    ctx.fillStyle = 'rgba(28,26,20,0.88)';
    ctx.font = `500 13px ${SANS}`;
    ctx.textBaseline = 'top';
    const lh = 18.5;
    const max = Math.floor((r.h - TEXT_TOP - 6) / lh);
    for (let i = 0; i < Math.min(lines.length, max); i++) {
      ctx.fillText(lines[i], r.x + TEXT_PAD_X, r.y + TEXT_TOP + i * lh);
    }
    ctx.restore();
  }

  wrap(ctx, text, maxW, font) {
    const key = `${font}|${Math.round(maxW)}|${text}`;
    const hit = this.textCache.get(key);
    if (hit) return hit;

    const out = [];
    let line = '';
    for (const para of text.split('\n')) {
      line = '';
      for (const ch of para) {
        const test = line + ch;
        if (line && ctx.measureText(test).width > maxW) {
          out.push(line);
          line = ch === ' ' ? '' : ch;
        } else {
          line = test;
        }
      }
      out.push(line);
    }
    if (this.textCache.size > 500) this.textCache.clear();
    this.textCache.set(key, out);
    return out;
  }

  // ── selection and foreign focus ───────────────────────────────

  drawSelection(ctx, nodes) {
    const z = this.viewport.zoom;
    for (const id of this.selection) {
      const n = findNode({ nodes }, id);
      if (!n) continue;
      const r = this.rectOf(n);
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1.6 / z;
      ctx.setLineDash([5 / z, 4 / z]);
      ctx.strokeRect(r.x - 4, r.y - 4, r.w + 8, r.h + 8);
      ctx.setLineDash([]);
    }
  }

  drawRemoteFocus(ctx, nodes) {
    const z = this.viewport.zoom;
    for (const c of this.getCursors().values()) {
      if (!c.sel || !c.sel.length) continue;
      const color = c.color || this.colorFor(c.site);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2 / z;
      ctx.globalAlpha = 0.75;
      for (const id of c.sel) {
        const n = findNode({ nodes }, id);
        if (!n) continue;
        const r = this.rectOf(n);
        roundRect(ctx, r.x - 3, r.y - 3, r.w + 6, r.h + 6, 9);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }

  drawLinkDraft(ctx, nodes) {
    if (!this.linkDraft) return;
    const from = findNode({ nodes }, this.linkDraft.from);
    if (!from) return;
    const r = this.rectOf(from);
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const p = edgePoint(r, { x: this.linkDraft.x, y: this.linkDraft.y, w: 0, h: 0 });
    const z = this.viewport.zoom;

    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.6 / z;
    ctx.setLineDash([6 / z, 5 / z]);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(this.linkDraft.x, this.linkDraft.y);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = 'rgba(226,160,63,0.55)';
    ctx.beginPath();
    ctx.arc(cx, cy, 3 / z, 0, Math.PI * 2);
    ctx.fill();
  }

  drawMarquee(ctx) {
    if (!this.marquee) return;
    const m = this.marquee;
    const z = this.viewport.zoom;
    ctx.fillStyle = 'rgba(226,160,63,0.10)';
    ctx.fillRect(m.x, m.y, m.w, m.h);
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.2 / z;
    ctx.setLineDash([5 / z, 4 / z]);
    ctx.strokeRect(m.x, m.y, m.w, m.h);
    ctx.setLineDash([]);
  }

  // ── ghost cursors, in screen space ────────────────────────────

  drawCursors(ctx) {
    for (const c of this.getCursors().values()) {
      const p = this.viewport.worldToScreen(c.x, c.y);
      if (p.x < -40 || p.y < -40 || p.x > this.width + 40 || p.y > this.height + 40) continue;
      const color = c.color || this.colorFor(c.site);

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.scale(1.15, 1.15);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, 16);
      ctx.lineTo(4.1, 12.4);
      ctx.lineTo(7.2, 19);
      ctx.lineTo(9.9, 17.7);
      ctx.lineTo(6.9, 11.4);
      ctx.lineTo(11.9, 10.7);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 0.9;
      ctx.stroke();
      ctx.restore();

      const label = c.editing ? `${c.name} · typing` : c.name;
      ctx.font = `600 10px ${SANS}`;
      const tw = ctx.measureText(label).width;
      const bx = p.x + 15;
      const by = p.y + 17;
      ctx.fillStyle = color;
      roundRect(ctx, bx, by, tw + 12, 17, 4);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, bx + 6, by + 9);
    }
  }
}
