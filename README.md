# sync-canvas

A realtime collaborative whiteboard with no framework and no collaboration library. Plain HTML, CSS and native ES modules, plus a hand-written character-level OT, a single-writer sequencer and an optimistic UI. Open two tabs and they are two clients; swap the transport for a real socket and nothing else in the codebase changes.

```
src/engine/    OT, document operations, replication state machine, transport
src/canvas/    viewport, renderer, pointer interaction
src/ui/        toolbar, presence, text editor, debug panel
styles/        design tokens and layout
tests/         convergence fuzz and the TP2 counter-example
```

## Run

ES modules cannot load from `file://`, so serve the folder over HTTP:

```bash
cd sync-canvas
npm run dev          # python3 -m http.server 8080
# open http://127.0.0.1:8080/#ROOM1
```

The room id is the URL hash. Open the same link in a second tab and the two peers discover each other, elect a sequencer and sync. `New tab` in the top bar copies the current room link; `Disconnect` cuts the transport but keeps local editing alive.

Shortcuts: `V` select, `N` note, `L` connector, `0` fit view, `Space` pan, `Delete` delete, `Esc` cancel. Wheel pans; `Ctrl/Cmd + wheel` zooms around the cursor; double-click a note to edit its text.

## Architecture

```
                        ┌──────────────────────────────────────────┐
                        │                one tab                   │
                        │                                          │
  pointer / keyboard ──▶│ Interaction ── op ──▶ SyncEngine          │
                        │      │                  │  ▲              │
                        │      │                  │  │ wire         │
                        │      ▼                  ▼  │              │
                        │  TextEditor         SocketProvider ───────┼──▶ BroadcastChannel
                        │      │                  │                  │    or WebSocket
                        │      └──────▶ CanvasRenderer ◀── Presence │
                        │                    ▲                     │ │
                        │                    └── rAF loop         │ │
                        └──────────────────────────────────────────┘
```

`Presence` and the replication layer share one pipe and are demultiplexed by the `k` field (`presence` / `op` / `op-applied` / `sync-request` / `sync-ops`). The renderer never asks where a message came from; the interaction layer never asks who is sequencing.

## Replication model

The engine has two stable roles plus one transitional state:

| Role | Who | What it does |
| --- | --- | --- |
| `hub` | smallest site id among online peers | Transforms every incoming op against its own log, assigns a monotonic `rev`, broadcasts `op-applied` |
| `client` | every other peer | Applies strictly in `rev` order; its own ops wait in an unacknowledged queue |
| `warming` | a hub that has just been elected and has not finished catching up | Collects `sync-request` replies and only then starts ordering |

Election needs no negotiation: `setPeers` takes the current online set, sorts it, picks the first. Every replica computes the same answer.

### Optimistic update

The renderer does not draw `doc`; it draws:

```js
view = doc            // the part the hub has already ordered
     + unacked         // local ops sent but not yet echoed by the hub
```

`unacked` is overlaid locally only and is never written into the log. Once the hub echoes an op it leaves the queue and the view converges to `doc`. Dragging, typing and color changes therefore never wait on the network; even offline you keep editing, `unacked` just grows.

### Commit path

When the hub receives an op it first computes the difference against the log:

```js
transformAgainstLog(wire) {
  let op = wire.op;
  for (const h of this.log) {
    // transform only against entries the author had not seen yet
    if (h.seq <= (wire.vv[h.site] || 0)) continue;
    op = BoardOT.transform(op, h.op, wire.site, h.site);
    if (!op) return null;         // target deleted / overwritten by a newer write
  }
  return op;
}
```

Every op carries its own version vector `vv` (`site → last seq`), a snapshot taken at send time. The hub never has to ask "how far had you seen"; the log itself answers.

`rev` is a global monotonic counter. Clients apply in `rev` order; a gap goes into `inbox` and the buffer drains once the missing revision arrives. A `seen` set records already-ordered `site:seq` pairs, so retransmits and duplicate echoes never produce a second log entry.

### Anti-entropy and reconnect

- `sync-request`: carries the sender's `rev` and asks everyone in the room for log slices.
- `sync-ops`: **any** online peer can answer, not just the hub. This is what lets a new hub rebuild from a surviving replica instead of depending on the node that just died.
- A new hub's `warming` phase collects replies from every online peer (deduplicated `replied` + `expected` counter + timeout fallback), then broadcasts its whole log once; replicas behind it ignore entries they already have.
- While offline, all writes go into `outbox`; on reconnect each role flushes its own way (hub orders directly, client resends). A following `sync-request` picks up everything others wrote during the outage.
- When another peer goes offline, 8 seconds without presence evicts it from the roster; when it reappears it carries a `hello` flag and both sides force a re-election, preventing a two-hub window where the returning peer still believes it is hub while the other side does too.

## OT details

### Text

`OT.js` is single-field character-level OT with three components: `retain(n)`, `insert(s)`, `delete(n)`. Each keystroke first runs `diff(base, next)` to produce an op covering the whole string, then hands it to the engine; incoming remote ops are rebased with `transform`, and `mapIndex` fixes the local caret and selection, so concurrent typing never throws the caret to end of line.

Text ops satisfy TP1: two concurrent ops produce the same result no matter which one is applied first. `tests/fuzz.mjs` asserts this at startup.

### Board

`BoardOT.js` defines four operations:

| Operation | Semantics | Conflict policy |
| --- | --- | --- |
| `ins(i, node)` | Insert a node at list position `i` | Concurrent inserts at the same position ordered by `aSite < bSite`, so every replica agrees |
| `del(i, id)` | Delete a given id | Located by id; `i` only recomputes the index; returns `null` if the target is already gone |
| `set(id, patch, ts)` | Change properties | Per-key LWW comparing `(ts, site)`; the losing keys are stripped from the op |
| `txt(id, op)` | Change text | Delegated to character-level OT |

Drags commit **absolute coordinates**, not deltas. When several peers drag the same note, LWW picks one final position instead of each side adding half an offset. Drags are throttled to a commit every 40ms while rendering still follows the local offset at 60fps.

### Why a hub is mandatory: the TP2 boundary

Position-based OT is TP1-safe for **two** concurrent operations; with **three**, the transform result depends on application order. That is a property of the model, not an implementation bug. `tests/tp2.mjs` enumerates the same text with three concurrent edits and four application orders across 3000 random groups, and observes roughly **2760 diverging groups** per run (varies with randomness).

So the architecture never does peer-to-peer transforms. Every intent first reaches a single serialization point; the hub only has to guarantee TP1, and it alone decides global order. The classic Jupiter model, and every collaborative editor actually in production, has this shape.

## Presence and ghost cursors

`Presence` throttles world coordinates, selected id and editing id to every 40ms; heartbeat every 3 seconds, expiry after 8. Received positions are not assigned directly: each frame `lerp`s 0.3 toward the target, so cursors glide instead of jumping packet by packet. Coordinates are world coordinates, so a remote cursor still points at the same canvas location after the other side zooms or pans.

The top-left of every note carries the engine attribution (gold dot + `JEROME YOUNG`); a remote selection draws a dashed outline around the note, and a note being typed into shows `name · typing` beside the cursor.

## Connecting a real backend

There is exactly one seam in the transport layer: `SocketProvider`. It connects `send()` and incoming messages to a link; both `BroadcastChannelLink` and `WebSocketLink` implement the same `post / close`. The engine, renderer and interaction layer have no idea what sits underneath.

### Option 1: passthrough (JSON relay)

Already supported:

```
http://127.0.0.1:8080/?ws=ws://127.0.0.1:8081#ROOM1
```

The backend only has to forward received JSON to the other connections in the same room. The in-page hub keeps ordering; the backend needs no OT knowledge.

### Option 2: Socket.io

The server is a room relay with no document logic:

```js
// server.js — npm i socket.io
import { Server } from 'socket.io';

const io = new Server(8081, { cors: { origin: '*' } });

io.on('connection', (socket) => {
  const room = String(socket.handshake.query.room || 'LOBBY');
  socket.join(room);

  socket.on('board', (msg) => {
    // Forward to everyone else in the room, never echo to the sender.
    // The engine assumes a sender does not receive its own message
    // (BroadcastChannel has the same semantics).
    socket.to(room).emit('board', msg);
  });
});
```

The client only swaps the link; the interface matches `WebSocketLink`:

```js
// add one link inside src/engine/SocketProvider.js
import { io } from 'socket.io-client';

class SocketIoLink {
  constructor(url, room, onMessage) {
    this.socket = io(url, { query: { room } });
    this.socket.on('board', (msg) => onMessage(msg));
  }
  post(msg) {
    this.socket.emit('board', msg);
  }
  close() {
    this.socket.close();
  }
}
```

Then pick one by URL prefix inside `SocketProvider.open()`:

```js
this.link = this.url?.startsWith('io://')
  ? new SocketIoLink(this.url.slice(5), this.room, handler)
  : this.url
    ? new WebSocketLink(this.url, handler, (s) => this.onStatus(s))
    : new BroadcastChannelLink(this.room, handler);
```

The link becomes `http://127.0.0.1:8080/?ws=io://localhost:8081#ROOM1`. Core business code changes by zero lines.

If you want the backend to become the only serialization point, move `SyncEngine`'s hub branch onto the server, or make the server permanently play hub (clients keep only the `client` path). The message format is already plain JSON; migration cost is moving one file.

## Verified

```bash
npm test                    # node tests/fuzz.mjs, 60 rounds by default
node tests/fuzz.mjs 300     # run more rounds
```

300-round output (different on every run):

```
text TP1: ✓ passed
convergence: ✓ 300/300 runs identical (avg 8 nodes, 1138 disconnects, 1688 sequencer handoffs)
```

The full test inventory, assertion definitions, uncovered areas and reproduction commands are in [TEST_REPORT.md](TEST_REPORT.md).

The fuzz harness uses 2–4 random peers per round, random create/delete/update/type, and a 5% chance of a disconnect (always keeping at least one online); at the end every peer reconnects and runs two anti-entropy rounds. Assertion: all replicas agree exactly on `doc.nodes`, `rev` and `unacked`.

Browser end-to-end (two real tabs):

- the hub seeds 7 nodes on first paint; both sides agree on `rev` and node count
- create a note and type across tabs: character-level `txt` ops arrive one by one and `unacked` returns to zero
- role split: the smaller site is `hub`, the larger is `client`
- edit while offline, reconnect, and both summaries agree
- take the small site offline for 12 seconds: the large site takes over as hub; when the small site returns it reclaims the hub role, the large site drops back to client, and `rev` / node count agree on both sides
- create, drag, Ctrl+wheel zoom, connect, marquee select and cascading delete all change the document as expected
- zero console errors

## Boundaries and trade-offs

- **No persistence.** Refreshing the page leaves the room; the server has no database either. Durability requires a storage layer.
- **No authentication.** Anyone with the room id gets in; production must validate during the connection handshake.
- **BroadcastChannel is same-origin, same-browser tabs only**; it cannot cross devices. Use `?ws=` for that.
- **The hub is a single point.** While it is stuck, clients can still edit locally, but no new `rev` exists until presence expiry triggers a re-election. That is the unavoidable cost of a serverless prototype.
- **No z-order, undo/redo, images or permissions.** Node order is insertion order; `set` resolves property conflicts, not "who is on top".
- **Text OT diffs by character**, good for note-length text but not long documents; long text should move to line-level OT or a CRDT.
- **Presence is best effort.** Network loss, crashes and forced tab closes all expire after 8 seconds; no "last known state" is persisted.

## English

A dependency-free realtime whiteboard: native ES modules, Canvas 2D rendering, character-level operational transformation, and a single-writer sequencer. Every edit is applied locally first (optimistic overlay), then transformed against the sequencer's log and committed with a monotonic revision. Clients apply revisions strictly in order and buffer gaps; any replica can answer anti-entropy requests, which is what lets a newly elected sequencer rebuild itself from a surviving peer after the previous one disappears. Presence, cursors and selection highlights ride the same transport, and offline edits are queued and merged on reconnect. The transport is one swappable link: BroadcastChannel by default, raw WebSocket or Socket.io with a relay-only backend. A 300-round fuzz suite with random disconnects and sequencer handoffs converges on every run. `tests/tp2.mjs` reproduces the classic three-way TP2 divergence that motivates the sequencer design.

## License & attribution

`sync-canvas` — Distributed State & Real-time Collaboration Engine
Copyright (c) 2026 Jerome Young. All Rights Reserved.

- Source is licensed under **AGPL-3.0-or-later**; the full text is in [LICENSE](LICENSE).
- Closed-source commercial use, or any SaaS deployment that does not disclose the source,
  requires a commercial license. Contact <jeromeyoung608@gmail.com>.
- The copyright header in `src/engine/*.js` must not be removed or altered. Removing it
  terminates the license grant.
- Visible attribution exists in four places: the engine source headers, the browser console
  banner, the bottom status bar (`ENGINE BY JEROME YOUNG`), and the author stamp drawn on
  every canvas note.

The online demo includes an attribution watermark. The commercial license (or private
deployment package) allows you to remove it completely.
