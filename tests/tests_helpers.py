"""Shared, network-free stand-ins for the WebSocket and Redis clients used by
the ``ingestion.horizon_worker`` tests.

Not collected by pytest (no ``test_`` prefix).
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any, Callable, Dict, List, Optional

from websockets.exceptions import ConnectionClosed


class FakeWebSocket:
    """Mimics the async WebSocket protocol surface the worker consumes."""

    def __init__(self, messages: List[str]) -> None:
        self._messages = list(messages)
        self.sent: List[str] = []

    async def send(self, payload: str) -> None:
        self.sent.append(payload)

    def __aiter__(self) -> "FakeWebSocket":
        return self

    async def __anext__(self) -> str:
        if self._messages:
            return self._messages.pop(0)
        raise StopAsyncIteration


def fake_connect(
    messages: Any = None,
    *,
    min_index: int = 1,
):
    """Build a drop-in replacement for ``ingestion.horizon_worker._ws_connect``.

    Parameters
    ----------
    messages:
        Either a list of frames to stream on every connection, or a callable
        ``messages(connection_index) -> list`` for per-connection control.
    min_index:
        Connections with index < this value raise ``ConnectionClosed`` on
        entry (simulating refused/reconnecting connections).

    Returns
    -------
    ``(connect, calls, last)`` where
    ``calls["connections"]`` counts connect attempts and ``last["ws"]``
    references the most recently created fake websocket.
    """
    calls: Dict[str, int] = {"connections": 0}
    last: Dict[str, Any] = {}

    @asynccontextmanager
    async def connect(url: str):
        calls["connections"] += 1
        index = calls["connections"]
        frame_list = messages(index) if callable(messages) else (messages or [])
        if index < min_index:
            raise ConnectionClosed(None, None)
        ws = FakeWebSocket(frame_list)
        last["ws"] = ws
        try:
            yield ws
        finally:
            pass

    return connect, calls, last


class RecordingRedis:
    """Records ``XADD`` calls; replaces the real async Redis client."""

    def __init__(self) -> None:
        self.entries: List[Dict[str, str]] = []
        self.calls: List[Dict[str, Any]] = []
        self.closed = False

    async def xadd(self, stream: str, fields: Dict[str, str], **kwargs: Any) -> str:
        self.entries.append(fields)
        self.calls.append({"stream": stream, **kwargs})
        return f"id-{len(self.entries)}"

    async def aclose(self) -> None:
        self.closed = True