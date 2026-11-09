# sync-canvas Engineering Test Report

| Item | Value |
| --- | --- |
| Version under test | sync-canvas 1.0.0 (`package.json`) |
| Report version | v1.0 |
| Test date | 2026-11-09 |
| Scope | `src/engine/*` (OT, BoardOT, SyncEngine, SocketProvider), `src/canvas/*`, `src/main.js` |
| Verdict | **PASS**: TP1 0 failures; convergence fuzz 60/60 and 300/300; two-tab browser E2E passed; 50-replica WebSocket chaos converged to one SHA-256; delivery-compliance checks passed |

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
| Python (chaos harness) | 3.14 |
| Python package | `websockets` 17.4 (the only non-stdlib dependency) |
| Node agent | v26.0.0 with the built-in global `WebSocket` |
| Network | T1-T6: local only, BroadcastChannel. T7: loopback WebSocket relay, 50 concurrent sockets |

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
| T7 | Distributed chaos | `python3 chaos/fuzzer.py --clients 50` | 50 real `SyncEngine` replicas over a WebSocket relay; random 3s socket cuts, a 10.5s sequencer outage, 249 text/insert/patch ops; final SHA-256 identical on all replicas, `unacked/queued/inbox` zero | Yes (exit code) |

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

### 4.6 T7 distributed chaos (50 replicas)

Command: `python3 chaos/fuzzer.py --clients 50 --seed 20261109` (also `npm run chaos`). The harness boots a Python room relay and a Python control API, then 50 real `SyncEngine` replicas inside `chaos/agent.mjs`. Every replica owns its socket, presence roster and timers; Python only drives the hostile network and verifies the result.

```text
[1/4] boot        50 engine replicas registered (266ms)
[2/4] seed        6 shared notes, hub=BOT-01
[3/4] chaos       57 outages, 2 handoff(s), 249 ops
[4/4] verify      255 revisions, 75 nodes, 1 unique hash(es)
[PASS] 50 clients converged in 2.9s (5f74f3c075d575e5..., rev 255)
```

| Metric | Value |
| --- | --- |
| Replicas | 50 / 50 reported, all online |
| Verdict | PASS (9/9 assertions) |
| Final revision | 255 |
| Final nodes | 75 |
| Unique SHA-256 | 1: `5f74f3c075d575e50187e2a73ea002f6567c21fc35e3efb0e40dc74bd7e27505` |
| Local operations | 249 (`txt`, `ins`, `set`) |
| Socket outages / reconnects | 57 / 57 (2.8-3.3s each) |
| Sequencer handoffs | 2 (`BOT-01` -> `BOT-02` at +10.3s, back at +14.5s) |
| Minimum online | 34 (2 observers never flap) |
| Relay deliveries | 184,632 frames, 84,706,527 bytes |
| Convergence after heal | 2.915s (3 stable polls) |
| Python vs Node hash | Byte-identical on all 50 replicas |

Counts vary between runs because the socket schedule races the reconnect timers; the verdict does not. Revision, node count and hash describe one operation stream and are compared across all 50 replicas within the same run, not against a fixed expectation.

The final hash is computed in Python from each replica's `doc.nodes` (key-sorted JSON, no whitespace), after all sockets are restored and anti-entropy has run. `hash-cross-check` additionally verifies Python's canonicalization against the Node digest.

#### 4.6.1 Defect found and fixed

The first short-outage run failed:

```text
[FAIL] 8 clients did not converge
  - no-unacknowledged-work: unacked=77, queued=0, inbox=0
```

- **Trigger**: the sequencer was cut for 3 seconds, shorter than the 8-second presence expiry. Ops sent during that window were dropped by the relay and stayed in `unacked`; no re-election and therefore no retransmit occurred. Later ops were diffed against a view containing the lost edits, and their `vv` named predecessors the sequencer never saw.
- **Fix 1**: the sequencer's warm-up replay now carries `replay: true`; clients retransmit `unacked` on that signal. A reconnect also retransmits `unacked` before flushing `outbox`.
- **Fix 2**: before sequencing, the hub checks every entry in the op's `vv` against `seen` and parks the op per site until missing predecessors arrive, then drains in causal order.
- **Verification**: the 8-client reproduction (`--clients 8 --chaos-seconds 8 --hub-outage 3`) now exits 0, and the 50-client run above converges with 2 handoffs and zero stranded work.

---

## 5. Assertions and failure criteria

### 5.1 Engine convergence gate (T1-T3)

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

### 5.2 T7 distributed chaos gate

`chaos/fuzzer.py` writes every assertion into the report and exits non-zero if any fails. A run is a PASS only when all nine hold:

| Assertion | Pass condition |
| --- | --- |
| `client-set-complete` | Exactly `--clients` unique replicas reported over the control API |
| `all-clients-online` | Every replica is online at snapshot time |
| `single-sequencer` | Exactly one `hub`, and it is the smallest site id (`BOT-01`) |
| `revision-agreement` | All replicas report the same `rev` |
| `document-hash-identical` | One unique SHA-256 across all replicas' `doc.nodes` |
| `no-unacknowledged-work` | `unacked`, `queued` and `inbox` are zero on every replica |
| `hash-cross-check` | Python's canonical SHA-256 equals the Node digest byte for byte |
| `chaos-actually-happened` | At least 6 outages, 6 reconnects and 60 local ops |
| `sequencer-handoff-exercised` | At least one observed hub change when `--hub-outage >= 8` |

The handoff assertion is only gated when the sequencer outage can outlast the 8-second presence expiry. A shorter outage (`--hub-outage 3`) deliberately tests lost-ack recovery instead of failover, so it is not required to hand off.

---

## 6. Coverage and known gaps

**Covered**

- Text TP1 (400 rounds), board convergence (60 and 300 rounds), offline recovery, sequencer takeover, real two-tab sync.
- Five operation families: insert, delete, property LWW, text OT, absolute-coordinate drag commit.
- A no-partition baseline, proving the disconnect injection is the only variable in the fuzz run.
- **Real WebSocket link**: T7 exercises `SocketProvider`-equivalent transport over a real WebSocket relay with 50 concurrent sockets and genuine socket closes.
- **Presence expiry and the 8-second window**: T7 runs the production 3s heartbeat / 8s expiry timing; the 10.5s sequencer outage forces expiry, re-election and a measured handoff.

**Not covered (by design or by constraint)**

- **Reload persistence**: persistence is intentionally absent (see README boundaries); a reload leaves the room, and nothing tests that.
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

### 7.3 Distributed chaos (T7)

```bash
python3 -m pip install websockets          # only Python dependency, version 17.4 used here
npm run chaos                              # 50 clients, 14s of chaos, JSON report
python3 chaos/fuzzer.py --clients 50 --seed 20261109 --verbose
python3 chaos/fuzzer.py --clients 8 --chaos-seconds 8 --hub-outage 3   # short-outage regression
python3 chaos/fuzzer.py --clients 50 --hub-outage 0                     # chaos without failover
python3 chaos/fuzzer.py --clients 50 --no-color                        # plain text for CI logs
```

The command exits 0 on PASS and 1 on FAIL. The report path defaults to `chaos/chaos-report.json`; `--report` overrides it. `--verbose` prints a role/online/hub line every poll, which is useful when a run fails to settle.

---

## 8. Conclusion

| Item | Verdict |
| --- | --- |
| TP1 text OT | Pass (0/400 failures) |
| Multi-replica convergence | Pass (60/60 and 300/300; including 1138 disconnects and 1688 handoffs) |
| Offline recovery | Pass (`unacked` returns to zero, `rev` agrees) |
| Two-tab browser | Pass (4 scenarios, 0 console errors) |
| 50-replica WebSocket chaos | Pass (9/9 assertions, 57 outages, 2 handoffs, one SHA-256 across all 50 replicas, 2.9s to converge) |
| TP2 diagnostic | Diverges as expected; recorded as architectural evidence |
| Delivery compliance | Pass (four attribution layers present, license present, no unrelated marks) |

**Signed off: tests pass, this report stands as the acceptance basis for 1.0.0.**
