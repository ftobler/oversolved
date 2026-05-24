"""Standalone solver daemon.

Blind and deaf: no database, no outbound network.  Receives solve requests
over a WebSocket, dispatches them to OCP worker subprocesses, returns
results.  OCP lives only in worker subprocesses for crash isolation.
"""

import asyncio
import json
import logging
import multiprocessing as mp
import os
import time
import traceback
import uuid

from oversolved.kernel.errors import error_result
from queue import Empty as _QueueEmpty
from typing import Any

from websockets.asyncio.server import serve

logger = logging.getLogger(__name__)


def _build_worker(input_queue: Any, output_queue: Any) -> None:
    """Long-lived worker process that runs build() requests.

    Import happens inside the worker so that OCC is loaded in the
    subprocess, keeping the solver daemon free of native code.
    """
    from oversolved.kernel.builder import build  # noqa: PLC0415
    from oversolved.kernel.geometry_pack import pack_geometry_update  # noqa: PLC0415
    from oversolved.cache import TtlCache  # noqa: PLC0415

    ttl = float(os.environ.get("OVERSOLVED_SOLVER_STATE_TTL", "1800"))
    max_size = int(os.environ.get("OVERSOLVED_SOLVER_STATE_MAX_SIZE", "32"))
    prev_states: TtlCache[Any] = TtlCache(ttl_seconds=ttl, max_size=max_size)

    while True:
        try:
            msg = input_queue.get()
        except (EOFError, KeyboardInterrupt):
            break
        except Exception:
            logger.exception("Worker input queue error")
            break

        if msg is None:
            break

        if isinstance(msg, (list, tuple)) and len(msg) >= 2 and msg[0] == "__clear_cache__":
            doc_id = msg[1]
            if doc_id:
                prev_states.delete(doc_id)
            else:
                prev_states.clear()
            continue

        try:
            request_id, doc_id, spec, pick_boundary, rollback_position, isolator_request_id = msg
        except (TypeError, ValueError):
            logger.error("Worker received malformed message: %r", msg)
            continue

        t0 = time.perf_counter()
        try:
            prev_state = prev_states.get(doc_id) if doc_id else None

            result = build(
                spec,
                prev_state=prev_state,
                pick_boundary=pick_boundary,
                rollback_position=rollback_position,
            )

            new_state = result.pop("_build_state", None)
            result.pop("_body_shapes", None)

            if doc_id and new_state is not None:
                prev_states.set(doc_id, new_state)

            status = "ok"
        except Exception as exc:
            logger.warning("Build worker exception: %s\n%s", exc, traceback.format_exc())
            duration_ms = round((time.perf_counter() - t0) * 1000, 1)
            error_exc = str(exc)
            result = {
                "solve_ms": duration_ms,
                "result": {},
                "bodies": {},
            }
            status = "error"

        # Pre-pack geometry in the worker so only compact bytes traverse
        # the mp.Queue instead of heavy Python mesh object graphs (~20MB).
        bodies = result.pop("bodies", {})
        pick_bodies = result.pop("pick_bodies", None)
        result["_geometry_bytes"] = pack_geometry_update(
            spec.get("msgId", ""), bodies, pick_bodies,
            request_id=isolator_request_id or request_id,
        )

        if status == "error":
            try:
                output_queue.put(
                    (request_id, "error", {
                        "exception": error_exc,
                        "result_so_far": result,
                    })
                )
            except Exception:
                logger.exception("Worker output queue error")
        else:
            output_queue.put((request_id, "ok", result))


class _Worker:
    """Wraps a subprocess with input/output queues for one connection."""

    def __init__(self, timeout: float = 30.0) -> None:
        self._timeout = timeout
        self._worker: Any = None
        self._input_queue: Any = None
        self._output_queue: Any = None
        self._request_counter: int = 0
        self._start()

    def _start(self) -> None:
        ctx = mp.get_context("spawn")
        input_queue: Any = ctx.Queue()
        output_queue: Any = ctx.Queue()
        worker: Any = ctx.Process(
            target=_build_worker,
            args=(input_queue, output_queue),
            daemon=True,
            name="occ-build-worker",
        )
        worker.start()
        self._input_queue = input_queue
        self._output_queue = output_queue
        self._worker = worker

    def _kill(self) -> None:
        worker = self._worker
        if worker is not None:
            try:
                worker.kill()
                worker.join(timeout=2)
            except Exception:
                pass
            try:
                worker.close()
            except Exception:
                pass
        self._worker = None
        self._input_queue = None
        self._output_queue = None

    def _restart(self) -> None:
        self._kill()
        self._start()

    def build(
        self,
        spec: dict,
        doc_id: str | None = None,
        pick_boundary: int | None = None,
        rollback_position: int | None = None,
        isolator_request_id: str | None = None,
    ) -> dict:
        """Run build() in the subprocess.  Returns the result dict."""
        if self._worker is None or not self._worker.is_alive():
            self._restart()

        assert self._input_queue is not None
        assert self._output_queue is not None

        self._request_counter += 1
        request_id = str(self._request_counter)

        try:
            self._input_queue.put(
                (request_id, doc_id, spec, pick_boundary, rollback_position, isolator_request_id)
            )
        except (BrokenPipeError, EOFError, OSError):
            self._restart()
            return error_result("build worker unavailable (restarted)")

        try:
            rid, status, payload = self._output_queue.get(timeout=self._timeout)
        except _QueueEmpty:
            logger.error("Build worker timed out after %.1fs", self._timeout)
            self._kill()
            self._start()
            return error_result("build timed out")
        except (BrokenPipeError, EOFError, ConnectionResetError, OSError):
            logger.error("Build worker crashed (broken pipe)")
            self._restart()
            return error_result("build process crashed")
        except Exception as exc:
            logger.exception("Unexpected error reading from worker")
            self._restart()
            return error_result(f"build communication error: {exc}")

        if rid != request_id:
            logger.error(
                "Build worker response id mismatch: expected %s, got %s",
                request_id, rid,
            )
            return error_result("build response id mismatch")

        if status == "error":
            exc_msg = payload.get("exception", "unknown error") if isinstance(payload, dict) else str(payload)
            result_so_far = payload.get("result_so_far", {}) if isinstance(payload, dict) else {}
            if result_so_far:
                result_so_far["ok"] = False
                result_so_far["error"] = exc_msg
                result_so_far["code"] = "SOLVER_EXCEPTION"
                return result_so_far
            return error_result(str(exc_msg))

        return payload

    def clear_cache(self, doc_id: str | None = None) -> None:
        """Ask the worker to discard cached prev_state."""
        if self._worker is None or not self._worker.is_alive():
            return
        assert self._input_queue is not None
        try:
            self._input_queue.put(("__clear_cache__", doc_id, {}, None, None))
        except Exception:
            pass

    def shutdown(self) -> None:
        """Stop the worker process gracefully."""
        if self._worker is not None and self._worker.is_alive():
            assert self._input_queue is not None
            try:
                self._input_queue.put(None)
            except Exception:
                pass
            self._worker.join(timeout=3)
        self._kill()


class WorkerPool:
    """Manages OCP worker subprocesses with a bounded pool.

    At most max_workers subprocesses run concurrently.  When the pool is
    full, the LRU idle worker is evicted to make room.  If all workers are
    in-flight (busy), the caller waits up to queue_timeout seconds before
    receiving a "solver busy" error.  An idle-reaper coroutine evicts
    workers that have been idle longer than idle_timeout.
    """

    def __init__(
        self,
        timeout: float = 30.0,
        max_workers: int | None = None,
        queue_timeout: float = 60.0,
        idle_timeout: float = 600.0,
    ) -> None:
        self._timeout = timeout
        self._max_workers = max_workers if max_workers is not None else (os.cpu_count() or 4)
        self._queue_timeout = queue_timeout
        self._idle_timeout = idle_timeout
        self._workers: dict[str, _Worker] = {}
        self._last_used: dict[str, float] = {}
        self._in_flight: dict[str, int] = {}
        self._condition: asyncio.Condition | None = None

    @property
    def _cond(self) -> asyncio.Condition:
        if self._condition is None:
            self._condition = asyncio.Condition()
        return self._condition

    async def acquire(self, cid: str) -> _Worker:
        """Get or create a worker for this connection.

        Evicts the LRU idle worker if the pool is full.  Waits up to
        queue_timeout if all workers are busy, then raises TimeoutError.
        """
        cond = self._cond
        evict_target: _Worker | None = None
        async with cond:
            if cid in self._workers:
                self._last_used[cid] = time.monotonic()
                return self._workers[cid]

            while len(self._workers) >= self._max_workers:
                idle = [c for c in self._workers if not self._in_flight.get(c, 0)]
                if idle:
                    lru = min(idle, key=lambda c: self._last_used.get(c, 0.0))
                    evict_target = self._workers.pop(lru)
                    self._last_used.pop(lru, None)
                    self._in_flight.pop(lru, None)
                    break
                # All workers busy — wait for a slot.
                try:
                    await asyncio.wait_for(cond.wait(), timeout=self._queue_timeout)
                except asyncio.TimeoutError:
                    raise asyncio.TimeoutError("solver busy: all workers in use")

            worker = _Worker(self._timeout)
            self._workers[cid] = worker
            self._last_used[cid] = time.monotonic()
            self._in_flight[cid] = 0

        if evict_target is not None:
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(None, evict_target.shutdown)
        return worker

    def mark_in_flight(self, cid: str) -> None:
        """Increment in-flight count when a build starts."""
        self._in_flight[cid] = self._in_flight.get(cid, 0) + 1
        self._last_used[cid] = time.monotonic()

    async def mark_done(self, cid: str) -> None:
        """Decrement in-flight count and notify any waiting acquirers."""
        cond = self._cond
        async with cond:
            self._in_flight[cid] = max(0, self._in_flight.get(cid, 0) - 1)
            self._last_used[cid] = time.monotonic()
            cond.notify_all()

    async def release(self, cid: str) -> None:
        """Remove the worker for this connection and notify waiters."""
        cond = self._cond
        worker: _Worker | None = None
        async with cond:
            worker = self._workers.pop(cid, None)
            self._last_used.pop(cid, None)
            self._in_flight.pop(cid, None)
            cond.notify_all()
        if worker is not None:
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(None, worker.shutdown)

    async def idle_reaper(self) -> None:
        """Background coroutine: evict workers idle longer than idle_timeout."""
        interval = min(60.0, max(0.01, self._idle_timeout / 10))
        while True:
            await asyncio.sleep(interval)
            cond = self._cond
            to_evict: list[_Worker] = []
            async with cond:
                now = time.monotonic()
                for c in list(self._workers):
                    if self._in_flight.get(c, 0):
                        continue
                    idle_secs = now - self._last_used.get(c, now)
                    if idle_secs > self._idle_timeout:
                        to_evict.append(self._workers.pop(c))
                        self._last_used.pop(c, None)
                        self._in_flight.pop(c, None)
                if to_evict:
                    cond.notify_all()
            if to_evict:
                loop = asyncio.get_running_loop()
                for w in to_evict:
                    await loop.run_in_executor(None, w.shutdown)


async def handler(websocket: Any, pool: WorkerPool) -> None:
    """Handle one daemon WebSocket connection.

    Messages are JSON with a request_id for correlation.
    The daemon dispatches to the connection's dedicated OCP worker.
    worker.build() is offloaded to a thread executor because it contains
    blocking mp.Queue calls that would stall the asyncio event loop.
    """
    cid = str(uuid.uuid4())
    try:
        worker = await pool.acquire(cid)
    except asyncio.TimeoutError:
        logger.warning("WS handler: solver busy, closing connection %s", cid)
        return

    loop = asyncio.get_running_loop()
    try:
        async for raw in websocket:
            request = json.loads(raw)
            request_id = request.get("request_id", "?")
            msg_type = request.get("type")

            if msg_type == "solve":
                pool.mark_in_flight(cid)
                try:
                    result = await loop.run_in_executor(
                        None,
                        worker.build,
                        request.get("spec", {}),
                        request.get("doc_id"),
                        request.get("pick_boundary"),
                        request.get("rollback_position"),
                        request_id,
                    )
                finally:
                    await pool.mark_done(cid)
                if result.get("ok") is False:
                    await websocket.send(json.dumps({
                        "request_id": request_id,
                        "ok": False,
                        "error": result.get("error", "unknown error"),
                        "code": result.get("code", "SOLVER_ERROR"),
                    }))
                else:
                    geometry_bytes = result.pop("_geometry_bytes", None)
                    has_geometry = bool(geometry_bytes and len(geometry_bytes) > 4)
                    await websocket.send(json.dumps({
                        "request_id": request_id,
                        "ok": True,
                        "has_geometry": has_geometry,
                        "payload": result,
                    }))
                    if has_geometry:
                        await websocket.send(geometry_bytes)

            elif msg_type == "clear_cache":
                try:
                    await loop.run_in_executor(None, worker.clear_cache, request.get("doc_id"))
                    await websocket.send(json.dumps({
                        "request_id": request_id,
                        "ok": True,
                    }))
                except Exception as exc:
                    await websocket.send(json.dumps({
                        "request_id": request_id,
                        "ok": False,
                        "error": str(exc),
                        "code": "CACHE_CLEAR_FAILED",
                    }))

            else:
                await websocket.send(json.dumps({
                    "request_id": request_id,
                    "ok": False,
                    "error": f"unknown message type: {msg_type}",
                    "code": "UNKNOWN_MSG_TYPE",
                }))
    except Exception:
        logger.exception("WS handler error for connection %s", cid)
    finally:
        await pool.release(cid)


async def main_async(address: str, port: int, timeout: float) -> None:
    """Run the solver daemon until cancelled."""
    max_workers = int(os.environ.get("OVERSOLVED_SOLVER_MAX_WORKERS", str(os.cpu_count() or 4)))
    idle_timeout = float(os.environ.get("OVERSOLVED_SOLVER_IDLE_TIMEOUT", "600"))
    pool = WorkerPool(timeout=timeout, max_workers=max_workers, idle_timeout=idle_timeout)
    reaper = asyncio.create_task(pool.idle_reaper())
    try:
        async with serve(lambda ws: handler(ws, pool), address, port, max_size=None):
            await asyncio.get_running_loop().create_future()
    finally:
        reaper.cancel()


def main() -> None:
    """Entry point for the oversolved-solver console script."""
    import argparse
    parser = argparse.ArgumentParser(description="Oversolved solver daemon")
    parser.add_argument("--host", default="127.0.0.1", help="Listen address (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=9100, help="Listen port (default: 9100)")
    parser.add_argument("--timeout", type=float, default=30.0, help="Per-request timeout in seconds (default: 30.0)")
    parser.add_argument("--debug", action="store_true", help="Run in debug mode (verbose logging)")
    args = parser.parse_args()

    level = logging.DEBUG if args.debug else logging.INFO
    logging.basicConfig(level=level, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    logger.info("Starting solver daemon on %s:%s", args.host, args.port)
    if args.debug:
        logger.debug("Debug logging enabled")
    asyncio.run(main_async(args.host, args.port, args.timeout))
