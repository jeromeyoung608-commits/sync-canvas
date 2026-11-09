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
 * Character-level operational transformation for a single text field.
 *
 * An operation is an ordered list of components describing an edit against a
 * known base string:
 *
 *   { t: 'r', n }   keep n characters
 *   { t: 'i', s }   insert the string s
 *   { t: 'd', n }   drop n characters
 *
 * Operations produced by `diff` always cover the whole string, which keeps the
 * transform below simple: two ops over the same base can be walked in lockstep.
 */

export const RETAIN = 'r';
export const INSERT = 'i';
export const DELETE = 'd';

const MAX_DIFF = 4000; // beyond this we replace wholesale

export function retain(n) {
  return { t: RETAIN, n };
}

export function insert(s) {
  return { t: INSERT, s };
}

export function remove(n) {
  return { t: DELETE, n };
}

/** Apply `op` to `text`. Tolerates ops that stop short of the end. */
export function apply(text, op) {
  if (!op || !op.length) return text;
  let i = 0;
  const out = [];
  for (const c of op) {
    if (c.t === RETAIN) {
      out.push(text.slice(i, i + c.n));
      i += c.n;
    } else if (c.t === INSERT) {
      out.push(c.s);
    } else {
      i += c.n;
    }
  }
  if (i < text.length) out.push(text.slice(i));
  return out.join('');
}

/** Merge adjacent components of the same kind and drop no-ops. */
export function normalize(op) {
  const out = [];
  for (const c of op) {
    if (c.t === RETAIN && c.n === 0) continue;
    if (c.t === DELETE && c.n === 0) continue;
    if (c.t === INSERT && !c.s) continue;
    const last = out[out.length - 1];
    if (!last) {
      out.push({ ...c });
      continue;
    }
    if (last.t === c.t) {
      if (c.t === INSERT) last.s += c.s;
      else last.n += c.n;
      continue;
    }
    out.push({ ...c });
  }
  return out;
}

/**
 * Minimal operation turning `before` into `after`, by trimming the common
 * prefix and suffix. This is what a text field produces on every keystroke.
 */
export function diff(before, after) {
  if (before === after) return null;
  if (before.length > MAX_DIFF || after.length > MAX_DIFF) {
    return [remove(before.length), insert(after)];
  }

  const max = Math.min(before.length, after.length);
  let start = 0;
  while (start < max && before[start] === after[start]) start++;

  let end = 0;
  while (end < max - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;

  const removed = before.length - start - end;
  const added = after.slice(start, after.length - end);

  const op = [];
  if (start) op.push(retain(start));
  if (removed) op.push(remove(removed));
  if (added.length) op.push(insert(added));
  return normalize(op);
}

/**
 * Transform `a` (the op that arrives later) against `b` (an op that has
 * already been applied). Returns an op that produces the same result when
 * applied on top of `b`'s effect.
 *
 * `aSite` / `bSite` only matter for the tie-break: when both ops insert at the
 * exact same offset, the order must be decided identically on every client or
 * the replicas diverge. Lower site id wins the left slot.
 */
export function transform(a, b, aSite = '', bSite = '') {
  const A = a.map((c) => ({ ...c }));
  const B = b.map((c) => ({ ...c }));
  const out = [];
  let ia = 0;
  let ib = 0;

  const emit = (c) => {
    if (c.t !== INSERT && c.n === 0) return;
    const last = out[out.length - 1];
    if (!last || last.t !== c.t) {
      out.push({ ...c });
      return;
    }
    if (c.t === INSERT) last.s += c.s;
    else last.n += c.n;
  };

  while (ia < A.length || ib < B.length) {
    const ca = A[ia];
    const cb = B[ib];

    // `b` inserted text that a's edits have to move past.
    if (cb && cb.t === INSERT) {
      if (ca && ca.t === INSERT && aSite < bSite) {
        emit(ca);
        ia++;
      } else {
        emit(retain(cb.s.length));
        ib++;
      }
      continue;
    }

    // `a` inserts where `b` did nothing special.
    if (ca && ca.t === INSERT) {
      emit(ca);
      ia++;
      continue;
    }

    if (!ca) break;

    if (!cb) {
      // `b` exhausted; a's tail still has to run (normally both end together).
      emit(ca);
      ia++;
      continue;
    }

    const k = Math.min(ca.n, cb.n);
    ca.n -= k;
    cb.n -= k;

    if (cb.t === RETAIN) {
      emit(ca.t === DELETE ? remove(k) : retain(k));
    }
    // if b deleted these characters, a's intent over them is moot: emit nothing.

    if (ca.n === 0) ia++;
    if (cb.n === 0) ib++;
  }

  return normalize(out);
}

/**
 * Map a caret offset through an operation. `collapseInside` decides whether a
 * caret sitting inside a deleted range jumps to its start (true) or end.
 */
export function mapIndex(pos, op) {
  if (!op || !op.length) return pos;
  let base = 0;
  let shift = 0;

  for (const c of op) {
    if (c.t === RETAIN) {
      if (pos < base + c.n) return pos + shift;
      base += c.n;
    } else if (c.t === INSERT) {
      if (pos >= base) shift += c.s.length;
    } else {
      if (pos < base + c.n) return base + shift;
      base += c.n;
      shift -= c.n;
    }
  }
  return pos + shift;
}

/** Human readable one-liner, used by the op stream in the inspector. */
export function describe(op) {
  if (!op || !op.length) return 'noop';
  return op
    .map((c) => {
      if (c.t === RETAIN) return `~${c.n}`;
      if (c.t === DELETE) return `-${c.n}`;
      const s = c.s.length > 12 ? `${c.s.slice(0, 12)}…` : c.s;
      return `+${JSON.stringify(s)}`;
    })
    .join(' ');
}
