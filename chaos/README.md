# sync-canvas Distributed Chaos Test

A 50-replica chaos run for the sync-canvas OT engine: random socket cuts,
forced sequencer failover, a storm of character-level text and insert
operations, then one SHA-256 per replica and a JSON report.

The run is driven by Python (`asyncio` + `websockets`). The engine under test
is the real JavaScript `SyncEngine` shipped in `src/engine`, hosted by a thin
Node agent.

```bash
python3 -m pip install websockets     # the only Python dependency
npm run chaos                         # 50 clients, 14s of chaos
```

or with explicit knobs:

```bash
python3 chaos/fuzzer.py \
  --clients 50 \
  --chaos-seconds 14 \
  --hub-outage 10.5 \
  --seed 20261109 \
  --report chaos/chaos-report.json
```

Requirements: Python 3.10+, Node 22+ (global `WebSocket`), macOS or Linux.
No npm packages. The Node agent imports the project's ES modules directly;
there is no build step.

## What a run looks like

```
[1/4] boot        50 engine replicas registered (266ms)
[2/4] seed        6 shared notes, hub=BOT-01
[3/4] chaos       57 outages, 2 handoff(s), 249 ops
[4/4] verify      255 revisions, 75 nodes, 1 unique hash(es)
[PASS] BOT-01  rev 255  nodes 75  hash 5f74f3c075d5
...
[PASS] BOT-50  rev 255  nodes 75  hash 5f74f3c075d5
[PASS] 50 clients converged in 2.9s (5f74f3c075d575e5..., rev 255)
report -> chaos/chaos-report.json
```

When stdout is a TTY every `[PASS]` line is green. The 50 per-client lines are
the proof that each replica, not just a summary, holds the same document.

## Architecture

```
                       Python: chaos/fuzzer.py
  +---------------------------------------------------------------+
  |  room relay (websocket)          control API (websocket)      |
  |  JSON passthrough, one room      commands in, snapshots out   |
  +----^----^----^--------------------------^--------------------+
       |    |    |  50 engine sockets      |  1 control socket
       |    |    |                         |
  +----+----+----+-------------------+     |
  |  Node: chaos/agent.mjs            |-----+
  |  50 x SyncEngine replicas         |
  |  BOT-01 .. BOT-50                 |
  +-----------------------------------+
```

Why the engine runs in Node:

- The thing being tested is the shipped `src/engine` module. Re-implementing
  OT in Python would prove that a second implementation agrees with itself.
- Python owns everything around the engine: the hostile network, the outage
  schedule, the operation storm, the control API, the final hashing and the
  assertions. That is the chaos experiment.
- The 50 replicas live in one Node process only to keep the run laptop-sized.
  Isolation is at the network layer: every replica owns its socket, provider,
  presence roster and timers. Killing the Node process would kill all 50, so
  process crashes are not part of this experiment.

The relay is a dumb room: it forwards a frame to every other socket in the
room and never echoes to the sender, matching `BroadcastChannel`. One routing
rule is added for scale: a `sync-ops` frame that carries `to` is delivered only
to that site. The engine already filters such frames; routing them at the relay
keeps a 50-peer anti-entropy round linear instead of 50 x 49 full-log
broadcasts.

## Chaos model

| Phase | Duration | What happens |
| --- | --- | --- |
| Boot | until all 50 report | Replicas connect, elect `BOT-01`, wait for `rev = 0` on every side |
| Seed | until all agree | The sequencer inserts six shared hot notes (`seed-01` .. `seed-06`) |
| Chaos | 14 s | Random outages, one sequencer kill, continuous text/insert storm |
| Heal | immediate | Every socket is restored, then anti-entropy runs |
| Verify | until quiescent | 3 stable polls, snapshot, SHA-256 in Python, JSON report |

During the chaos window:

- Every ~0.9 s, 3 to 5 random replicas lose their socket for 2.8 to 3.3 s.
  The fuzzer always keeps at least 12 online.
- At t+3.6 s the current sequencer (`BOT-01`) is cut for 10.5 s. Presence
  expires after 8 s, so `BOT-02` takes over. `BOT-01` returns at the end of the
  chaos window and reclaims the role. Both transitions are measured.
- Every 180 ms, 1 to 2 online replicas each generate 1 to 3 operations:
  character-level `txt` edits against the six hot notes (so concurrent text OT
  collides by design), `ins` of new notes, and LWW property `set` patches.
- Two replicas (`BOT-49`, `BOT-50`) never flap. They are the stable witnesses
  that expire the dead sequencer. Everyone else is fair game. Without a stable
  witness, 50 independent reconnect timers can keep resetting the dead hub's
  presence lease and make the failover assertion a coin flip.

Every disconnect is a real socket close (`engine.setOnline(false)`), not a
message filter. Reconnects call `engine.setOnline(true)`, which retransmits
unacknowledged work and runs anti-entropy.

## Assertions

The report is a PASS only if all of these hold:

| Assertion | Meaning |
| --- | --- |
| `client-set-complete` | Exactly 50 unique replicas reported |
| `all-clients-online` | Every replica is online at snapshot time |
| `single-sequencer` | Exactly one `hub`, and it is `BOT-01` |
| `revision-agreement` | All replicas report the same `rev` |
| `document-hash-identical` | One unique SHA-256 over each replica's `doc.nodes` |
| `no-unacknowledged-work` | `unacked`, `queued` and `inbox` are all zero everywhere |
| `hash-cross-check` | Python's SHA-256 equals the Node digest on every replica |
| `chaos-actually-happened` | At least 6 outages, 6 reconnects and 60 local ops |
| `sequencer-handoff-exercised` | At least one observed hub change |

The final hash is computed in Python from the document pulled over the control
API, using key-sorted JSON with no whitespace. The Node digest exists only for
fast polling during the run; `hash-cross-check` proves both canonicalizations
agree byte for byte.

## Report schema

`chaos/chaos-report.json`:

```json
{
  "schema": "sync-canvas/chaos-report@1",
  "verdict": "PASS",
  "summary": {
    "clients": 50,
    "convergenceMs": 2915,
    "rev": 255,
    "nodes": 75,
    "uniqueDocHashes": 1,
    "docHash": "5f74f3c0...",
    "localOps": 249,
    "outages": 57,
    "reconnects": 57,
    "hubHandoffs": 2,
    "minOnline": 34,
    "hashCrossCheck": true,
    "relay": { "framesIn": 14858, "framesOut": 184632, "bytesOut": 84706527 }
  },
  "config": { "...": "..." },
  "assertions": [{ "name": "...", "pass": true, "detail": "..." }],
  "timeline": [{ "event": "hub-kill", "atMs": 3601, "site": "BOT-01" }],
  "clients": [{ "site": "BOT-01", "rev": 255, "docHashPython": "...", "...": "..." }],
  "firstDivergence": null,
  "environment": { "python": "...", "node": "v26.0.0", "websockets": "..." }
}
```

On failure, `firstDivergence` names the first node that differs between two
replicas, with the two node values (text truncated to 80 characters). The
process exits non-zero.

## Result from the checked-in run

Seed `20261109`, 50 replicas:

| Metric | Value |
| --- | --- |
| Clients | 50 / 50 |
| Verdict | PASS |
| Revision | 255 |
| Nodes | 75 |
| Unique SHA-256 | 1 (`5f74f3c075d575e50187e2a73ea002f6567c21fc35e3efb0e40dc74bd7e27505`) |
| Local operations | 249 |
| Outages / reconnects | 57 / 57 |
| Sequencer handoffs | 2 (`BOT-01` to `BOT-02` at +10.3s, back at +14.5s) |
| Minimum online | 34 |
| Relay traffic | 184,632 deliveries, 85 MB |
| Convergence after heal | 2.9 s |

Counts move between runs because socket timings race the 3-second outage
schedule; the verdict does not. Revision, node count and hash are properties of
that particular operation stream, so they are compared across all 50 replicas
inside one run, not against a fixed expectation.

## A defect this harness found

The first 3-second sequencer-outage run did not converge:

```
[FAIL] 8 clients did not converge
  - no-unacknowledged-work: unacked=77, queued=0, inbox=0
```

Cause: operations sent while the sequencer's socket was down are dropped by
the relay. Clients keep them in `unacked`, but presence does not expire the
sequencer for 8 seconds, so no re-election and no retransmit happens. Later
operations are diffed against a view that contains the lost edits, and carry a
version vector claiming predecessors the sequencer never saw. The sequencer
then applies them in the wrong order.

Fix, now part of `SyncEngine`:

1. When a sequencer finishes warming up, its log replay carries `replay: true`.
   Clients retransmit their `unacked` queue on that signal. A reconnect also
   retransmits before flushing the offline outbox.
2. Before sequencing an op, the hub checks every entry in its `vv` against
   `seen`. Missing predecessors park the op in a per-site queue. When the
   missing entries arrive, the queue drains in causal order.

Duplicates are free: the hub's `seen` set already de-duplicates retransmits.

Reproduction:

```bash
python3 chaos/fuzzer.py --clients 8 --chaos-seconds 8 --hub-outage 3 --seed 7
```

Before the fix this exits 1 with `unacked` in the dozens; after the fix it
exits 0. The 50-client run above is the same code path at full scale.

## Limits

- **One Node process hosts all 50 replicas.** Disconnects are per-socket,
  which is the fault this experiment is about. A process crash is out of scope.
- **Loopback only.** The relay and the agent run on 127.0.0.1; WAN jitter,
  packet reordering and partial writes are not simulated.
- **In-memory only.** There is no persistence layer to test. Restarting the
  agent loses the room by design.
- **Final-state assertion.** The harness proves convergence and the absence
  of stranded work at rest, not per-operation latency or UI frame rate.
- **Two observers.** They are excluded from random outages to make failover
  deterministic. The other 48 replicas still flap.
- **No authentication.** The relay accepts any site id, matching the
  prototype's boundaries.
