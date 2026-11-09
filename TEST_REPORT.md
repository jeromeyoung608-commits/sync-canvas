# sync-canvas Engineering Test Report

| Item | Value |
| --- | --- |
| Version under test | sync-canvas 1.0.0 (`package.json`) |
| Report version | v1.0 |
| Test date | 2026-11-09 |
| Scope | `src/engine/*` (OT, BoardOT, SyncEngine, SocketProvider), `src/canvas/*`, `src/main.js` |
| Verdict | **PASS**: TP1 0 failures; convergence fuzz 60/60 and 300/300; two-tab browser E2E passed; delivery-compliance checks passed |

---

## 1. Objectives

This project is a collaborative canvas with a hand-written OT engine. The tests only care about four things that can break:

1. **Text OT satisfies TP1**: two concurrent edits produce the same result regardless of application order.
2. **Replicas converge**: under random concurrency, random disconnects and random sequencer handoffs, every replica ends with identical `doc.nodes`, `rev` and `unacked`.
3. **Disconnects are recoverable**: ops missed while offline must be restored by anti-entropy (`requestSync`), not by luck.
4. **It actually runs in a browser**: two real tabs sync over BroadcastChannel and the UI reports no errors.

TP2 (three-way concurrent text OT) is **not** a gate. It is a model boundary of position-based OT, used to justify why the architecture needs a single-writer sequencer (see 4.3).

---

## 2. Environment

| Item | Value |
| --- | --- |
| OS | macOS (Apple Silicon) |
| Node.js | v26.0.0 |
| Static server | `python3 -m http.server 8098` |
| Browser | Chrome for Testing (Playwright cache `chromium-1254`), headless |
| Browser automation | `playwright-core@1.55.0` (ad-hoc acceptance script, not a project dependency) |
| Network | Local only: BroadcastChannel; no WebSocket, no external requests |

---

## 3. Test inventory

| ID | Level | Entry point | Core assertions | Gate |
| --- | --- | --- | --- | --- |
| T1 | Property test | Runs automatically inside `tests/fuzz.mjs` | TP1: `apply(apply(base,b),a') === apply(apply(base,a),b')`, 400 random rounds | Yes (exit code) |
| T2 | Convergence fuzz | `node tests/fuzz.mjs [runs]` | After 60 or 300 rounds all replicas share the same `doc.nodes` JSON, the same `rev`, and `unacked === 0` | Yes |
| T3 | No-partition baseline | `node tests/fuzz.mjs 60 --nopart` | Same assertion with disconnect injection disabled (`netOutages` must be 0) | Yes |
| T4 | TP2 diagnostic | `node tests/tp2.mjs` | Divergence count over 3000 three-way groups and 6 application orders | No (divergence expected; recorded only) |
| T5 | Browser E2E | Playwright two-tab script (see 7.2) | First-paint parity, cross-tab sync, offline merge, sequencer takeover, zero console errors | Yes (script exit code) |
| T6 | Compliance static checks | `node --check` + keyword scans | Syntax passes; copyright header / console banner / status bar / canvas stamp present; zero unrelated marks such as `trae` | Manual |

---

## 4. Results

### 4.1 T1 text TP1

```text
text TP1: ✓ passed
```

400 random rounds (base length 6–15, random insert/delete, two concurrent ops): 0 failures.

### 4.2 T2/T3 convergence fuzz

Each round uses 2–4 random peers, 90 random steps of `ins / del / set / txt`, a 5% chance per step of flipping a peer's online state (a guard always keeps at least one online), then brings everyone online and runs two `requestSync` rounds.

| Command | Result | Avg nodes | Disconnects | Sequencer handoffs |
| --- | --- | --- | --- | --- |
| `node tests/fuzz.mjs 60` | `60/60 runs identical` | 8 | 235 | 339 |
| `node tests/fuzz.mjs 60 --nopart` | `60/60 runs identical` | 9 | 0 | 60 |
| `node tests/fuzz.mjs 300` | `300/300 runs identical` | 8 | 1138 | 1688 |

Notes:

- Counts vary on every run (for example the 300-round disconnect count lands between roughly 1100 and 1200); **the verdict does not**.
- The 60 handoffs under `--nopart` are initial elections, one per round, not outages.
- Any failure makes the process exit non-zero (`tests/fuzz.mjs:322`).

### 4.3 T4 TP2 diagnostic (divergence expected)

```text
TP2 failures: 2763   (out of 3000 groups)
```

With one base text, three concurrent text ops and 6 application orders, about 92% of combinations end in different results. This is an inherent property of position-based OT with more than two concurrent ops, not an implementation defect; it is exactly the justification for "ordering must go through a single hub" documented in the [README](README.md). The script prints statistics only and sets no failure gate.

### 4.4 T5 two-tab browser E2E

Two pages in the same browser context join one room (`#E2E****`); engine state is read through `window.__sync`:

```json
BOOT   {"a":{"site":"Q7G57","role":"client","rev":7,"nodes":7},
        "b":{"site":"55KF3","role":"hub","rev":7,"nodes":7},"sameJson":true}
SYNC   {"aRev":8,"bRev":8,"nodes":[8,8],"sameJson":true,"unacked":[0,0]}
HEAL   {"aRev":10,"bRev":10,"nodes":[10,10],"sameJson":true,"unacked":[0,0],
        "roles":["client","hub"]}
HANDOFF{"tookOver":"hub","rolesAfter":["client","hub"],"sameJson":true}
CONSOLE_ERRORS []
E2E_PASS
```

Four scenarios:

1. **First-paint seeding**: the hub seeds 7 nodes; both sides show `rev=7`, 7 nodes and byte-identical document JSON; roles split into 1 hub + 1 client.
2. **Cross-tab sync**: A inserts a note; both sides move to `rev=8` and `unacked` returns to 0.
3. **Offline merge**: the client calls `setOnline(false)`, both sides write a node (the client's write applies locally), then it comes back online and calls `requestSync()`; both sides reach `rev=10`, 10 nodes, identical JSON, `unacked=0`.
4. **Sequencer takeover**: with the hub offline the client recomputes peers and becomes `hub`; when the hub returns, re-election restores the smallest site as `hub` and both documents remain byte-identical.

### 4.5 T6 compliance static checks

| Check | Result |
| --- | --- |
| `node --check` (`src/main.js`, `src/engine/*`, `src/canvas/CanvasRenderer.js`) | All pass |
| Copyright header (`Copyright (c) 2026 Jerome Young`) | Present in `OT.js`, `BoardOT.js`, `SyncEngine.js`, `SocketProvider.js` |
| Console attribution | Prints the `sync-canvas` badge and licensing contact at startup |
| Status bar attribution | `ENGINE BY JEROME YOUNG` visible |
| Canvas attribution | Gold dot + `JEROME YOUNG` at the top-left of every note |
| Unrelated third-party marks (`trae / marscode / doubao / bytedance / coze`) | 0 matches |
| License file | `LICENSE` present (full AGPL-3.0 text, 34,523 bytes) and referenced by the source headers |

---

## 5. Assertions and failure criteria

"Convergence" at `tests/fuzz.mjs:234-238` requires all three conditions at once:

```js
const docs = peers.map((p) => JSON.stringify(p.engine.doc.nodes));
const ok = docs.every((d) => d === head) &&
  peers.every((p) => p.engine.unacked.length === 0) &&
  peers.every((p) => p.engine.rev === peers[0].engine.rev);
```

- `doc.nodes` byte-identical: same order, same properties, same text — not merely the same count.
- `unacked === 0`: no local operation is left waiting forever for an acknowledgement.
- `rev` equal: the global counter has not drifted between replicas.

On failure, `--verbose` prints each peer's `role / rev / unacked / inbox / outbox` plus the first diverging node.

---

## 6. Coverage and known gaps

**Covered**

- Text TP1 (400 rounds), board convergence (60 and 300 rounds), offline recovery, sequencer takeover, real two-tab sync.
- Five operation families: insert, delete, property LWW, text OT, absolute-coordinate drag commit.
- A no-partition baseline, proving the disconnect injection is the only variable in the fuzz run.

**Not covered (by design or by constraint)**

- **Real WebSocket link**: the fuzz harness uses an in-memory toy network; `SocketProvider`'s `WebSocketLink` is only exercised manually.
- **Reload persistence**: persistence is intentionally absent (see README boundaries); a reload leaves the room, and nothing tests that.
- **Presence expiry and the 8-second window**: the E2E drives election through `setPeers` / `setOnline`, without waiting for the real 8-second expiry.
- **Visual regression**: no pixel snapshot diffing; layout and attribution were checked by manual screenshots.
- **Performance**: no large-document or long-session load test; the fuzz `drain()` cap of 50,000 messages only prevents infinite loops.
- **Cross-browser**: Chromium only; Firefox/Safari BroadcastChannel behavior untested.
- **TP2**: not a gate; divergence is expected.

---

## 7. Reproduction

### 7.1 Engine layer

```bash
npm test                              # = node tests/fuzz.mjs, 60 rounds including TP1
node tests/fuzz.mjs 300               # 300 rounds
node tests/fuzz.mjs 60 --nopart       # disable disconnect injection
STEPS=120 node tests/fuzz.mjs 60      # change steps per round from 90 to 120
node tests/fuzz.mjs --verbose         # print replica diffs on failure (first 8 rounds print automatically)
node tests/tp2.mjs                    # TP2 diagnostic, prints divergence count, no exit-code gate
```

### 7.2 Browser E2E

```bash
python3 -m http.server 8098
# in a second terminal, run the Playwright two-tab script
node <two-tab-script>                 # both pages join the same #ROOM and read window.__sync
```

The E2E depends on the debug handle `window.__sync = { engine, provider, viewport, presence, interaction, room, site }` (`src/main.js:120`); every assertion reads through that handle rather than reverse-engineering the DOM.

---

## 8. Conclusion

| Item | Verdict |
| --- | --- |
| TP1 text OT | Pass (0/400 failures) |
| Multi-replica convergence | Pass (60/60 and 300/300; including 1138 disconnects and 1688 handoffs) |
| Offline recovery | Pass (`unacked` returns to zero, `rev` agrees) |
| Two-tab browser | Pass (4 scenarios, 0 console errors) |
| TP2 diagnostic | Diverges as expected; recorded as architectural evidence |
| Delivery compliance | Pass (four attribution layers present, license present, no unrelated marks) |

**Signed off: tests pass, this report stands as the acceptance basis for 1.0.0.**
