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
import struct

from oversolved.kernel.errors import error_result
import threading
from typing import Any

from websockets.sync.client import connect

logger = logging.getLogger(__name__)


class BuildIsolator:
    """Relays build requests to the solver daemon over WebSocket.

    Uses the synchronous websockets client in a connection thread.  Each public
    method sends a request and blocks on a threading.Event for the response.

    Threading invariants:
    - _request_counter is incremented under _lock to guarantee unique IDs.
    - Entry fields (result, json_done, etc.) are mutated only under _lock.
    - _ws is captured under _lock before sending to avoid a concurrent
      reconnect replacing the socket between check and use.
    - _reconnecting flag prevents duplicate connect() calls when multiple
      threads notice _ws is None simultaneously.
    """

    def __init__(self, host: str = "127.0.0.1", port: int = 9100, timeout: float = 30.0) -> None:
        self._address = f"ws://{host}:{port}"
        self._timeout = timeout
        self._request_counter = 0
        self._lock = threading.Lock()
        self._pending: dict[str, dict] = {}
        self._ws: Any = None
        self._reconnecting = False
        self._reader_thread: threading.Thread | None = None
        self._connect()

    def _connect(self) -> None:
        """Establish the WebSocket connection and start the reader thread."""
        try:
            self._ws = connect(self._address, close_timeout=5, max_size=None)
        except Exception as exc:
            logger.warning("Failed to connect to solver daemon: %s", exc)
            self._ws = None
            return
        self._reader_thread = threading.Thread(target=self._read_loop, daemon=True)
        self._reader_thread.start()
        logger.info("Connected to solver daemon at %s", self._address)

    def _read_loop(self) -> None:
        """Read responses from the WebSocket and resolve pending requests.

        The daemon sends two frames per solve: a text JSON frame with metadata
        and a binary frame with packed geometry.  Both must arrive before the
        pending event is signalled.
        """
        ws = self._ws
        if ws is None:
            return
        while True:
            try:
                raw = ws.recv(timeout=30)
            except TimeoutError:
                try:
                    ws.ping()
                except Exception:
                    break
                continue
            except Exception:
                logger.warning("Solver daemon connection lost")
                with self._lock:
                    if self._ws is ws:
                        self._ws = None
                self._cancel_pending("solver daemon disconnected")
                break
            if raw is None:
                logger.warning("Solver daemon connection closed")
                with self._lock:
                    if self._ws is ws:
                        self._ws = None
                self._cancel_pending("solver daemon disconnected")
                break

            if isinstance(raw, bytes):
                self._handle_binary_frame(raw)
            else:
                self._handle_text_frame(raw)

    def _handle_text_frame(self, raw: str) -> None:
        """Process a JSON text frame from the daemon."""
        try:
            response = json.loads(raw)
        except json.JSONDecodeError:
            return
        request_id = response.get("request_id", "")
        event_to_set = None
        with self._lock:
            entry = self._pending.get(request_id)
            if entry is None:
                if request_id:
                    logger.warning("Received text frame for unknown request_id %r", request_id)
                return
            if response.get("ok") is False:
                entry["result"] = error_result(
                    response.get("error", "solver error"),
                    response.get("code", "SOLVER_ERROR"),
                )
                entry["json_done"] = True
                entry["expects_geometry"] = False
                event_to_set = entry["event"]
            else:
                entry["result"] = response.get("payload", {})
                entry["json_done"] = True
                entry["expects_geometry"] = response.get("has_geometry", False)
                if not entry["expects_geometry"]:
                    event_to_set = entry["event"]
                elif entry["geometry_bytes"] is not None:
                    # Binary frame arrived before text frame -- resolve now.
                    entry["result"]["_geometry_bytes"] = entry["geometry_bytes"]
                    event_to_set = entry["event"]
        if event_to_set is not None:
            event_to_set.set()

    def _handle_binary_frame(self, raw: bytes) -> None:
        """Process a binary geometry frame from the daemon.

        The first 4 bytes are the padded JSON header length (big-endian uint32).
        The header JSON contains a request_id field for correlation.
        """
        if len(raw) < 4:
            return
        padded_len = struct.unpack(">I", raw[:4])[0]
        if len(raw) < 4 + padded_len:
            return
        header_bytes = raw[4:4 + padded_len].rstrip(b"\x00")
        try:
            header = json.loads(header_bytes)
        except json.JSONDecodeError:
            return
        request_id = header.get("request_id", "")
        event_to_set = None
        with self._lock:
            entry = self._pending.get(request_id)
            if entry is None:
                if request_id:
                    logger.warning("Received binary frame for unknown request_id %r", request_id)
                return
            entry["geometry_bytes"] = raw
            if entry["json_done"]:
                entry["result"]["_geometry_bytes"] = raw
                event_to_set = entry["event"]
        if event_to_set is not None:
            event_to_set.set()

    def _cancel_pending(self, reason: str) -> None:
        """Cancel all pending requests with the given reason."""
        with self._lock:
            entries = list(self._pending.values())
            self._pending.clear()
            for entry in entries:
                entry["result"] = error_result(reason)
        for entry in entries:
            entry["event"].set()

    def _try_reconnect(self) -> None:
        """If the connection is lost, attempt to reconnect in place.

        Uses _reconnecting flag to ensure only one thread calls connect()
        even when multiple threads observe _ws is None simultaneously.
        """
        with self._lock:
            if self._ws is not None or self._reconnecting:
                return
            self._reconnecting = True
        try:
            ws = connect(self._address, close_timeout=5, max_size=None)
        except Exception:
            with self._lock:
                self._reconnecting = False
            return
        with self._lock:
            self._ws = ws
            self._reconnecting = False
        self._reader_thread = threading.Thread(target=self._read_loop, daemon=True)
        self._reader_thread.start()
        logger.info("Reconnected to solver daemon at %s", self._address)

    def _send_request(self, msg_type: str, **kwargs: Any) -> dict:
        """Send a request and wait for the matching response."""
        with self._lock:
            self._request_counter += 1
            request_id = str(self._request_counter)
        msg: dict[str, Any] = {"type": msg_type, "request_id": request_id, **kwargs}

        event = threading.Event()
        entry: dict = {
            "event": event,
            "result": None,
            "geometry_bytes": None,
            "expects_geometry": False,
            "json_done": False,
        }
        needs_reconnect = False
        with self._lock:
            if self._ws is None:
                needs_reconnect = True
            else:
                self._pending[request_id] = entry

        if needs_reconnect:
            self._try_reconnect()
            with self._lock:
                if self._ws is None:
                    return error_result("solver daemon not connected")
                self._pending[request_id] = entry

        with self._lock:
            ws = self._ws
        if ws is None:
            with self._lock:
                self._pending.pop(request_id, None)
            return error_result("solver daemon not connected")

        try:
            ws.send(json.dumps(msg))
        except Exception:
            with self._lock:
                self._pending.pop(request_id, None)
            return error_result("solver daemon send failed")

        if not event.wait(timeout=self._timeout):
            with self._lock:
                self._pending.pop(request_id, None)
            return error_result("solver request timed out")

        with self._lock:
            try:
                pending_entry = self._pending.pop(request_id)
            except KeyError:
                pending_entry = None
        if pending_entry is None or pending_entry["result"] is None:
            return error_result("solver request failed")
        return pending_entry["result"]

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
        with self._lock:
            if self._ws is not None:
                try:
                    self._ws.close()
                except Exception:
                    pass
                self._ws = None
