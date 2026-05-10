"""Subprocess isolation for build() — prevents OCC segfaults from killing
the server.

OCC (Open CASCADE) operations can cause SIGSEGV that Python try/except
cannot catch.  This module works around that by running the CAD kernel
inside a dedicated worker subprocess: if the kernel crashes, only the
worker dies; the server stays up and returns a normal solver error.

CAUTION — temporary measure
    The subprocess approach carries serialisation overhead and loses
    prev_state on worker restart (full rebuild on next request).  It is
    acceptable for local / single-tenant deployments but is NOT the
    intended production pattern.  The production architecture puts the
    solver kernel in a *separate, deaf-and-blind Docker container* that:
      - receives YAML specs over the network (no direct DB access),
      - runs build() plus in-memory memcaching,
      - returns tessellated geometry,
      - is stateless — a crash is handled by the orchestrator restarting
        the container.
    When that containerized kernel is in place, BuildIsolator can be
    removed and solver_ws can call build() directly again.

Memcaching
    The worker keeps prev_state (BuildState with OCC shapes) keyed by
    doc_id, exactly as the old in-process session_cache did.  Each
    WebSocket connection owns its own worker, so cross-connection cache
    sharing is not expected (and was not present before either).
    clear_cache messages from the frontend are forwarded to the worker.
"""

import logging
import multiprocessing as mp
import queue
import time
import traceback
from typing import Any

logger = logging.getLogger(__name__)


def _build_worker(input_queue: Any, output_queue: Any) -> None:
    """Long-lived worker process that runs build() requests.

    Import happens inside the worker so that OCC is loaded in the
    subprocess, keeping the main server process free of native code.
    """
    from oversolved.kernel.builder import build  # noqa: PLC0415

    prev_states: dict[str, Any] = {}  # doc_id → BuildState

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


class BuildIsolator:
    """Runs build() in a subprocess to protect the server from OCC crashes.

    If the worker dies (SIGSEGV, SIGABRT, etc.) the isolator automatically
    spawns a fresh worker.  The current request receives an error; subsequent
    requests proceed normally.

    Usage::

        isolator = BuildIsolator()
        result = isolator.build(spec, doc_id="doc-uuid")
    """

    def __init__(self, timeout: float = 30.0) -> None:
        self._timeout = timeout
        self._worker: Any = None
        self._input_queue: Any = None
        self._output_queue: Any = None
        self._request_counter: int = 0
        self._start_worker()

    def _start_worker(self) -> None:
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
        logger.info("Started OCC build worker (pid=%d)", worker.pid)

    def _kill_worker(self) -> None:
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

    def _restart_worker(self) -> None:
        logger.warning("Restarting crashed OCC build worker")
        self._kill_worker()
        self._start_worker()

    def build(
        self,
        spec: dict,
        doc_id: str | None = None,
        pick_boundary: int | None = None,
        rollback_position: int | None = None,
    ) -> dict:
        """Run build() isolated in the worker subprocess.

        Returns the same dict shape as builder.build() but without
        ``_build_state`` and ``_body_shapes`` (both are kept in the
        worker for the next incremental call).

        On worker crash or timeout, returns ``{"solve_ms": 0, "result":
        {"_error": "..."}, "bodies": {}}`` so callers always receive a
        structurally valid response.
        """
        if self._worker is None or not self._worker.is_alive():
            self._restart_worker()

        assert self._input_queue is not None
        assert self._output_queue is not None

        self._request_counter += 1
        request_id = str(self._request_counter)

        try:
            self._input_queue.put(
                (request_id, doc_id, spec, pick_boundary, rollback_position)
            )
        except (BrokenPipeError, EOFError, OSError):
            self._restart_worker()
            return _error_response("build worker unavailable (restarted)")

        try:
            rid, status, payload = self._output_queue.get(timeout=self._timeout)
        except queue.Empty:
            logger.error("Build worker timed out after %.1fs", self._timeout)
            self._kill_worker()
            self._start_worker()
            return _error_response("build timed out")
        except (BrokenPipeError, EOFError, ConnectionResetError, OSError):
            logger.error("Build worker crashed (broken pipe)")
            self._restart_worker()
            return _error_response("build process crashed")
        except Exception as exc:
            logger.exception("Unexpected error reading from worker")
            self._restart_worker()
            return _error_response(f"build communication error: {exc}")

        if rid != request_id:
            logger.error(
                "Build worker response id mismatch: expected %s, got %s",
                request_id, rid,
            )
            return _error_response("build response id mismatch")

        if status == "error":
            exc_msg = payload.get("exception", "unknown error") if isinstance(payload, dict) else str(payload)
            # Return the partial result if available, so the frontend gets
            # a consistent shape even on error.
            result_so_far = payload.get("result_so_far", {}) if isinstance(payload, dict) else {}
            if result_so_far:
                return result_so_far
            return _error_response(str(exc_msg))

        return payload

    def clear_cache(self, doc_id: str | None = None) -> None:
        """Ask the worker to discard cached prev_state.

        If *doc_id* is None the entire cache is cleared.
        """
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
        self._kill_worker()


def _error_response(message: str) -> dict:
    return {
        "solve_ms": 0,
        "result": {"_error": message},
        "bodies": {},
    }
