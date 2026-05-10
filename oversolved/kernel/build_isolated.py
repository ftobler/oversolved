"""WebSocket relay to solver daemon.

Relays build requests to the solver daemon over WebSocket instead of spawning
subprocesses directly.  The solver daemon manages OCP worker subprocesses for
crash isolation.

Public API (identical to the old subprocess-based version):
    build(spec, doc_id, pick_boundary, rollback_position) -> dict
    clear_cache(doc_id=None)
    shutdown()
"""

import json
import logging
import threading
from typing import Any

from websockets.sync.client import connect

logger = logging.getLogger(__name__)


class BuildIsolator:
    """Relays build requests to the solver daemon over WebSocket.

    Uses the synchronous websockets client in a connection thread.  Each public
    method sends a request and blocks on a threading.Event for the response.
    """

    def __init__(self, host: str = "127.0.0.1", port: int = 9100, timeout: float = 30.0) -> None:
        self._address = f"ws://{host}:{port}"
        self._timeout = timeout
        self._request_counter = 0
        self._lock = threading.Lock()
        self._pending: dict[str, dict] = {}
        self._ws: Any = None
        self._reader_thread: threading.Thread | None = None
        self._connect()

    def _connect(self) -> None:
        """Establish the WebSocket connection and start the reader thread."""
        try:
            self._ws = connect(self._address, close_timeout=5)
        except Exception as exc:
            logger.warning("Failed to connect to solver daemon: %s", exc)
            self._ws = None
            return
        self._reader_thread = threading.Thread(target=self._read_loop, daemon=True)
        self._reader_thread.start()
        logger.info("Connected to solver daemon at %s", self._address)

    def _read_loop(self) -> None:
        """Read responses from the WebSocket and resolve pending requests."""
        ws = self._ws
        if ws is None:
            return
        while True:
            try:
                raw = ws.recv()
            except Exception:
                logger.warning("Solver daemon connection lost")
                self._cancel_pending("solver daemon disconnected")
                break
            if raw is None:
                logger.warning("Solver daemon connection closed")
                self._cancel_pending("solver daemon disconnected")
                break
            try:
                response = json.loads(raw)
            except json.JSONDecodeError:
                continue
            request_id = response.get("request_id", "")
            with self._lock:
                entry = self._pending.get(request_id)
            if entry is None:
                continue
            status = response.get("status", "ok")
            if status == "error":
                payload = response.get("payload", {})
                entry["result"] = _error_result(
                    payload.get("exception", "solver error")
                )
            else:
                entry["result"] = response.get("payload", {})
            entry["event"].set()

    def _cancel_pending(self, reason: str) -> None:
        """Cancel all pending requests with the given reason."""
        with self._lock:
            entries = list(self._pending.values())
            self._pending.clear()
        for entry in entries:
            entry["result"] = _error_result(reason)
            entry["event"].set()

    def _send_request(self, msg_type: str, **kwargs: Any) -> dict:
        """Send a request and wait for the matching response."""
        self._request_counter += 1
        request_id = str(self._request_counter)
        msg: dict[str, Any] = {"type": msg_type, "request_id": request_id, **kwargs}

        event = threading.Event()
        with self._lock:
            if self._ws is None:
                return _error_result("solver daemon not connected")
            self._pending[request_id] = {"event": event, "result": None}

        try:
            self._ws.send(json.dumps(msg))
        except Exception:
            with self._lock:
                self._pending.pop(request_id, None)
            return _error_result("solver daemon send failed")

        if not event.wait(timeout=self._timeout):
            with self._lock:
                self._pending.pop(request_id, None)
            return _error_result("solver request timed out")

        with self._lock:
            entry = self._pending.pop(request_id, None)
        if entry is None or entry["result"] is None:
            return _error_result("solver request failed")
        return entry["result"]

    def build(
        self,
        spec: dict,
        doc_id: str | None = None,
        pick_boundary: int | None = None,
        rollback_position: int | None = None,
    ) -> dict:
        """Run build() on the solver daemon.  Blocking call."""
        return self._send_request(
            "solve",
            spec=spec,
            doc_id=doc_id,
            pick_boundary=pick_boundary,
            rollback_position=rollback_position,
        )

    def clear_cache(self, doc_id: str | None = None) -> None:
        """Ask the daemon (and its worker) to discard cached prev_state."""
        self._send_request("clear_cache", doc_id=doc_id)

    def shutdown(self) -> None:
        """Close the WebSocket connection."""
        if self._ws is not None:
            try:
                self._ws.close()
            except Exception:
                pass
            self._ws = None


def _error_result(message: str) -> dict:
    return {
        "solve_ms": 0,
        "result": {"_error": message},
        "bodies": {},
    }
