#!/usr/bin/env python3
"""sync-canvas distributed chaos test.

Starts a room relay, boots 50 replicas of the real JavaScript `SyncEngine`
inside a Node agent, then behaves like a hostile network for a fixed window:

  * every 0.9s, 3-5 random clients lose their socket for ~3s;
  * the current sequencer (the lowest site id) is taken down for 10.5s so
    presence expiry forces a real sequencer handoff;
  * 1-2 random clients keep writing character-level text ops, inserts and
    property patches against the same six "hot" notes.

Then it heals every link, runs anti-entropy, pulls the final document from
every replica over the control API, hashes all 50 with SHA-256 in Python and
writes a JSON report.

Only two external pieces are used: Python's standard library plus
`websockets`, and Node's built-in WebSocket client. No npm packages.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import platform
import random
import shutil
import socket
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from websockets.asyncio.server import ServerConnection, serve


# ── small helpers ───────────────────────────────────────────────────────────


def free_port() -> int:
    """Ask the OS for a port, then release it for the server to bind."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def canonical(nodes: list) -> str:
    return json.dumps(nodes, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_nodes(nodes: list) -> str:
    return hashlib.sha256(canonical(nodes).encode("utf-8")).hexdigest()


class Colors:
    enabled = sys.stdout.isatty()
    GREEN = "\033[92m"
    RED = "\033[91m"
    DIM = "\033[2m"
    BOLD = "\033[1m"
    RESET = "\033[0m"

    @classmethod
    def paint(cls, code: str, text: str) -> str:
        return f"{code}{text}{cls.RESET}" if cls.enabled else text


# ── relay ───────────────────────────────────────────────────────────────────
#
# The engine's WebSocket link only needs a JSON passthrough: broadcast to the
# other connections in the room, never echo to the sender. A `sync-ops` frame
# that carries `to` is routed to that one site, which keeps a 50-peer
# anti-entropy round linear instead of quadratic.


class RelayStats:
    def __init__(self) -> None:
        self.frames_in = 0
        self.frames_out = 0
        self.bytes_out = 0
        self.broadcast = 0
        self.targeted = 0
        self.dropped = 0
        self.bad_frames = 0

    def as_dict(self) -> dict:
        return {
            "framesIn": self.frames_in,
            "framesOut": self.frames_out,
            "bytesOut": self.bytes_out,
            "broadcast": self.broadcast,
            "targeted": self.targeted,
            "dropped": self.dropped,
            "badFrames": self.bad_frames,
        }


class RoomRelay:
    def __init__(self) -> None:
        self.rooms: dict[str, dict[str, ServerConnection]] = {}
        self.stats = RelayStats()

    async def handler(self, ws: ServerConnection) -> None:
        parsed = urlparse(ws.request.path)
        query = parse_qs(parsed.query)
        room = (query.get("room") or ["LOBBY"])[0]
        site = (query.get("site") or [""])[0]
        if not site:
            await ws.close(code=1008, reason="site query parameter is required")
            return

        self.rooms.setdefault(room, {})[site] = ws
        try:
            async for raw in ws:
                self.stats.frames_in += 1
                try:
                    msg = json.loads(raw)
                except Exception:
                    self.stats.bad_frames += 1
                    continue

                target_site = msg.get("to")
                if target_site:
                    target = self.rooms[room].get(str(target_site))
                    if target is None:
                        self.stats.dropped += 1
                        continue
                    await self._deliver(target, raw)
                    self.stats.targeted += 1
                    continue

                peers = [conn for peer, conn in self.rooms[room].items() if peer != site]
                if peers:
                    await asyncio.gather(
                        *(self._deliver(conn, raw) for conn in peers),
                        return_exceptions=True,
                    )
                    self.stats.broadcast += 1
        except Exception:
            # A chaos replica can close its socket mid-frame; that is the point.
            pass
        finally:
            room_map = self.rooms.get(room)
            if room_map is not None and room_map.get(site) is ws:
                del room_map[site]
            if room_map is not None and not room_map:
                self.rooms.pop(room, None)

    async def _deliver(self, ws: ServerConnection, raw: str) -> None:
        try:
            await ws.send(raw)
            self.stats.frames_out += 1
            self.stats.bytes_out += len(raw)
        except Exception:
            pass


# ── control channel ─────────────────────────────────────────────────────────


class ControlHub:
    """One WebSocket between Python (the fuzzer) and the Node engine host."""

    def __init__(self) -> None:
        self.conn: ServerConnection | None = None
        self.ready = asyncio.Event()
        self.ready_sites: list[str] = []
        self.waiters: dict[str, asyncio.Future] = {}

    async def handler(self, ws: ServerConnection) -> None:
        self.conn = ws
        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                if msg.get("k") == "ready":
                    self.ready_sites = msg.get("sites", [])
                    self.ready.set()
                    continue
                rid = msg.get("id")
                if rid and rid in self.waiters and not self.waiters[rid].done():
                    self.waiters[rid].set_result(msg)
        except Exception:
            # The agent is shut down at the end of the run; a close here is normal.
            pass
        finally:
            if self.conn is ws:
                self.conn = None

    async def send(self, payload: dict) -> None:
        if self.conn is None:
            raise RuntimeError("control agent is not connected")
        await self.conn.send(json.dumps(payload))

    async def request(self, payload: dict, timeout: float = 5.0) -> dict:
        if self.conn is None:
            raise RuntimeError("control agent is not connected")
        rid = uuid.uuid4().hex[:10]
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self.waiters[rid] = future
        await self.send({**payload, "id": rid})
        try:
            return await asyncio.wait_for(future, timeout)
        finally:
            self.waiters.pop(rid, None)


# ── fuzzer ──────────────────────────────────────────────────────────────────


class ChaosFuzzer:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.sites: list[str] = [f"BOT-{i + 1:02d}" for i in range(args.clients)]
        # Two replicas never flap. Their presence is the stable witness that
        # expires a dead sequencer, which makes the failover assertion
        # deterministic instead of a race against 50 independent reconnect
        # timers. Everyone else is fair game.
        self.observers = set(self.sites[-2:]) if args.clients >= 8 else set()
        self.room = args.room
        self.control = ControlHub()
        self.relay = RoomRelay()
        self.proc: asyncio.subprocess.Process | None = None

        self.offline: set[str] = set()
        self.drop_tasks: set[asyncio.Task] = set()
        self.stop = False
        self.live_hub: str | None = None
        self.hub_kill_site: str | None = None
        self.hub_handoffs = 0
        self.outages = 0
        self.reconnects = 0
        self.min_online = args.clients
        self.timeline: list[dict] = []

        self.chaos_t0 = 0.0
        self.boot_t0 = 0.0
        self.converge_t0 = 0.0
        self.converge_ms = 0
        self.stats = {"ops": 0, "syncRounds": 0}

    # ── reporting timeline ─────────────────────────────────────────────────

    def mark(self, event: str, **data) -> None:
        item = {"event": event}
        if self.chaos_t0:
            item["atMs"] = round((time.monotonic() - self.chaos_t0) * 1000)
        item.update(data)
        self.timeline.append(item)

    # ── boot ───────────────────────────────────────────────────────────────

    async def spawn_agent(self) -> None:
        node = shutil.which("node")
        if not node:
            raise RuntimeError("node executable not found in PATH")

        agent = Path(__file__).with_name("agent.mjs")
        self.proc = await asyncio.create_subprocess_exec(
            node,
            str(agent),
            "--relay", self.relay_url,
            "--control", self.control_url,
            "--room", self.room,
            "--clients", str(self.args.clients),
            "--seed", str(self.args.seed),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=None,
        )

        deadline = time.monotonic() + self.args.boot_timeout
        while time.monotonic() < deadline:
            if self.proc.returncode is not None:
                raise RuntimeError(f"node agent exited early with code {self.proc.returncode}")
            try:
                await asyncio.wait_for(self.control.ready.wait(), timeout=0.1)
                break
            except asyncio.TimeoutError:
                continue
        else:
            raise RuntimeError("node agent did not register on the control channel")

        got = len(self.control.ready_sites)
        if got != self.args.clients:
            raise RuntimeError(f"agent reported {got} clients, expected {self.args.clients}")

    async def wait_initial(self) -> dict:
        def settled(roles: dict) -> bool:
            clients = roles.get("clients", [])
            if len(clients) != self.args.clients:
                return False
            if not all(c["online"] for c in clients):
                return False
            if any(c["role"] == "warming" for c in clients):
                return False
            hubs = [c for c in clients if c["role"] == "hub"]
            if len(hubs) != 1 or hubs[0]["site"] != self.sites[0]:
                return False
            if len({c["rev"] for c in clients}) != 1:
                return False
            if any(c["nodes"] for c in clients):
                return False
            return True

        return await self.wait_for_roles(settled, timeout=15.0, label="initial election")

    async def wait_for_roles(self, predicate, timeout: float, label: str) -> dict:
        deadline = time.monotonic() + timeout
        last: dict = {}
        while time.monotonic() < deadline:
            last = await self.control.request({"cmd": "roles"}, timeout=3.0)
            if predicate(last):
                return last
            await asyncio.sleep(0.08)
        raise TimeoutError(f"{label} did not settle in {timeout:.1f}s; last={self.describe(last)}")

    @staticmethod
    def describe(roles: dict) -> str:
        clients = roles.get("clients", [])
        if not clients:
            return "no clients"
        hubs = [c["site"] for c in clients if c["role"] == "hub"]
        return (
            f"{len(clients)} clients, hubs={hubs or '-'}, "
            f"rev={sorted({c['rev'] for c in clients})}, "
            f"unacked={sum(c['unacked'] for c in clients)}, "
            f"online={sum(1 for c in clients if c['online'])}"
        )

    async def seed(self) -> dict:
        await self.control.request({"cmd": "seed", "site": self.sites[0], "notes": self.args.seed_notes})
        deadline = time.monotonic() + 8.0
        while time.monotonic() < deadline:
            roles = await self.control.request({"cmd": "roles"}, timeout=3.0)
            clients = roles.get("clients", [])
            if (
                clients
                and all(c["nodes"] == self.args.seed_notes for c in clients)
                and len({c["docHash"] for c in clients}) == 1
            ):
                return roles
            await asyncio.sleep(0.1)
        raise TimeoutError("seeded notes did not reach every replica")

    # ── chaos ──────────────────────────────────────────────────────────────

    async def chaos(self) -> None:
        workers = [
            asyncio.create_task(self.spam_loop()),
            asyncio.create_task(self.outage_loop()),
            asyncio.create_task(self.watch_loop()),
        ]
        if self.args.hub_outage > 0:
            workers.append(asyncio.create_task(self.hub_kill()))

        self.chaos_t0 = time.monotonic()
        self.mark("chaos-start")
        await asyncio.sleep(self.args.chaos_seconds)
        self.stop = True
        self.mark("chaos-end")

        await asyncio.sleep(0.15)
        for work in workers:
            work.cancel()
        await asyncio.gather(*workers, return_exceptions=True)
        for task in list(self.drop_tasks):
            task.cancel()
        await asyncio.gather(*list(self.drop_tasks), return_exceptions=True)

        # Heal every link immediately; pending reconnect timers become no-ops.
        for site in sorted(self.offline):
            await self.control.send({"cmd": "online", "site": site})
        self.offline.clear()
        self.mark("heal")

    async def spam_loop(self) -> None:
        while not self.stop:
            live = [site for site in self.sites if site not in self.offline]
            if live:
                picks = random.sample(live, min(len(live), random.randint(1, 2)))
                for site in picks:
                    await self.control.send({
                        "cmd": "spam",
                        "site": site,
                        "count": random.randint(1, 3),
                    })
            await asyncio.sleep(self.args.spam_interval)

    async def outage_loop(self) -> None:
        while not self.stop:
            now = time.monotonic()
            candidates = [
                site for site in self.sites
                if site not in self.offline and site not in self.observers
            ]
            # Keep the sequencer reachable until the deliberate hub kill.
            if self.hub_kill_site is None and self.live_hub:
                candidates = [site for site in candidates if site != self.live_hub]
            # Never strand the room: keep at least a quarter (max 12) online.
            keep = max(2, min(12, self.args.clients // 4))
            room_for_more = len(self.sites) - len(self.offline) - keep
            if room_for_more > 0 and candidates:
                # Small rooms lose one replica at a time; 50 clients can lose 3-5.
                wave = random.randint(3, 5) if self.args.clients >= 30 else 1
                victims = random.sample(candidates, min(wave, len(candidates), room_for_more))
                for site in victims:
                    task = asyncio.create_task(self.drop(site, random.uniform(2.8, 3.3)))
                    self.drop_tasks.add(task)
                    task.add_done_callback(self.drop_tasks.discard)
            await asyncio.sleep(random.uniform(0.8, 1.2))

    async def drop(self, site: str, seconds: float) -> None:
        if site in self.offline:
            return
        self.offline.add(site)
        self.outages += 1
        self.min_online = min(self.min_online, self.args.clients - len(self.offline))
        self.mark("outage", site=site, seconds=round(seconds, 2))
        await self.control.send({"cmd": "offline", "site": site})
        try:
            await asyncio.sleep(seconds)
        except asyncio.CancelledError:
            raise
        finally:
            if site in self.offline:
                self.offline.discard(site)
                await self.control.send({"cmd": "online", "site": site})
                self.reconnects += 1
                self.mark("reconnect", site=site)

    async def hub_kill(self) -> None:
        await asyncio.sleep(min(3.6, self.args.chaos_seconds * 0.3))
        hub = self.live_hub or self.sites[0]
        self.hub_kill_site = hub
        self.mark("hub-kill", site=hub, seconds=self.args.hub_outage)
        await self.drop(hub, self.args.hub_outage)

    def observe_roles(self, roles: dict) -> None:
        clients = roles.get("clients", [])
        if not clients:
            return
        online = sum(1 for c in clients if c["online"])
        self.min_online = min(self.min_online, online)
        hubbed = next((c for c in clients if c["role"] == "hub" and c["online"]), None)
        if self.args.verbose:
            stamp = time.monotonic() - self.chaos_t0
            print(
                f"  [t+{stamp:5.1f}s] online={online:2d} "
                f"hub={self.live_hub or '-':6s} "
                f"roles={sorted({c['role'] for c in clients})} "
                f"peers={sorted({c['peers'] for c in clients})}",
                flush=True,
            )
        if hubbed:
            if self.live_hub is None:
                self.live_hub = hubbed["hub"]
            elif hubbed["hub"] != self.live_hub:
                self.live_hub = hubbed["hub"]
                self.hub_handoffs += 1
                self.mark("hub-handoff", site=self.live_hub)

    async def watch_loop(self) -> None:
        while not self.stop:
            try:
                roles = await self.control.request({"cmd": "roles"}, timeout=3.0)
            except Exception:
                await asyncio.sleep(0.4)
                continue
            self.observe_roles(roles)
            await asyncio.sleep(0.5)

    # ── verify ─────────────────────────────────────────────────────────────

    def quiescent(self, roles: dict) -> bool:
        clients = roles.get("clients", [])
        if len(clients) != self.args.clients:
            return False
        if not all(c["online"] for c in clients):
            return False
        if any(c["role"] == "warming" for c in clients):
            return False
        hubs = [c for c in clients if c["role"] == "hub"]
        if len(hubs) != 1 or hubs[0]["site"] != self.sites[0]:
            return False
        if len({c["rev"] for c in clients}) != 1:
            return False
        if any(c["unacked"] or c["queued"] or c["inbox"] for c in clients):
            return False
        if len({c["docHash"] for c in clients}) != 1:
            return False
        return True

    async def heal_and_verify(self) -> dict:
        self.converge_t0 = time.monotonic()
        self.mark("verify-start")
        deadline = self.converge_t0 + self.args.heal_timeout
        stable_polls = 0
        last_sync = time.monotonic()
        final_roles: dict = {}

        while time.monotonic() < deadline:
            final_roles = await self.control.request({"cmd": "roles"}, timeout=3.0)
            self.observe_roles(final_roles)
            if self.quiescent(final_roles):
                stable_polls += 1
                if stable_polls >= 3:
                    self.converge_ms = round((time.monotonic() - self.converge_t0) * 1000)
                    self.mark("converged", ms=self.converge_ms)
                    break
            else:
                stable_polls = 0

            now = time.monotonic()
            if now - last_sync > 2.0 and self.stats["syncRounds"] < 3:
                self.stats["syncRounds"] += 1
                await self.control.request({"cmd": "sync"}, timeout=3.0)
                last_sync = now
            await asyncio.sleep(0.12)
        else:
            self.converge_ms = round((time.monotonic() - self.converge_t0) * 1000)
            self.mark("converge-timeout", ms=self.converge_ms)

        snapshot = await self.control.request({"cmd": "snapshot"}, timeout=20.0)
        return snapshot

    # ── main ───────────────────────────────────────────────────────────────

    async def run(self) -> int:
        self.boot_t0 = time.monotonic()
        relay_port = free_port()
        control_port = free_port()
        self.relay_url = f"ws://127.0.0.1:{relay_port}"
        self.control_url = f"ws://127.0.0.1:{control_port}"

        async with (
            serve(self.relay.handler, "127.0.0.1", relay_port, max_size=None, compression=None),
            serve(self.control.handler, "127.0.0.1", control_port, max_size=None, compression=None),
        ):
            try:
                await self.spawn_agent()
                boot_ms = round((time.monotonic() - self.boot_t0) * 1000)
                print(f"[1/4] boot        {self.args.clients} engine replicas registered ({boot_ms}ms)")

                await self.wait_initial()
                print(f"[2/4] seed        {self.args.seed_notes} shared notes, hub={self.sites[0]}")

                await self.seed()
                await self.chaos()

                snapshot = await self.heal_and_verify()
                report = self.build_report(snapshot)

                target = Path(self.args.report)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

                self.print_summary(report, target)
                return 0 if report["verdict"] == "PASS" else 1
            finally:
                await self.shutdown()

    async def shutdown(self) -> None:
        try:
            if self.control.conn is not None:
                await self.control.request({"cmd": "stop"}, timeout=1.5)
        except Exception:
            pass
        if self.proc and self.proc.returncode is None:
            try:
                await asyncio.wait_for(self.proc.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                self.proc.terminate()
                try:
                    await asyncio.wait_for(self.proc.wait(), timeout=2.0)
                except asyncio.TimeoutError:
                    self.proc.kill()

    # ── report ─────────────────────────────────────────────────────────────

    def build_report(self, snapshot: dict) -> dict:
        clients = snapshot.get("clients", [])
        docs: dict[str, list] = {}
        for client in clients:
            doc = client.pop("doc", {})
            nodes = doc.get("nodes", []) if isinstance(doc, dict) else doc
            docs[client["site"]] = nodes
            client["docHashPython"] = sha256_nodes(nodes)
        clients.sort(key=lambda c: c["site"])

        hashes = {c["docHashPython"] for c in clients}
        revs = {c["rev"] for c in clients}
        node_counts = {c["nodes"] for c in clients}
        hubs = [c["site"] for c in clients if c["role"] == "hub"]
        online = sum(1 for c in clients if c["online"])
        ops = sum(c["localOps"] for c in clients)
        unacked = sum(c["unacked"] for c in clients)
        queued = sum(c["queued"] for c in clients)
        inbox = sum(c["inbox"] for c in clients)
        handoff_ok = self.hub_handoffs >= 1
        cross_check = all(c["docHashPython"] == c["docHash"] for c in clients)

        assertions = [
            {
                "name": "client-set-complete",
                "pass": len(clients) == self.args.clients and len({c["site"] for c in clients}) == self.args.clients,
                "detail": f"{len(clients)}/{self.args.clients} replicas reported",
            },
            {
                "name": "all-clients-online",
                "pass": online == self.args.clients,
                "detail": f"{online}/{self.args.clients} online at snapshot time",
            },
            {
                "name": "single-sequencer",
                "pass": len(hubs) == 1 and hubs[0] == self.sites[0],
                "detail": f"hub={hubs[0] if len(hubs) == 1 else hubs}, expected={self.sites[0]}",
            },
            {
                "name": "revision-agreement",
                "pass": len(revs) == 1,
                "detail": f"rev={sorted(revs)}",
            },
            {
                "name": "document-hash-identical",
                "pass": len(hashes) == 1,
                "detail": f"{len(hashes)} unique SHA-256 hash(es) over {sorted(node_counts)} nodes",
            },
            {
                "name": "no-unacknowledged-work",
                "pass": unacked == 0 and queued == 0 and inbox == 0,
                "detail": f"unacked={unacked}, queued={queued}, inbox={inbox}",
            },
            {
                "name": "hash-cross-check",
                "pass": cross_check,
                "detail": "Python SHA-256 matches the Node digest on every replica",
            },
            {
                "name": "chaos-actually-happened",
                "pass": self.outages >= 6 and self.reconnects >= 6 and ops >= 60,
                "detail": f"{self.outages} outages, {self.reconnects} reconnects, {ops} local ops",
            },
            {
                "name": "sequencer-handoff-exercised",
                # A handoff needs the outage to outlast the 8s presence expiry.
                "pass": handoff_ok if self.args.hub_outage >= 8 else True,
                "detail": f"{self.hub_handoffs} observed hub change(s)",
            },
        ]

        verdict = "PASS" if all(item["pass"] for item in assertions) else "FAIL"
        first_divergence = None
        if len(hashes) > 1:
            first_divergence = self.diff_documents(clients, docs)

        report = {
            "schema": "sync-canvas/chaos-report@1",
            "generatedAt": utc_now(),
            "verdict": verdict,
            "summary": {
                "clients": len(clients),
                "converged": verdict == "PASS",
                "convergenceMs": self.converge_ms,
                "rev": sorted(revs)[0] if len(revs) == 1 else None,
                "nodes": sorted(node_counts)[0] if len(node_counts) == 1 else None,
                "uniqueDocHashes": len(hashes),
                "docHash": next(iter(hashes)) if len(hashes) == 1 else None,
                "localOps": ops,
                "outages": self.outages,
                "reconnects": self.reconnects,
                "hubHandoffs": self.hub_handoffs,
                "minOnline": self.min_online,
                "antiEntropyRounds": self.stats["syncRounds"],
                "hashCrossCheck": cross_check,
                "relay": self.relay.stats.as_dict(),
            },
            "config": {
                "clients": self.args.clients,
                "room": self.room,
                "chaosSeconds": self.args.chaos_seconds,
                "outageSeconds": [2.8, 3.3],
                "hubOutageSeconds": self.args.hub_outage,
                "seedNotes": self.args.seed_notes,
                "seed": self.args.seed,
                "spamIntervalMs": round(self.args.spam_interval * 1000),
                "observers": sorted(self.observers),
                "transport": "websocket relay (passthrough, targeted sync-ops)",
                "engine": "src/engine/SyncEngine.js (real replicas hosted by chaos/agent.mjs)",
                "relay": self.relay_url,
            },
            "assertions": assertions,
            "timeline": self.timeline,
            "clients": clients,
            "firstDivergence": first_divergence,
            "environment": {
                "python": platform.python_version(),
                "node": NODE_VERSION,
                "websockets": WEBSOCKETS_VERSION,
                "platform": platform.platform(),
                "cwd": str(Path.cwd()),
            },
        }
        return report

    @staticmethod
    def diff_documents(clients: list[dict], docs: dict[str, list]) -> dict | None:
        """Point at the first concrete difference instead of only the hashes."""
        if not clients:
            return None
        base = clients[0]["site"]
        base_nodes = docs.get(base, [])
        base_by_id = {node.get("id"): node for node in base_nodes}
        for other in clients[1:]:
            if other["docHashPython"] == clients[0]["docHashPython"]:
                continue
            other_nodes = docs.get(other["site"], [])
            other_by_id = {node.get("id"): node for node in other_nodes}
            for node_id, node in base_by_id.items():
                peer = other_by_id.get(node_id)
                if peer is None:
                    return {
                        "a": base,
                        "b": other["site"],
                        "nodeId": node_id,
                        "kind": "missing-in-b",
                        "aNode": ChaosFuzzer.trim(node),
                    }
                if canonical([node]) != canonical([peer]):
                    return {
                        "a": base,
                        "b": other["site"],
                        "nodeId": node_id,
                        "kind": "node-differs",
                        "aNode": ChaosFuzzer.trim(node),
                        "bNode": ChaosFuzzer.trim(peer),
                    }
            for node_id, node in other_by_id.items():
                if node_id not in base_by_id:
                    return {
                        "a": base,
                        "b": other["site"],
                        "nodeId": node_id,
                        "kind": "missing-in-a",
                        "bNode": ChaosFuzzer.trim(node),
                    }
        return None

    @staticmethod
    def trim(node: dict) -> dict:
        out = dict(node)
        text = out.get("text")
        if isinstance(text, str) and len(text) > 80:
            out["text"] = f"{text[:77]}..."
        return out

    def print_summary(self, report: dict, target: Path) -> None:
        summary = report["summary"]
        print(f"[3/4] chaos       {self.outages} outages, {self.hub_handoffs} handoff(s), {summary['localOps']} ops")
        print(f"[4/4] verify      {summary['rev']} revisions, {summary['nodes']} nodes, "
              f"{summary['uniqueDocHashes']} unique hash(es)")

        verdict = report["verdict"]
        paint = Colors.GREEN if verdict == "PASS" else Colors.RED
        label = Colors.paint(paint, f"[{verdict}]")
        if verdict == "PASS":
            for client in report["clients"]:
                print(
                    f"{Colors.paint(Colors.GREEN, '[PASS]')} {client['site']}  "
                    f"rev {client['rev']}  nodes {client['nodes']}  "
                    f"hash {client['docHashPython'][:12]}"
                )
            print(
                f"{label} {self.args.clients} clients converged in "
                f"{summary['convergenceMs'] / 1000:.1f}s "
                f"({summary['docHash'][:16]}..., rev {summary['rev']})"
            )
        else:
            failed = [a for a in report["assertions"] if not a["pass"]]
            print(f"{label} {self.args.clients} clients did not converge")
            for item in failed:
                print(f"  - {item['name']}: {item['detail']}")
            if report.get("firstDivergence"):
                print(f"  - firstDivergence: {report['firstDivergence']}")
        print(f"report -> {target}")


# ── CLI ─────────────────────────────────────────────────────────────────────


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Chaos-test the sync-canvas OT engine with 50 concurrent replicas.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--clients", type=int, default=50, help="number of replicas")
    parser.add_argument("--room", default="CHAOS1", help="room id for the relay")
    parser.add_argument("--chaos-seconds", type=float, default=14.0, help="length of the hostile window")
    parser.add_argument("--hub-outage", type=float, default=10.5, help="seconds the sequencer stays down (0 disables)")
    parser.add_argument("--seed-notes", type=int, default=6, help="shared hot notes created before chaos")
    parser.add_argument("--spam-interval", type=float, default=0.18, help="seconds between spam bursts")
    parser.add_argument("--heal-timeout", type=float, default=25.0, help="seconds allowed for convergence")
    parser.add_argument("--boot-timeout", type=float, default=20.0, help="seconds allowed for agent boot")
    parser.add_argument("--seed", type=int, default=None, help="PRNG seed (recorded in the report)")
    parser.add_argument("--report", default=str(Path(__file__).with_name("chaos-report.json")))
    parser.add_argument("--verbose", action="store_true", help="print a role line every poll")
    parser.add_argument("--no-color", action="store_true", help="disable ANSI output")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.seed is None:
        args.seed = random.randrange(1, 2**31)
    random.seed(args.seed)
    if args.no_color:
        Colors.enabled = False

    fuzzer = ChaosFuzzer(args)
    try:
        return asyncio.run(fuzzer.run())
    except KeyboardInterrupt:
        return 130


def probe_versions() -> tuple[str, str]:
    node = "unknown"
    try:
        node = subprocess.run(["node", "-v"], capture_output=True, text=True, timeout=5).stdout.strip()
    except Exception:
        pass
    try:
        import websockets

        ws = websockets.__version__
    except Exception:
        ws = "unknown"
    return node or "unknown", ws


NODE_VERSION, WEBSOCKETS_VERSION = probe_versions()

if __name__ == "__main__":
    sys.exit(main())
