/**
 * Identifier helpers.
 *
 * A site id is a 5-character base36 string. It doubles as the tie-breaker for
 * concurrent inserts, so it is compared lexicographically everywhere.
 */

export function makeSite() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 5; i++) out += abc[(Math.random() * abc.length) | 0];
  return out;
}

export function makeNodeId(kind = 'n') {
  return `${kind}${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;
}

export function makeRoom() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += abc[(Math.random() * abc.length) | 0];
  return `${out.slice(0, 3)}-${out.slice(3)}`;
}
