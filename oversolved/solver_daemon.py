"""Standalone solver daemon.

Blind and deaf: no database, no outbound network.  Receives solve requests
over a WebSocket, dispatches them to OCP worker subprocesses, returns
results.  OCP lives only in worker subprocesses for crash isolation.
"""

import asyncio
import json
import logging
import multiprocessing as mp
import time
import traceback
import uuid
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

    prev_states: dict[str, Any] = {}

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
                prev_states.pop(doc_id, None)
            else:
                prev_states.clear()
            continue

        try:
            request_id, doc_id, spec, pick_boundary, rollback_position = msg
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
                prev_states[doc_id] = new_state

            output_queue.put((request_id, "ok", result))
        except Exception as exc:
            tb = traceback.format_exc()
            logger.warning("Build worker exception: %s\n%s", exc, tb)
            duration_ms = round((time.perf_counter() - t0) * 1000, 1)
            error_result: dict[str, Any] = {
                "solve_ms": duration_ms,
                "result": {},
                "bodies": {},
            }
            try:
                output_queue.put(
                    (request_id, "error", {
                        "exception": str(exc),
                        "traceback": tb,
                        "result_so_far": error_result,
                    })
                )
            except Exception:
                logger.exception("Worker output queue error")


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
                (request_id, doc_id, spec, pick_boundary, rollback_position)
            )
        except (BrokenPipeError, EOFError, OSError):
            self._restart()
            return _error_result("build worker unavailable (restarted)")

        try:
            rid, status, payload = self._output_queue.get(timeout=self._timeout)
        except _QueueEmpty:
            logger.error("Build worker timed out after %.1fs", self._timeout)
            self._kill()
            self._start()
            return _error_result("build timed out")
        except (BrokenPipeError, EOFError, ConnectionResetError, OSError):
            logger.error("Build worker crashed (broken pipe)")
            self._restart()
            return _error_result("build process crashed")
        except Exception as exc:
            logger.exception("Unexpected error reading from worker")
            self._restart()
            return _error_result(f"build communication error: {exc}")

        if rid != request_id:
            logger.error(
                "Build worker response id mismatch: expected %s, got %s",
                request_id, rid,
            )
            return _error_result("build response id mismatch")

        if status == "error":
            exc_msg = payload.get("exception", "unknown error") if isinstance(payload, dict) else str(payload)
            result_so_far = payload.get("result_so_far", {}) if isinstance(payload, dict) else {}
            if result_so_far:
                return result_so_far
            return _error_result(str(exc_msg))

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


def _error_result(message: str) -> dict:
    return {
        "solve_ms": 0,
        "result": {"_error": message},
        "bodies": {},
    }


class WorkerPool:
    """Manages OCP worker subprocesses.

    Each WebSocket connection gets a dedicated worker.  If a worker crashes
    (SIGSEGV), it is restarted on the next request.
    """

    def __init__(self, timeout: float = 30.0) -> None:
        self._timeout = timeout
        self._workers: dict[str, _Worker] = {}

    def acquire(self, connection_id: str) -> _Worker:
        """Get or create a worker for this connection."""
        if connection_id not in self._workers:
            self._workers[connection_id] = _Worker(self._timeout)
        return self._workers[connection_id]

    def release(self, connection_id: str) -> None:
        worker = self._workers.pop(connection_id, None)
        if worker:
            worker.shutdown()


async def handler(websocket: Any, pool: WorkerPool) -> None:
    """Handle one daemon WebSocket connection.

    Messages are JSON with a request_id for correlation.
    The daemon dispatches to the connection's dedicated OCP worker.
    worker.build() is offloaded to a thread executor because it contains
    blocking mp.Queue calls that would stall the asyncio event loop.
    """
    cid = str(uuid.uuid4())
    worker = pool.acquire(cid)
    loop = asyncio.get_running_loop()
    try:
        async for raw in websocket:
            request = json.loads(raw)
            request_id = request.get("request_id", "?")
            msg_type = request.get("type")

            if msg_type == "solve":
                try:
                    result = await loop.run_in_executor(
                        None,
                        worker.build,
                        request.get("spec", {}),
                        request.get("doc_id"),
                        request.get("pick_boundary"),
                        request.get("rollback_position"),
                    )
                    await websocket.send(json.dumps({
                        "request_id": request_id,
                        "status": "ok",
                        "payload": result,
                    }))
                except Exception as exc:
                    logger.exception("Solver error for request %s", request_id)
                    await websocket.send(json.dumps({
                        "request_id": request_id,
                        "status": "error",
                        "payload": {"exception": str(exc)},
                    }))

            elif msg_type == "clear_cache":
                try:
                    await loop.run_in_executor(None, worker.clear_cache, request.get("doc_id"))
                    await websocket.send(json.dumps({
                        "request_id": request_id,
                        "status": "ok",
                    }))
                except Exception as exc:
                    await websocket.send(json.dumps({
                        "request_id": request_id,
                        "status": "error",
                        "payload": {"exception": str(exc)},
                    }))

            else:
                await websocket.send(json.dumps({
                    "request_id": request_id,
                    "status": "error",
                    "payload": {"exception": f"unknown message type: {msg_type}"},
                }))
    finally:
        pool.release(cid)


async def main_async(address: str, port: int, timeout: float) -> None:
    """Run the solver daemon until cancelled."""
    pool = WorkerPool(timeout=timeout)
    async with serve(lambda ws: handler(ws, pool), address, port):
        await asyncio.get_running_loop().create_future()


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
