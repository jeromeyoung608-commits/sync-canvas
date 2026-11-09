import * as OT from '../src/engine/OT.js';

// TP2 check: three concurrent text ops must converge regardless of the order
// in which a replica happens to apply the two it did not author.
function scenario() {
  const base = 'hello world';
  const ops = [
    OT.diff(base, 'Xhello world'),
    OT.diff(base, 'hello worldY'),
    OT.diff(base, 'hell'),
  ];
  const sites = ['AAAAA', 'BBBBB', 'CCCCC'];

  // apply order 1: 0,1,2 ; order 2: 2,1,0 ; order 3: 1,2,0
  const orders = [
    [0, 1, 2],
    [2, 1, 0],
    [1, 2, 0],
    [2, 0, 1],
  ];

  const results = orders.map((order) => {
    let text = base;
    for (const i of order) {
      let op = ops[i];
      for (const j of order) {
        if (j >= i) break;
        op = OT.transform(op, ops[j], sites[i], sites[j]);
        if (!op) op = [];
      }
      text = OT.apply(text, op);
    }
    return text;
  });
  return results;
}

console.log(scenario());

// Random TP2: 3 concurrent edits, 6 permutations
let fails = 0;
const alphabet = 'abc ';
for (let n = 0; n < 3000; n++) {
  const base = Array.from({ length: 4 + ((Math.random() * 8) | 0) }, () => alphabet[(Math.random() * 3) | 0]).join('');
  const mutate = (s) => {
    const at = (Math.random() * (s.length + 1)) | 0;
    if (Math.random() < 0.5 || !s.length) return s.slice(0, at) + alphabet[(Math.random() * 3) | 0] + s.slice(at);
    const k = 1 + ((Math.random() * Math.min(3, s.length - at)) | 0);
    return s.slice(0, at) + s.slice(at + k);
  };
  const texts = [mutate(mutate(base)), mutate(mutate(base)), mutate(mutate(base))];
  const ops = texts.map((t) => OT.diff(base, t) || []);
  const sites = ['AAAAA', 'BBBBB', 'CCCCC'];
  const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const outs = perms.map((order) => {
    let text = base;
    for (const i of order) {
      let op = ops[i];
      for (const j of order) {
        if (j >= i) break;
        op = ops[j] ? OT.transform(op, ops[j], sites[i], sites[j]) : op;
        if (!op) break;
      }
      text = OT.apply(text, op || []);
    }
    return text;
  });
  if (new Set(outs).size > 1) {
    fails++;
    if (fails <= 3) console.log('TP2 fail', { base, texts, ops, outs });
  }
}
console.log('TP2 failures:', fails);
