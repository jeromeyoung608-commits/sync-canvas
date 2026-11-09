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
 * Board operations and their transformation rules.
 *
 * The document is a single ordered list of nodes. Order is z-order: links are
 * painted under notes because the renderer separates them, not because of list
 * position. Four operations cover the whole product surface:
 *
 *   { t: 'ins', i, n }          insert a node at list index i
 *   { t: 'del', i, id }         remove the node with this id (i is for OT only)
 *   { t: 'set', id, p, ts }     patch properties; last-writer-wins per key
 *   { t: 'txt', id, o }         character-level edit of node.text
 *
 * Deletion targets by id, not by index. Indices drift under concurrency, ids
 * never do — so the transform still tracks index arithmetic while application
 * stays exact.
 */

import * as OT from './OT.js';

export const NOTE_W = 196;
export const NOTE_H = 128;

export const NOTE_COLORS = ['butter', 'mint', 'blush', 'sky', 'lilac'];

export const COLOR_HEX = {
  butter: '#f7e3a8',
  mint: '#cfe8d8',
  blush: '#f6d3c6',
  sky: '#cfdff3',
  lilac: '#e4daf3',
};

export function emptyDoc() {
  return { nodes: [] };
}

export function findNode(doc, id) {
  // Boards stay small; a linear scan beats maintaining an index that every
  // operation would have to invalidate.
  for (const n of doc.nodes) if (n.id === id) return n;
  return null;
}

export function indexOfNode(doc, id) {
  for (let i = 0; i < doc.nodes.length; i++) if (doc.nodes[i].id === id) return i;
  return -1;
}

export const ops = {
  ins: (i, node) => ({ t: 'ins', i, n: node }),
  del: (i, id) => ({ t: 'del', i, id }),
  set: (id, patch, ts = Date.now()) => ({ t: 'set', id, p: patch, ts }),
  txt: (id, textOp) => ({ t: 'txt', id, o: textOp }),
};

/** Mutates the document. Unknown targets are quietly ignored (tombstones). */
export function apply(doc, op) {
  if (!op) return false;
  switch (op.t) {
    case 'ins': {
      const node = { ...op.n };
      const at = Math.max(0, Math.min(op.i, doc.nodes.length));
      doc.nodes.splice(at, 0, node);
      return true;
    }
    case 'del': {
      const i = indexOfNode(doc, op.id);
      if (i === -1) return false;
      doc.nodes.splice(i, 1);
      return true;
    }
    case 'set': {
      const node = findNode(doc, op.id);
      if (!node) return false;
      Object.assign(node, op.p);
      return true;
    }
    case 'txt': {
      const node = findNode(doc, op.id);
      if (!node) return false;
      node.text = OT.apply(node.text ?? '', op.o);
      return true;
    }
    default:
      return false;
  }
}

/** Deterministic total order for last-writer-wins: timestamp, then site id. */
function wins(a, aSite, b, bSite) {
  if (a.ts !== b.ts) return a.ts > b.ts;
  return aSite > bSite;
}

/**
 * Transform `a` against an already-applied `b`.
 * Returns the transformed op, or null when the op has been made meaningless
 * (the target is gone, or a newer write already covered it).
 */
export function transform(a, b, aSite, bSite) {
  if (!a || !b) return a;

  // Never mutate the input: an op object is shared between the log, the wire
  // message and any number of transform passes.
  const op = { ...a };
  if (a.p) op.p = { ...a.p };

  switch (op.t) {
    case 'ins': {
      if (b.t === 'ins') {
        if (b.i < op.i) op.i += 1;
        else if (b.i === op.i && !(aSite < bSite)) op.i += 1;
      } else if (b.t === 'del' && b.i < op.i) {
        op.i -= 1;
      }
      return op;
    }

    case 'del': {
      if (b.t === 'del') {
        if (b.id === op.id) return null;
        if (b.i < op.i) op.i -= 1;
      } else if (b.t === 'ins' && b.i <= op.i) {
        op.i += 1;
      }
      return op;
    }

    case 'set': {
      if (b.t === 'del' && b.id === op.id) return null;
      if (b.t === 'set' && b.id === op.id) {
        for (const key of Object.keys(op.p)) {
          if (!(key in b.p)) continue;
          if (wins({ ts: op.ts }, aSite, { ts: b.ts }, bSite)) continue;
          delete op.p[key];
        }
        if (Object.keys(op.p).length === 0) return null;
      }
      return op;
    }

    case 'txt': {
      if (b.t === 'del' && b.id === op.id) return null;
      if (b.t === 'txt' && b.id === op.id) {
        const o = OT.transform(op.o, b.o, aSite, bSite);
        return o && o.length ? { ...op, o } : null;
      }
      return op;
    }

    default:
      return op;
  }
}

/** Short label for the operation stream. */
export function label(op) {
  switch (op.t) {
    case 'ins':
      return op.n.kind === 'link' ? 'link' : 'note';
    case 'del':
      return 'delete';
    case 'set':
      return Object.keys(op.p).join(',');
    case 'txt':
      return 'text';
    default:
      return op.t;
  }
}

/** Compact payload preview for the operation stream. */
export function preview(op) {
  switch (op.t) {
    case 'ins':
      return op.n.kind === 'link' ? `${op.n.from} → ${op.n.to}` : `"${(op.n.text || 'empty').slice(0, 18)}"`;
    case 'del':
      return op.id;
    case 'set':
      return Object.entries(op.p)
        .map(([k, v]) => `${k}=${typeof v === 'number' ? Math.round(v) : v}`)
        .join(' ');
    case 'txt':
      return OT.describe(op.o);
    default:
      return '';
  }
}
