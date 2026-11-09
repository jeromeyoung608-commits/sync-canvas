/**
 * A textarea that sits exactly on top of the note being edited.
 *
 * The interesting part is not the overlay, it is the caret. When a remote
 * character-level edit lands mid-sentence, the local text is replaced and the
 * caret is pushed through `OT.mapIndex`, so typing never jumps to the end of
 * the line just because somebody else typed somewhere else.
 */

import * as OT from '../engine/OT.js';
import * as BoardOT from '../engine/BoardOT.js';

const PAD_X = 13;
const PAD_TOP = 33;
const PAD_BOTTOM = 12;

export class TextEditor {
  constructor({ layer, engine, viewport, renderer, bus }) {
    this.engine = engine;
    this.viewport = viewport;
    this.renderer = renderer;
    this.bus = bus;
    this.id = null;
    this.text = '';

    this.el = document.createElement('textarea');
    this.el.className = 'note-editor';
    this.el.spellcheck = false;
    this.el.autocapitalize = 'off';
    this.el.setAttribute('autocomplete', 'off');
    this.el.style.display = 'none';
    layer.appendChild(this.el);

    this.el.addEventListener('input', () => this.onInput());
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    });
    this.el.addEventListener('blur', () => this.close());

    bus.on('edit-note', (id) => this.open(id));
    bus.on('end-editing', () => this.close());
    bus.on('engine:changed', () => this.sync());
    viewport.onChange(() => this.sync());
  }

  open(id) {
    const node = BoardOT.findNode(this.engine.view, id);
    if (!node || node.kind !== 'note') return;

    if (this.id && this.id !== id) this.close();
    this.id = id;
    this.text = node.text || '';
    this.el.value = this.text;
    this.el.style.display = 'block';
    this.renderer.editingId = id;
    this.bus.emit('editing', id);
    this.layout(node);

    requestAnimationFrame(() => {
      if (!this.id) return;
      this.el.focus();
      const end = this.el.value.length;
      this.el.setSelectionRange(end, end);
    });
  }

  close() {
    if (!this.id) return;
    this.id = null;
    this.el.style.display = 'none';
    this.renderer.editingId = null;
    this.bus.emit('editing', null);
    this.el.blur();
  }

  onInput() {
    if (!this.id) return;
    const next = this.el.value;
    if (next === this.text) return;
    const op = OT.diff(this.text, next);
    this.text = next;
    if (op) this.engine.local(BoardOT.ops.txt(this.id, op));
  }

  /** Pull remote text into the field without disturbing the caret. */
  sync() {
    if (!this.id) return;
    const node = BoardOT.findNode(this.engine.view, this.id);
    if (!node) {
      this.close();
      return;
    }

    const remote = node.text || '';
    if (remote !== this.text) {
      const op = OT.diff(this.text, remote);
      const caret = this.el.selectionStart ?? this.text.length;
      const tail = this.el.selectionEnd ?? caret;

      this.text = remote;
      this.el.value = remote;

      const c2 = OT.mapIndex(caret, op);
      let t2 = OT.mapIndex(tail, op);
      if (t2 < c2) t2 = c2;
      this.el.setSelectionRange(c2, t2);
    }

    this.layout(node);
  }

  layout(node) {
    const z = this.viewport.zoom;
    const p = this.viewport.worldToScreen(node.x, node.y);
    const s = this.el.style;
    s.left = `${p.x}px`;
    s.top = `${p.y}px`;
    s.width = `${node.w * z}px`;
    s.height = `${node.h * z}px`;
    s.paddingLeft = `${PAD_X * z}px`;
    s.paddingRight = `${PAD_X * z}px`;
    s.paddingTop = `${PAD_TOP * z}px`;
    s.paddingBottom = `${PAD_BOTTOM * z}px`;
    s.fontSize = `${13 * z}px`;
    s.lineHeight = `${18.5 * z}px`;
  }
}
