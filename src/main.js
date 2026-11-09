/**
 * Composition root.
 *
 * The wiring is deliberately boring: one bus, one transport, one engine. Swap
 * `?ws=ws://host` in and the whole room moves from BroadcastChannel to a real
 * socket without touching the renderer, the interaction layer or the OT code.
 */

console.log(
  '%c sync-canvas ',
  'background: #222; color: #bada55; font-size: 20px; font-weight: bold; padding: 4px; border-radius: 4px;',
);
console.log(
  '%c Zero-dependency OT Engine built by Jerome Young (20+ yrs exp).\nFor commercial licensing or enterprise integration, contact: jeromeyoung608@gmail.com',
  'color: #888; font-size: 12px;',
);

import { EventBus } from './utils/EventBus.js';
import { makeSite, makeRoom } from './utils/id.js';
import { SocketProvider } from './engine/SocketProvider.js';
import { SyncEngine } from './engine/SyncEngine.js';
import { Viewport } from './canvas/viewport.js';
import { CanvasRenderer } from './canvas/CanvasRenderer.js';
import { Interaction } from './canvas/Interaction.js';
import { Presence } from './ui/Presence.js';
import { TextEditor } from './ui/TextEditor.js';
import { Toolbar } from './ui/Toolbar.js';
import { Inspector } from './ui/Inspector.js';
import * as BoardOT from './engine/BoardOT.js';

function readRoom() {
  const raw = (location.hash || '').replace(/^#/, '').trim().toUpperCase();
  return raw || makeRoom();
}

function boot() {
  const room = readRoom();
  history.replaceState(null, '', `#${room}`);

  const bus = new EventBus();
  const canvas = document.getElementById('board');
  const layer = document.getElementById('editor-layer');
  const site = makeSite();

  const ws = new URLSearchParams(location.search).get('ws');
  const provider = new SocketProvider({ room, bus, url: ws || null });
  provider.open();

  const engine = new SyncEngine({
    site,
    provider,
    bus,
    now: () => Date.now(),
  });

  const viewport = new Viewport();
  const presence = new Presence({ site, provider, bus });
  const renderer = new CanvasRenderer({
    canvas,
    viewport,
    engine,
    colorFor: (s) => presence.colorFor(s),
    getCursors: () => presence.cursors(),
  });

  new TextEditor({ layer, engine, viewport, renderer, bus });
  const interaction = new Interaction({ canvas, viewport, engine, renderer, bus, presence });
  const toolbar = new Toolbar({
    bus,
    engine,
    viewport,
    renderer,
    canvas,
    presence,
    room,
    transport: provider.transport,
  });
  new Inspector({ bus, engine, presence });

  // ── message routing ──────────────────────────────────────────
  // Presence and the replication layer share one pipe, exactly like they would
  // share a socket. Only the `k` discriminator decides who gets what.
  bus.on('wire', (msg) => {
    if (!msg || typeof msg !== 'object' || typeof msg.k !== 'string') return;
    if (msg.k === 'presence') presence.receive(msg);
    else engine.receive(msg);
  });

  bus.on('peers', ({ sites }) => engine.setPeers(sites));
  bus.on('editing', (id) => presence.setEditing(id));
  bus.on('tool', (t) => {
    canvas.dataset.tool = t;
  });

  // A room of one still needs an election before it may sequence anything.
  engine.setPeers(presence.sites());

  // ── frame loop ───────────────────────────────────────────────
  const frame = () => {
    requestAnimationFrame(frame);
    presence.tick();
    renderer.draw();
  };
  frame();

  window.addEventListener('resize', () => viewport.touch());
  window.addEventListener('pagehide', () => {
    presence.leave();
    provider.close();
  });

  // ── seed ─────────────────────────────────────────────────────
  // Only the sequencer seeds, and only into a room that is still empty. A
  // second tab joining a live room never duplicates the starter board.
  setTimeout(() => {
    if (engine.role !== 'hub' || engine.rev !== 0 || engine.doc.nodes.length !== 0) return;
    seed(engine, viewport, toolbar, canvas);
  }, 900);

  window.__sync = { engine, provider, viewport, presence, interaction, room, site };
}

function seed(engine, viewport, toolbar, canvas) {
  const site = engine.site;
  const notes = [
    [96, 132, 'butter', 'Drag a note. Shift-click to select more than one.'],
    [360, 92, 'mint', 'Double-click to write. Every keystroke travels as a character-level OT delta.'],
    [648, 196, 'sky', 'Drop the transport up top, keep typing, then reconnect. The queue merges on arrival.'],
    [246, 372, 'blush', 'Open a second tab. Those cursors are BroadcastChannel traffic, not an animation.'],
  ];

  const ids = notes.map((_, i) => `${site}-s${i}`);
  let i = 0;
  for (const [x, y, color, text] of notes) {
    engine.local(
      BoardOT.ops.ins(i, {
        id: ids[i],
        kind: 'note',
        x,
        y,
        w: BoardOT.NOTE_W,
        h: BoardOT.NOTE_H,
        color,
        text,
        by: site,
      }),
    );
    i += 1;
  }

  engine.local(
    BoardOT.ops.ins(4, { id: `${site}-l0`, kind: 'link', from: ids[0], to: ids[1], by: site }),
  );
  engine.local(
    BoardOT.ops.ins(5, { id: `${site}-l1`, kind: 'link', from: ids[1], to: ids[2], by: site }),
  );
  engine.local(
    BoardOT.ops.ins(6, { id: `${site}-l2`, kind: 'link', from: ids[1], to: ids[3], by: site }),
  );

  viewport.fit(
    { x: 96, y: 92, w: 648 + BoardOT.NOTE_W - 96, h: 372 + BoardOT.NOTE_H - 92 },
    canvas.clientWidth,
    canvas.clientHeight,
  );
  toolbar.updateZoom();
}

boot();
