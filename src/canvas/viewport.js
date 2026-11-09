/**
 * Camera for the board: a translation plus a uniform scale.
 *
 * Keeping the camera in one place means hit-testing, text input placement and
 * the ghost cursors all agree on the same mapping — a surprisingly common
 * source of drift in canvas apps.
 */

import { clamp } from '../utils/geom.js';

export class Viewport {
  constructor(init = {}) {
    this.x = init.x ?? 0;
    this.y = init.y ?? 0;
    this.zoom = init.zoom ?? 1;
    this.min = init.min ?? 0.22;
    this.max = init.max ?? 2.6;
    this.listeners = new Set();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  touch() {
    for (const fn of this.listeners) fn(this);
  }

  screenToWorld(sx, sy) {
    return { x: (sx - this.x) / this.zoom, y: (sy - this.y) / this.zoom };
  }

  worldToScreen(wx, wy) {
    return { x: wx * this.zoom + this.x, y: wy * this.zoom + this.y };
  }

  panBy(dx, dy) {
    this.x += dx;
    this.y += dy;
    this.touch();
  }

  /** Zoom while keeping the world point under (sx, sy) pinned to the cursor. */
  zoomAt(sx, sy, factor) {
    const next = clamp(this.zoom * factor, this.min, this.max);
    if (next === this.zoom) return;
    const w = this.screenToWorld(sx, sy);
    this.zoom = next;
    this.x = sx - w.x * next;
    this.y = sy - w.y * next;
    this.touch();
  }

  fit(bounds, width, height, pad = 120) {
    if (!bounds || bounds.w <= 0 || bounds.h <= 0) return;
    const z = clamp(
      Math.min((width - pad * 2) / bounds.w, (height - pad * 2) / bounds.h),
      this.min,
      1.2,
    );
    this.zoom = z;
    this.x = width / 2 - (bounds.x + bounds.w / 2) * z;
    this.y = height / 2 - (bounds.y + bounds.h / 2) * z;
    this.touch();
  }
}
