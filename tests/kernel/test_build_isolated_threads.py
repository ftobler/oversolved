"""Unit tests for BuildIsolator threading fixes -- run without a real daemon."""

import json
import struct
import threading
import time
from unittest.mock import MagicMock, patch

from oversolved.kernel.build_isolated import BuildIsolator


def _make_text_frame(request_id: str, payload: dict | None = None, has_geometry: bool = False) -> str:
    return json.dumps({
        "request_id": request_id,
        "status": "ok",
        "payload": payload or {"some": "data"},
        "has_geometry": has_geometry,
    })


def _make_error_frame(request_id: str, exception: str = "boom") -> str:
    return json.dumps({
        "request_id": request_id,
        "status": "error",
        "payload": {"exception": exception},
    })


def _make_binary_frame(request_id: str) -> bytes:
    header = json.dumps({"request_id": request_id}).encode()
    padded_len = len(header)
    return struct.pack(">I", padded_len) + header


def _make_isolator_with_mock_ws(recv_sequence: list) -> tuple[BuildIsolator, MagicMock]:
    """Build a BuildIsolator with a mock WebSocket that returns recv_sequence items."""
    mock_ws = MagicMock()
    recv_iter = iter(recv_sequence + [Exception("done")])

    def fake_recv():
        val = next(recv_iter)
        if isinstance(val, type) and issubclass(val, Exception):
            raise val("done")
        if isinstance(val, Exception):
            raise val
        return val

    mock_ws.recv.side_effect = fake_recv

    with patch("oversolved.kernel.build_isolated.connect", return_value=mock_ws):
        isolator = BuildIsolator(host="127.0.0.1", port=9999, timeout=2.0)
    return isolator, mock_ws


# ─── Request counter uniqueness ───


def test_concurrent_requests_have_unique_ids():
    """All request IDs generated concurrently must be unique."""
    mock_ws = MagicMock()
    mock_ws.recv.side_effect = lambda: (_ for _ in ()).throw(Exception("done"))

    with patch("oversolved.kernel.build_isolated.connect", return_value=mock_ws):
        isolator = BuildIsolator(host="127.0.0.1", port=9999, timeout=0.05)  # noqa: F841

    ids = []
    lock = threading.Lock()

    def grab_id():
        with isolator._lock:
            isolator._request_counter += 1
            rid = str(isolator._request_counter)
        with lock:
            ids.append(rid)

    threads = [threading.Thread(target=grab_id) for _ in range(50)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(ids) == len(set(ids)), "Duplicate request IDs detected"


# ─── Reconnect race ───


def test_reconnect_called_only_once_when_two_threads_race():
    """When two threads both see _ws=None, connect() must be called exactly once."""
    connect_calls = []

    def slow_connect(*args, **kwargs):
        connect_calls.append(1)
        time.sleep(0.05)
        mock_ws = MagicMock()
        mock_ws.recv.side_effect = Exception("done")
        return mock_ws

    with patch("oversolved.kernel.build_isolated.connect", side_effect=slow_connect):
        isolator = BuildIsolator(host="127.0.0.1", port=9999, timeout=0.1)
        connect_calls.clear()

        # Force _ws to None so both threads will try to reconnect
        with isolator._lock:
            isolator._ws = None
            isolator._reconnecting = False

        def try_reconnect():
            isolator._try_reconnect()

        t1 = threading.Thread(target=try_reconnect)
        t2 = threading.Thread(target=try_reconnect)
        t1.start()
        t2.start()
        t1.join()
        t2.join()

    assert len(connect_calls) == 1, f"connect() called {len(connect_calls)} times, expected 1"


# ─── Unknown request_id logging ───


def test_unknown_request_id_text_frame_logs_warning(caplog):
    """A text frame with an unknown request_id should log a warning."""
    import logging
    mock_ws = MagicMock()
    frames = [_make_text_frame("nonexistent-id")]
    recv_iter = iter(frames + [Exception("done")])

    def fake_recv():
        val = next(recv_iter)
        if isinstance(val, Exception):
            raise val
        return val

    mock_ws.recv.side_effect = fake_recv

    with patch("oversolved.kernel.build_isolated.connect", return_value=mock_ws):
        with caplog.at_level(logging.WARNING, logger="oversolved.kernel.build_isolated"):
            BuildIsolator(host="127.0.0.1", port=9999, timeout=0.1)
            time.sleep(0.1)  # let the reader process the frame

    assert any("nonexistent-id" in r.message for r in caplog.records), (
        "Expected warning about unknown request_id"
    )


def test_unknown_request_id_binary_frame_logs_warning(caplog):
    """A binary frame with an unknown request_id should log a warning."""
    import logging
    mock_ws = MagicMock()
    frames = [_make_binary_frame("no-such-request")]
    recv_iter = iter(frames + [Exception("done")])

    def fake_recv():
        val = next(recv_iter)
        if isinstance(val, Exception):
            raise val
        return val

    mock_ws.recv.side_effect = fake_recv

    with patch("oversolved.kernel.build_isolated.connect", return_value=mock_ws):
        with caplog.at_level(logging.WARNING, logger="oversolved.kernel.build_isolated"):
            BuildIsolator(host="127.0.0.1", port=9999, timeout=0.1)
            time.sleep(0.1)

    assert any("no-such-request" in r.message for r in caplog.records), (
        "Expected warning about unknown request_id in binary frame"
    )


# ─── Entry mutation under lock ───


def test_send_request_resolves_after_text_frame():
    """A send_request call should resolve when the text frame arrives (no geometry)."""
    mock_ws = MagicMock()
    sent_msgs = []

    def fake_send(data):
        msg = json.loads(data)
        sent_msgs.append(msg)
        # Simulate the daemon echoing back a response
        frame = _make_text_frame(msg["request_id"], {"status": "ok"}, has_geometry=False)
        threading.Timer(0.01, lambda: inject_frame(frame)).start()

    injected = []

    def inject_frame(frame):
        injected.append(frame)

    mock_ws.send.side_effect = fake_send
    recv_barrier = threading.Event()

    def fake_recv():
        if injected:
            return injected.pop(0)
        recv_barrier.wait(timeout=1.0)
        raise Exception("done")

    mock_ws.recv.side_effect = fake_recv

    with patch("oversolved.kernel.build_isolated.connect", return_value=mock_ws):
        isolator = BuildIsolator(host="127.0.0.1", port=9999, timeout=1.0)

    # Inject text response
    sent_msgs.clear()
    response_frames: list[str] = []

    original_handle = isolator._handle_text_frame

    def intercept_handle(raw):
        response_frames.append(raw)
        original_handle(raw)

    isolator._handle_text_frame = intercept_handle  # type: ignore[method-assign]

    # Register a pending entry manually and resolve it
    event = threading.Event()
    entry: dict = {
        "event": event,
        "result": None,
        "geometry_bytes": None,
        "expects_geometry": False,
        "json_done": False,
    }
    with isolator._lock:
        isolator._pending["test-99"] = entry

    frame = _make_text_frame("test-99", {"answer": 42}, has_geometry=False)
    isolator._handle_text_frame(frame)

    assert event.is_set()
    assert entry["result"]["answer"] == 42


def test_cancel_pending_sets_all_events():
    """_cancel_pending must signal all pending events."""
    mock_ws = MagicMock()
    mock_ws.recv.side_effect = Exception("done")

    with patch("oversolved.kernel.build_isolated.connect", return_value=mock_ws):
        isolator = BuildIsolator(host="127.0.0.1", port=9999, timeout=0.1)

    events = [threading.Event() for _ in range(5)]
    for i, ev in enumerate(events):
        isolator._pending[str(i)] = {
            "event": ev,
            "result": None,
            "geometry_bytes": None,
            "expects_geometry": False,
            "json_done": False,
        }

    isolator._cancel_pending("test cancel")

    for ev in events:
        assert ev.is_set(), "Event not set after _cancel_pending"
    assert isolator._pending == {}


def test_ws_set_none_on_connection_loss():
    """After the reader loop exits due to an exception, _ws should be None."""
    mock_ws = MagicMock()
    mock_ws.recv.side_effect = Exception("connection lost")

    with patch("oversolved.kernel.build_isolated.connect", return_value=mock_ws):
        isolator = BuildIsolator(host="127.0.0.1", port=9999, timeout=0.1)

    # Give reader thread time to process the exception
    time.sleep(0.1)
    assert isolator._ws is None, "_ws should be None after connection loss"
