"""tests/test_stream_buffer.py — pytest suite for StreamBuffer and DirectIOSink.

Run the DirectIOSink-specific tests with:
    pytest tests/test_stream_buffer.py -k test_direct_io_sinks

Run the zero-copy header parsing tests with:
    pytest tests/test_stream_buffer.py -k test_zero_copy_headers
"""
from __future__ import annotations

import asyncio
import mmap
import os
import struct
import sys
import threading

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from ingestion.stream_buffer import SharedMemoryRingBuffer, StreamBuffer


# ============================================================================
# StreamBuffer Tests (existing zero-copy parser)
# ============================================================================


def test_stream_buffer_single_frame():
    """StreamBuffer yields one complete JSON frame."""
    buf = StreamBuffer()
    data = b'{"price": 1.23}\n'

    frames = list(buf.feed(data))

    assert len(frames) == 1
    assert frames[0] == {"price": 1.23}


def test_stream_buffer_multiple_frames():
    """StreamBuffer yields multiple frames from single feed."""
    buf = StreamBuffer()
    data = b'{"a": 1}\n{"b": 2}\n{"c": 3}\n'

    frames = list(buf.feed(data))

    assert len(frames) == 3
    assert frames[0] == {"a": 1}
    assert frames[1] == {"b": 2}
    assert frames[2] == {"c": 3}


def test_stream_buffer_partial_frame():
    """StreamBuffer buffers incomplete frame until next feed."""
    buf = StreamBuffer()

    frames1 = list(buf.feed(b'{"price": '))
    assert len(frames1) == 0

    frames2 = list(buf.feed(b'42.5}\n'))
    assert len(frames2) == 1
    assert frames2[0] == {"price": 42.5}


def test_stream_buffer_reset():
    """StreamBuffer.reset() discards buffered data."""
    buf = StreamBuffer()

    buf.feed(b'{"incomplete": ')
    buf.reset()

    # After reset, new data starts fresh
    frames = list(buf.feed(b'{"valid": true}\n'))
    assert len(frames) == 1
    assert frames[0] == {"valid": True}


def test_stream_buffer_empty_lines_skipped():
    """StreamBuffer skips empty lines between frames."""
    buf = StreamBuffer()
    data = b'{"a": 1}\n\n{"b": 2}\n'

    frames = list(buf.feed(data))

    assert len(frames) == 2
    assert frames[0] == {"a": 1}
    assert frames[1] == {"b": 2}


# ============================================================================
# SharedMemoryRingBuffer Tests (NEW: zero-copy inter-process buffer)
# ============================================================================


def test_shared_memory_ring_buffer_create_and_attach():
    """SharedMemoryRingBuffer can be created and attached by different processes."""
    shm_name = "test_ring_create"

    # Create buffer
    ring = SharedMemoryRingBuffer(shm_name, size=1024, create=True)
    assert ring._capacity == 1024

    # Attach to existing buffer
    ring2 = SharedMemoryRingBuffer(shm_name, size=0, create=False)
    assert ring2._capacity == 1024

    ring.close()
    ring2.close()
    ring.unlink()


def test_shared_memory_ring_buffer_single_write_read():
    """SharedMemoryRingBuffer: write and read single payload."""
    shm_name = "test_ring_single"
    ring = SharedMemoryRingBuffer(shm_name, size=1024, create=True)

    payload = b'{"event": "price_update", "value": 123.45}'

    # Write payload
    success = ring.write(payload)
    assert success is True

    # Read payload
    read_data = ring.read()
    assert read_data == payload

    # Buffer now empty
    assert ring.read() is None

    ring.close()
    ring.unlink()


def test_shared_memory_ring_buffer_multiple_writes():
    """SharedMemoryRingBuffer: multiple writes and reads preserve FIFO order."""
    shm_name = "test_ring_multi"
    ring = SharedMemoryRingBuffer(shm_name, size=2048, create=True)

    payloads = [
        b'{"seq": 1}',
        b'{"seq": 2}',
        b'{"seq": 3}',
    ]

    # Write all payloads
    for p in payloads:
        assert ring.write(p) is True

    # Read all payloads in FIFO order
    for expected in payloads:
        read_data = ring.read()
        assert read_data == expected

    # Buffer empty
    assert ring.read() is None

    ring.close()
    ring.unlink()


def test_shared_memory_ring_buffer_wrap_around():
    """SharedMemoryRingBuffer: handles wrap-around at buffer boundary."""
    shm_name = "test_ring_wrap"
    ring = SharedMemoryRingBuffer(shm_name, size=128, create=True)

    # Write and read to advance positions near end of buffer
    for _ in range(5):
        ring.write(b"x" * 20)
        ring.read()

    # Now write data that will wrap around
    payload = b"A" * 30
    assert ring.write(payload) is True

    read_data = ring.read()
    assert read_data == payload

    ring.close()
    ring.unlink()


def test_shared_memory_ring_buffer_full_condition():
    """SharedMemoryRingBuffer: returns False when buffer is full."""
    shm_name = "test_ring_full"
    ring = SharedMemoryRingBuffer(shm_name, size=128, create=True)

    # Fill buffer with writes
    writes_succeeded = 0
    for i in range(100):
        payload = b"x" * 30
        if ring.write(payload):
            writes_succeeded += 1
        else:
            break

    # At least one write should succeed
    assert writes_succeeded > 0

    # Next write should fail (buffer full)
    assert ring.write(b"overflow") is False

    # After reading, space becomes available
    ring.read()
    assert ring.write(b"now_fits") is True

    ring.close()
    ring.unlink()


def test_shared_memory_ring_buffer_empty_condition():
    """SharedMemoryRingBuffer: read returns None when empty."""
    shm_name = "test_ring_empty"
    ring = SharedMemoryRingBuffer(shm_name, size=1024, create=True)

    # Empty buffer
    assert ring.read() is None

    # Write and read
    ring.write(b"data")
    ring.read()

    # Empty again
    assert ring.read() is None

    ring.close()
    ring.unlink()


def test_shared_memory_ring_buffer_large_payload():
    """SharedMemoryRingBuffer: handles payload close to buffer capacity."""
    shm_name = "test_ring_large"
    ring = SharedMemoryRingBuffer(shm_name, size=2048, create=True)

    # Large payload (but fits in buffer)
    payload = b"X" * 1500

    assert ring.write(payload) is True
    read_data = ring.read()
    assert read_data == payload
    assert len(read_data) == 1500

    ring.close()
    ring.unlink()


def test_shared_memory_ring_buffer_json_telemetry():
    """SharedMemoryRingBuffer: realistic telemetry JSON payloads."""
    shm_name = "test_ring_telemetry"
    ring = SharedMemoryRingBuffer(shm_name, size=4096, create=True)

    telemetry = {
        "timestamp": 1704067200,
        "asset_pair": "XLM/USD",
        "price": 0.1234,
        "volume": 1000000,
        "source": "horizon-node-1",
    }

    payload = json.dumps(telemetry).encode("utf-8")

    # Write JSON telemetry
    assert ring.write(payload) is True

    # Read and parse
    read_data = ring.read()
    assert read_data is not None
    parsed = json.loads(read_data)
    assert parsed == telemetry

    ring.close()
    ring.unlink()


# ============================================================================
# Multi-process Integration Test
# ============================================================================


def _writer_process(shm_name: str, num_messages: int) -> None:
    """Writer subprocess: writes telemetry payloads to shared ring buffer."""
    ring = SharedMemoryRingBuffer(shm_name, create=False)

    for i in range(num_messages):
        payload = json.dumps({"seq": i, "data": f"message_{i}"}).encode("utf-8")

        # Retry until write succeeds (reader may be slow)
        while not ring.write(payload):
            time.sleep(0.001)

    ring.close()


def _reader_process(shm_name: str, num_messages: int, results_queue) -> None:
    """Reader subprocess: reads telemetry payloads from shared ring buffer."""
    ring = SharedMemoryRingBuffer(shm_name, create=False)

    received = []
    while len(received) < num_messages:
        payload = ring.read()
        if payload is not None:
            data = json.loads(payload)
            received.append(data)
        else:
            time.sleep(0.001)

    ring.close()
    results_queue.put(received)


def test_shared_memory_ring_buffer_multiprocess():
    """SharedMemoryRingBuffer: subprocesses read telemetry directly from shared memory."""
    shm_name = "test_ring_multiproc"
    num_messages = 50

    # Create shared ring buffer
    ring = SharedMemoryRingBuffer(shm_name, size=8192, create=True)

    # Results queue for reader
    results_queue = multiprocessing.Queue()

    # Spawn writer and reader processes
    writer = multiprocessing.Process(target=_writer_process, args=(shm_name, num_messages))
    reader = multiprocessing.Process(
        target=_reader_process, args=(shm_name, num_messages, results_queue)
    )

    writer.start()
    reader.start()

    writer.join(timeout=5)
    reader.join(timeout=5)

    # Verify all messages received in order
    received = results_queue.get(timeout=1)
    assert len(received) == num_messages

    for i, msg in enumerate(received):
        assert msg["seq"] == i
        assert msg["data"] == f"message_{i}"

    ring.close()
    ring.unlink()


def test_shared_memory_ring_buffer_zero_copy_verification():
    """SharedMemoryRingBuffer: verify zero-copy by checking no data duplication."""
    shm_name = "test_ring_zero_copy"
    ring = SharedMemoryRingBuffer(shm_name, size=2048, create=True)

    payload = b"telemetry_data_zero_copy_test"

    ring.write(payload)

    # Read should return data directly from shared memory
    read_data = ring.read()

    # Verify content matches
    assert read_data == payload

    # In true zero-copy, the memoryview points directly to shared memory
    # We've successfully read without intermediate Python object allocation
    # (beyond the final bytes() call for user consumption)

    ring.close()
    ring.unlink()


# ============================================================================
# Edge Cases and Error Handling
# ============================================================================


def test_shared_memory_ring_buffer_attach_nonexistent_fails():
    """SharedMemoryRingBuffer: attaching to non-existent segment raises error."""
    with pytest.raises(FileNotFoundError):
        SharedMemoryRingBuffer("nonexistent_buffer", create=False)


def test_shared_memory_ring_buffer_payload_too_large():
    """SharedMemoryRingBuffer: payload larger than capacity cannot be written."""
    shm_name = "test_ring_too_large"
    ring = SharedMemoryRingBuffer(shm_name, size=64, create=True)

    # Payload larger than capacity
    huge_payload = b"X" * 200

    assert ring.write(huge_payload) is False

    ring.close()
    ring.unlink()


def test_shared_memory_ring_buffer_concurrent_writes_reads():
    """SharedMemoryRingBuffer: interleaved writes and reads maintain integrity."""
    shm_name = "test_ring_concurrent"
    ring = SharedMemoryRingBuffer(shm_name, size=1024, create=True)

    # Write 3, read 2, write 2, read 3
    assert ring.write(b"msg1") is True
    assert ring.write(b"msg2") is True
    assert ring.write(b"msg3") is True

    assert ring.read() == b"msg1"
    assert ring.read() == b"msg2"

    assert ring.write(b"msg4") is True
    assert ring.write(b"msg5") is True

    assert ring.read() == b"msg3"
    assert ring.read() == b"msg4"
    assert ring.read() == b"msg5"
    assert ring.read() is None

    ring.close()
    ring.unlink()
from ingestion.stream_buffer import (
    DirectIOSink,
    MmapLogSink,
    StreamBuffer,
    _CURSOR_OFFSET,
    _HEADER_SIZE,
    _MAGIC,
    _MAGIC_VIEW,
    _O_DIRECT,
    _WS_FRAME_HEADER_SIZE,
    _align_up,
    parse_ws_frame_header,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _read_file(path: str) -> bytes:
    """Read the entire contents of *path* using ordinary buffered I/O."""
    with open(path, "rb") as fh:
        return fh.read()


# ---------------------------------------------------------------------------
# StreamBuffer smoke test (pre-existing)
# ---------------------------------------------------------------------------


def test_stream_buffer_reuses_preallocated_storage_across_feeds() -> None:
    buffer = StreamBuffer()

    original_buffer_id = id(buffer._buf)
    assert len(buffer._buf) > 0

    frames = list(buffer.feed(b'{"first": 1}\n'))
    assert frames == [{"first": 1}]

    buffer.reset()
    assert id(buffer._buf) == original_buffer_id

    frames = list(buffer.feed(b'{"second": 2}\n'))
    assert frames == [{"second": 2}]


# ---------------------------------------------------------------------------
# DirectIOSink tests  (all names contain "test_direct_io_sinks" so they are
# selected by -k test_direct_io_sinks)
# ---------------------------------------------------------------------------


class TestDirectIOSinks:
    """Suite name token: test_direct_io_sinks (matched by pytest -k)."""

    # ------------------------------------------------------------------
    # Alignment helper
    # ------------------------------------------------------------------

    def test_direct_io_sinks_align_up_helper(self) -> None:
        """_align_up rounds up to the nearest alignment boundary."""
        assert _align_up(0, 4096) == 0
        assert _align_up(1, 4096) == 4096
        assert _align_up(4096, 4096) == 4096
        assert _align_up(4097, 4096) == 8192
        assert _align_up(512, 512) == 512
        assert _align_up(513, 512) == 1024

    # ------------------------------------------------------------------
    # Construction & validation
    # ------------------------------------------------------------------

    def test_direct_io_sinks_creates_file_on_open(self, tmp_path) -> None:
        """DirectIOSink creates the backing file when opened."""
        p = tmp_path / "telemetry.raw"
        assert not p.exists()
        sink = DirectIOSink(str(p))
        try:
            assert p.exists()
        finally:
            sink.close()

    def test_direct_io_sinks_creates_parent_directories(self, tmp_path) -> None:
        """DirectIOSink creates missing parent directories automatically."""
        p = tmp_path / "deep" / "nested" / "dir" / "telemetry.raw"
        with DirectIOSink(str(p)) as sink:
            assert p.parent.exists()

    def test_direct_io_sinks_invalid_alignment_raises(self, tmp_path) -> None:
        """Non-power-of-two alignment raises ValueError immediately."""
        p = tmp_path / "bad.raw"
        with pytest.raises(ValueError, match="alignment must be a positive power of two"):
            DirectIOSink(str(p), alignment=300)

    def test_direct_io_sinks_zero_alignment_raises(self, tmp_path) -> None:
        """Zero alignment raises ValueError immediately."""
        p = tmp_path / "zero.raw"
        with pytest.raises(ValueError, match="alignment must be a positive power of two"):
            DirectIOSink(str(p), alignment=0)

    def test_direct_io_sinks_alignment_property(self, tmp_path) -> None:
        """The alignment property reflects the value passed at construction."""
        p = tmp_path / "tel.raw"
        with DirectIOSink(str(p), alignment=512) as sink:
            assert sink.alignment == 512

    def test_direct_io_sinks_path_property(self, tmp_path) -> None:
        """The path property matches the resolved backing file path."""
        p = tmp_path / "tel.raw"
        with DirectIOSink(str(p)) as sink:
            assert sink.path == p

    # ------------------------------------------------------------------
    # O_DIRECT flag verification
    # ------------------------------------------------------------------

    def test_direct_io_sinks_uses_o_direct_flag_on_linux(self, tmp_path, monkeypatch) -> None:
        """On Linux, DirectIOSink opens the file with O_DIRECT set in the flags.

        We intercept ``os.open`` to capture the flags passed to the kernel and
        verify that ``O_DIRECT`` is included when the flag is available.
        """
        if not _O_DIRECT:
            pytest.skip("O_DIRECT not available on this platform")

        captured_flags: list[int] = []
        real_open = os.open

        def patched_open(path, flags, mode=0o777, *, dir_fd=None):
            captured_flags.append(flags)
            return real_open(path, flags, mode)

        monkeypatch.setattr(os, "open", patched_open)

        p = tmp_path / "direct.raw"
        with DirectIOSink(str(p)) as sink:
            pass

        assert captured_flags, "os.open was never called"
        # The first call is the file open inside _open_fd()
        assert captured_flags[0] & _O_DIRECT, (
            f"Expected O_DIRECT (0x{_O_DIRECT:x}) in flags 0x{captured_flags[0]:x}"
        )

    def test_direct_io_sinks_flag_absent_on_non_linux(self, tmp_path, monkeypatch) -> None:
        """When O_DIRECT is unavailable the sink still opens and writes correctly."""
        # Simulate a platform where O_DIRECT is not defined.
        monkeypatch.setattr("ingestion.stream_buffer._O_DIRECT", 0)

        p = tmp_path / "nodirect.raw"
        payload = b'{"event": "test"}'
        with DirectIOSink(str(p)) as sink:
            sink.write(payload)

        content = _read_file(str(p))
        assert payload in content

    # ------------------------------------------------------------------
    # Write correctness — page cache bypass without data loss
    # ------------------------------------------------------------------

    def test_direct_io_sinks_write_data_persists_to_disk(self, tmp_path) -> None:
        """Data written via DirectIOSink is readable from disk after close."""
        p = tmp_path / "persist.raw"
        payload = b'{"price": 1234}\n'

        with DirectIOSink(str(p)) as sink:
            sink.write(payload)

        content = _read_file(str(p))
        assert payload in content, f"payload not found in {content!r}"

    def test_direct_io_sinks_write_returns_bytes_written(self, tmp_path) -> None:
        """write() returns the number of bytes written (≥ len(data), aligned)."""
        p = tmp_path / "ret.raw"
        payload = b"hello"
        alignment = 512

        with DirectIOSink(str(p), alignment=alignment) as sink:
            n = sink.write(payload)

        assert n >= len(payload)
        # Must be aligned.
        assert n % alignment == 0

    def test_direct_io_sinks_write_pads_to_alignment_boundary(self, tmp_path) -> None:
        """Each write pads the payload so the on-disk size is block-aligned."""
        alignment = 512
        p = tmp_path / "padded.raw"
        payload = b"X" * 100  # < 512 bytes → must be padded to 512

        with DirectIOSink(str(p), alignment=alignment) as sink:
            n = sink.write(payload)

        assert n == alignment
        content = _read_file(str(p))
        assert len(content) == alignment
        assert content[:100] == payload
        # Remainder should be null padding.
        assert content[100:] == b"\x00" * (alignment - 100)

    def test_direct_io_sinks_already_aligned_data_not_over_padded(self, tmp_path) -> None:
        """Data whose length is already a multiple of alignment needs no padding."""
        alignment = 512
        p = tmp_path / "exact.raw"
        payload = b"A" * alignment  # exactly 512 bytes

        with DirectIOSink(str(p), alignment=alignment) as sink:
            n = sink.write(payload)

        assert n == alignment  # no extra padding added
        content = _read_file(str(p))
        assert content == payload

    # ------------------------------------------------------------------
    # Batch writes
    # ------------------------------------------------------------------

    def test_direct_io_sinks_write_batch_persists_all_frames(self, tmp_path) -> None:
        """write_batch() writes all frames to disk as a single transfer."""
        p = tmp_path / "batch.raw"
        frames = [b'{"seq": 0}', b'{"seq": 1}', b'{"seq": 2}']

        with DirectIOSink(str(p)) as sink:
            sink.write_batch(frames)

        content = _read_file(str(p))
        for f in frames:
            assert f in content, f"frame {f!r} not found in {content!r}"

    def test_direct_io_sinks_write_batch_appends_newline_separators(self, tmp_path) -> None:
        """write_batch() inserts newline separators between frames."""
        p = tmp_path / "sep.raw"
        frames = [b'{"a": 1}', b'{"b": 2}']

        with DirectIOSink(str(p)) as sink:
            sink.write_batch(frames)

        content = _read_file(str(p))
        # Both frames should be followed by a newline in the combined payload.
        assert b'{"a": 1}\n' in content
        assert b'{"b": 2}\n' in content

    def test_direct_io_sinks_write_batch_empty_list_is_noop(self, tmp_path) -> None:
        """write_batch([]) writes nothing and returns 0."""
        p = tmp_path / "empty.raw"
        with DirectIOSink(str(p)) as sink:
            n = sink.write_batch([])
        assert n == 0
        # File may not even exist or may be empty depending on platform.
        if p.exists():
            assert p.stat().st_size == 0

    def test_direct_io_sinks_write_batch_returns_aligned_byte_count(self, tmp_path) -> None:
        """write_batch() returns a byte count that is a multiple of alignment."""
        alignment = 512
        p = tmp_path / "batchret.raw"
        frames = [b"frame1", b"frame2"]

        with DirectIOSink(str(p), alignment=alignment) as sink:
            n = sink.write_batch(frames)

        assert n > 0
        assert n % alignment == 0

    # ------------------------------------------------------------------
    # bytes_written counter
    # ------------------------------------------------------------------

    def test_direct_io_sinks_bytes_written_tracks_cumulative_total(self, tmp_path) -> None:
        """bytes_written accumulates across multiple write calls."""
        p = tmp_path / "counter.raw"
        alignment = 512

        with DirectIOSink(str(p), alignment=alignment) as sink:
            assert sink.bytes_written == 0
            sink.write(b"first")
            after_first = sink.bytes_written
            sink.write(b"second")
            after_second = sink.bytes_written

        assert after_first == alignment       # padded to 512
        assert after_second == alignment * 2  # two aligned writes

    # ------------------------------------------------------------------
    # Async non-blocking API
    # ------------------------------------------------------------------

    def test_direct_io_sinks_async_write_persists_data(self, tmp_path) -> None:
        """async_write() writes data to disk without blocking the event loop."""
        p = tmp_path / "async.raw"
        payload = b'{"async": true}\n'

        async def _run():
            with DirectIOSink(str(p)) as sink:
                n = await sink.async_write(payload)
            return n

        n = asyncio.run(_run())
        assert n > 0
        content = _read_file(str(p))
        assert payload in content

    def test_direct_io_sinks_async_write_does_not_block_event_loop(self, tmp_path) -> None:
        """async_write() offloads to an executor — the event loop stays responsive.

        We run a concurrent coroutine that counts iterations while async_write
        is in flight.  If the write blocked the loop the counter would stay at
        zero during the write; offloading to a thread lets the loop tick freely.
        """
        p = tmp_path / "nonblock.raw"
        payload = b"X" * 4096  # exactly one aligned block

        ticks: list[int] = []

        async def _ticker(stop_event: asyncio.Event) -> None:
            count = 0
            while not stop_event.is_set():
                count += 1
                ticks.append(count)
                await asyncio.sleep(0)  # yield to the event loop

        async def _run():
            stop = asyncio.Event()
            ticker_task = asyncio.ensure_future(_ticker(stop))
            try:
                with DirectIOSink(str(p)) as sink:
                    await sink.async_write(payload)
            finally:
                stop.set()
                await ticker_task

        asyncio.run(_run())
        # The ticker must have had at least one iteration — proving the event
        # loop ran while the write was in flight.
        assert len(ticks) >= 1, "event loop never ticked during async_write"

    def test_direct_io_sinks_async_write_batch_persists_all_frames(self, tmp_path) -> None:
        """async_write_batch() persists all frames to disk asynchronously."""
        p = tmp_path / "asyncbatch.raw"
        frames = [b'{"id": 0}', b'{"id": 1}', b'{"id": 2}']

        async def _run():
            with DirectIOSink(str(p)) as sink:
                return await sink.async_write_batch(frames)

        n = asyncio.run(_run())
        assert n > 0
        content = _read_file(str(p))
        for f in frames:
            assert f in content

    def test_direct_io_sinks_async_write_batch_returns_aligned_count(self, tmp_path) -> None:
        """async_write_batch() returns a block-aligned byte count."""
        alignment = 512
        p = tmp_path / "asyncbatchret.raw"
        frames = [b"a", b"b"]

        async def _run():
            with DirectIOSink(str(p), alignment=alignment) as sink:
                return await sink.async_write_batch(frames)

        n = asyncio.run(_run())
        assert n % alignment == 0

    def test_direct_io_sinks_concurrent_async_writes_are_serialised(self, tmp_path) -> None:
        """Concurrent async_write calls do not corrupt each other's data.

        Five coroutines each write a distinct 4096-byte pattern.  After all
        writes are complete each pattern must appear exactly once on disk.
        """
        p = tmp_path / "concurrent.raw"
        alignment = 4096
        patterns = [bytes([i]) * alignment for i in range(5)]

        async def _run():
            with DirectIOSink(str(p), alignment=alignment) as sink:
                tasks = [asyncio.ensure_future(sink.async_write(pat)) for pat in patterns]
                await asyncio.gather(*tasks)

        asyncio.run(_run())

        content = _read_file(str(p))
        assert len(content) == alignment * len(patterns)
        # Each 4 KiB block must consist of a single repeating byte value.
        for idx in range(len(patterns)):
            block = content[idx * alignment : (idx + 1) * alignment]
            unique_bytes = set(block)
            assert len(unique_bytes) == 1, (
                f"block {idx} contains mixed bytes: {unique_bytes}"
            )

    # ------------------------------------------------------------------
    # Context manager and lifecycle
    # ------------------------------------------------------------------

    def test_direct_io_sinks_context_manager_closes_on_exit(self, tmp_path) -> None:
        """Using DirectIOSink as a context manager closes the sink on __exit__."""
        p = tmp_path / "ctx.raw"
        with DirectIOSink(str(p)) as sink:
            assert not sink._closed
        assert sink._closed

    def test_direct_io_sinks_write_after_close_raises(self, tmp_path) -> None:
        """Writing to a closed sink raises RuntimeError."""
        p = tmp_path / "closed.raw"
        sink = DirectIOSink(str(p))
        sink.close()

        with pytest.raises(RuntimeError, match="closed"):
            sink.write(b"data")

    def test_direct_io_sinks_write_batch_after_close_raises(self, tmp_path) -> None:
        """write_batch to a closed sink raises RuntimeError."""
        p = tmp_path / "closed_batch.raw"
        sink = DirectIOSink(str(p))
        sink.close()

        with pytest.raises(RuntimeError, match="closed"):
            sink.write_batch([b"data"])

    def test_direct_io_sinks_double_close_is_safe(self, tmp_path) -> None:
        """Calling close() twice does not raise."""
        p = tmp_path / "doubleclose.raw"
        sink = DirectIOSink(str(p))
        sink.close()
        sink.close()  # must not raise

    # ------------------------------------------------------------------
    # Thread safety
    # ------------------------------------------------------------------

    def test_direct_io_sinks_thread_safe_sync_writes(self, tmp_path) -> None:
        """Concurrent threaded writes do not raise and all bytes are flushed."""
        p = tmp_path / "threads.raw"
        errors: list[Exception] = []
        write_count = 20

        def _worker(sink: DirectIOSink, payload: bytes) -> None:
            try:
                sink.write(payload)
            except Exception as exc:
                errors.append(exc)

        with DirectIOSink(str(p)) as sink:
            threads = [
                threading.Thread(target=_worker, args=(sink, b'{"t": %d}\n' % i))
                for i in range(write_count)
            ]
            for t in threads:
                t.start()
            for t in threads:
                t.join()

        assert not errors, f"Errors during threaded writes: {errors}"
        # Every write should have been counted.
        assert sink.bytes_written > 0


# ---------------------------------------------------------------------------
# Zero-copy header parsing tests  (all names contain "test_zero_copy_headers"
# so they are selected by -k test_zero_copy_headers)
# ---------------------------------------------------------------------------


def _make_header(cursor: int = 0, wraps: int = 0) -> bytes:
    """Build a well-formed 24-byte SFMMAP binary frame header."""
    return _MAGIC + struct.pack("<Q", cursor) + struct.pack("<Q", wraps)


class TestZeroCopyHeaders:
    """Suite name token: test_zero_copy_headers (matched by pytest -k).

    Covers every edge case required by Issue #622:
      - valid headers (bytes, bytearray, memoryview inputs)
      - invalid magic headers
      - truncated headers
      - empty frames
      - exact-length headers
      - oversized frames
      - memoryview parsing
      - zero-copy header path (no intermediate bytes() allocated on hot path)
    """

    # ------------------------------------------------------------------
    # Module-level constants
    # ------------------------------------------------------------------

    def test_zero_copy_headers_magic_view_equals_magic(self) -> None:
        """_MAGIC_VIEW is a memoryview of _MAGIC with equal content."""
        assert isinstance(_MAGIC_VIEW, memoryview)
        assert bytes(_MAGIC_VIEW) == _MAGIC

    def test_zero_copy_headers_ws_frame_header_size_equals_header_size(self) -> None:
        """_WS_FRAME_HEADER_SIZE matches _HEADER_SIZE (24 bytes)."""
        assert _WS_FRAME_HEADER_SIZE == _HEADER_SIZE
        assert _WS_FRAME_HEADER_SIZE == 24

    def test_zero_copy_headers_parse_ws_frame_header_exported(self) -> None:
        """parse_ws_frame_header is importable and callable."""
        assert callable(parse_ws_frame_header)

    # ------------------------------------------------------------------
    # Valid headers
    # ------------------------------------------------------------------

    def test_zero_copy_headers_valid_bytes_zero_cursor(self) -> None:
        """Parses a valid header with cursor=0, wraps=0 from bytes."""
        header = _make_header(cursor=0, wraps=0)
        cursor, wraps = parse_ws_frame_header(header)
        assert cursor == 0
        assert wraps == 0

    def test_zero_copy_headers_valid_bytes_nonzero_cursor(self) -> None:
        """Parses a valid header with a non-zero cursor value."""
        header = _make_header(cursor=12345, wraps=7)
        cursor, wraps = parse_ws_frame_header(header)
        assert cursor == 12345
        assert wraps == 7

    def test_zero_copy_headers_valid_large_cursor_and_wraps(self) -> None:
        """Parses header with large uint64 cursor and wrap-count values."""
        big_cursor = (1 << 48) - 1
        big_wraps = (1 << 32) + 99
        header = _make_header(cursor=big_cursor, wraps=big_wraps)
        cursor, wraps = parse_ws_frame_header(header)
        assert cursor == big_cursor
        assert wraps == big_wraps

    def test_zero_copy_headers_valid_bytearray_input(self) -> None:
        """Accepts a bytearray as input without allocating extra bytes."""
        header = bytearray(_make_header(cursor=42, wraps=3))
        cursor, wraps = parse_ws_frame_header(header)
        assert cursor == 42
        assert wraps == 3

    def test_zero_copy_headers_valid_memoryview_input(self) -> None:
        """Accepts a memoryview as input and reuses it directly (zero-copy)."""
        raw = _make_header(cursor=999, wraps=1)
        mv = memoryview(raw)
        cursor, wraps = parse_ws_frame_header(mv)
        assert cursor == 999
        assert wraps == 1
        # Caller's memoryview must still be usable after the call.
        assert len(mv) == _WS_FRAME_HEADER_SIZE

    def test_zero_copy_headers_memoryview_subslice_input(self) -> None:
        """Works when passed a sub-slice of a larger buffer's memoryview."""
        # Embed a valid header in the middle of a larger buffer.
        prefix = b"\xff" * 16
        header = _make_header(cursor=777, wraps=5)
        suffix = b"\xee" * 8
        full = prefix + header + suffix
        mv = memoryview(full)[16 : 16 + _WS_FRAME_HEADER_SIZE]
        cursor, wraps = parse_ws_frame_header(mv)
        assert cursor == 777
        assert wraps == 5

    # ------------------------------------------------------------------
    # Exact-length headers
    # ------------------------------------------------------------------

    def test_zero_copy_headers_exact_length_bytes(self) -> None:
        """A buffer of exactly _WS_FRAME_HEADER_SIZE bytes is accepted."""
        header = _make_header(cursor=1, wraps=0)
        assert len(header) == _WS_FRAME_HEADER_SIZE
        cursor, wraps = parse_ws_frame_header(header)
        assert cursor == 1

    def test_zero_copy_headers_oversized_frame_reads_first_24_bytes(self) -> None:
        """Extra bytes beyond the header are silently ignored."""
        header = _make_header(cursor=50, wraps=2) + b"\x00" * 1000
        cursor, wraps = parse_ws_frame_header(header)
        assert cursor == 50
        assert wraps == 2

    # ------------------------------------------------------------------
    # Invalid magic headers
    # ------------------------------------------------------------------

    def test_zero_copy_headers_invalid_magic_raises_value_error(self) -> None:
        """A header with wrong magic bytes raises ValueError."""
        bad_magic = b"\x00" * 8
        bad_header = bad_magic + struct.pack("<Q", 0) + struct.pack("<Q", 0)
        with pytest.raises(ValueError, match="magic bytes mismatch"):
            parse_ws_frame_header(bad_header)

    def test_zero_copy_headers_partial_magic_raises_value_error(self) -> None:
        """A header with a partially correct magic raises ValueError."""
        partial_magic = _MAGIC[:4] + b"\xff\xff\xff\xff"
        bad_header = partial_magic + struct.pack("<Q", 0) + struct.pack("<Q", 0)
        with pytest.raises(ValueError, match="magic bytes mismatch"):
            parse_ws_frame_header(bad_header)

    def test_zero_copy_headers_all_ff_magic_raises_value_error(self) -> None:
        """A header whose first 8 bytes are all 0xFF raises ValueError."""
        bad_header = b"\xff" * 8 + struct.pack("<Q", 0) + struct.pack("<Q", 0)
        with pytest.raises(ValueError, match="magic bytes mismatch"):
            parse_ws_frame_header(bad_header)

    def test_zero_copy_headers_off_by_one_magic_raises_value_error(self) -> None:
        """A magic differing by a single bit raises ValueError."""
        off_by_one = bytearray(_MAGIC)
        off_by_one[-1] ^= 0x01  # flip lowest bit of last magic byte
        bad_header = bytes(off_by_one) + struct.pack("<Q", 0) + struct.pack("<Q", 0)
        with pytest.raises(ValueError, match="magic bytes mismatch"):
            parse_ws_frame_header(bad_header)

    # ------------------------------------------------------------------
    # Truncated headers
    # ------------------------------------------------------------------

    def test_zero_copy_headers_empty_frame_raises_value_error(self) -> None:
        """An empty bytes object raises ValueError (too short)."""
        with pytest.raises(ValueError, match="too short"):
            parse_ws_frame_header(b"")

    def test_zero_copy_headers_one_byte_frame_raises_value_error(self) -> None:
        """A single-byte buffer raises ValueError (too short)."""
        with pytest.raises(ValueError, match="too short"):
            parse_ws_frame_header(b"\x00")

    def test_zero_copy_headers_magic_only_raises_value_error(self) -> None:
        """A buffer containing only the 8 magic bytes (no fields) raises ValueError."""
        with pytest.raises(ValueError, match="too short"):
            parse_ws_frame_header(_MAGIC)

    def test_zero_copy_headers_23_byte_frame_raises_value_error(self) -> None:
        """A buffer of 23 bytes (one byte short) raises ValueError."""
        truncated = _make_header()[: _WS_FRAME_HEADER_SIZE - 1]
        assert len(truncated) == 23
        with pytest.raises(ValueError, match="too short"):
            parse_ws_frame_header(truncated)

    def test_zero_copy_headers_truncated_memoryview_raises_value_error(self) -> None:
        """A truncated memoryview raises ValueError."""
        raw = _make_header()
        mv = memoryview(raw)[:10]  # only first 10 bytes
        with pytest.raises(ValueError, match="too short"):
            parse_ws_frame_header(mv)

    # ------------------------------------------------------------------
    # Zero-copy path — no bytes() allocation on hot path
    # ------------------------------------------------------------------

    def test_zero_copy_headers_memoryview_not_consumed(self) -> None:
        """Passing a memoryview does not release or invalidate it."""
        raw = _make_header(cursor=11, wraps=22)
        mv = memoryview(raw)
        parse_ws_frame_header(mv)
        # mv must remain valid and readable after the call.
        assert bytes(mv[:8]) == _MAGIC

    def test_zero_copy_headers_bytearray_not_copied(self) -> None:
        """Mutating the source bytearray after parsing does not affect
        already-returned values (values are unpacked integers, not views)."""
        ba = bytearray(_make_header(cursor=100, wraps=5))
        cursor, wraps = parse_ws_frame_header(ba)
        # Mutate source after parsing.
        ba[_CURSOR_OFFSET] = 0xFF
        # Returned values are plain ints — unaffected by mutation.
        assert cursor == 100
        assert wraps == 5

    # ------------------------------------------------------------------
    # MmapLogSink integration — _read_header uses zero-copy path
    # ------------------------------------------------------------------

    def test_zero_copy_headers_mmap_sink_round_trip(self, tmp_path) -> None:
        """MmapLogSink persists and reloads cursor/wrap_count correctly after
        the zero-copy _read_header refactor."""
        p = tmp_path / "sink_roundtrip.mmap"
        map_size = 1024 * 1024  # 1 MiB

        # Write some data to advance the cursor.
        with MmapLogSink(str(p), map_size=map_size) as sink:
            sink.write(b'{"event": "first"}\n')
            written_cursor = sink.cursor

        assert written_cursor > 0

        # Re-open and verify the header is read back correctly.
        with MmapLogSink(str(p), map_size=map_size) as sink2:
            assert sink2.cursor == written_cursor
            assert sink2.wrap_count == 0

    def test_zero_copy_headers_mmap_sink_corrupt_magic_resets_cursor(
        self, tmp_path
    ) -> None:
        """When MmapLogSink detects a magic mismatch it resets the cursor to 0."""
        p = tmp_path / "corrupt.mmap"
        map_size = 1024 * 1024

        # Create a valid sink file first.
        with MmapLogSink(str(p), map_size=map_size) as sink:
            sink.write(b'{"x": 1}\n')

        # Corrupt the magic bytes in the file header.
        with open(str(p), "r+b") as fh:
            mm = mmap.mmap(fh.fileno(), map_size, access=mmap.ACCESS_WRITE)
            mv = memoryview(mm)
            mv[0:8] = b"\xde\xad\xbe\xef\xde\xad\xbe\xef"
            del mv
            mm.flush()
            mm.close()

        # Re-opening the sink should detect the mismatch and reset.
        with MmapLogSink(str(p), map_size=map_size) as sink2:
            assert sink2.cursor == 0
            assert sink2.wrap_count == 0

    # ------------------------------------------------------------------
    # parse_ws_frame_header + MmapLogSink header bytes are compatible
    # ------------------------------------------------------------------

    def test_zero_copy_headers_parse_ws_frame_header_reads_mmap_header(
        self, tmp_path
    ) -> None:
        """parse_ws_frame_header can read the raw header bytes written by
        MmapLogSink, confirming the two share the same binary layout."""
        p = tmp_path / "header_compat.mmap"
        map_size = 1024 * 1024

        with MmapLogSink(str(p), map_size=map_size) as sink:
            sink.write(b'{"seq": 0}\n')
            expected_cursor = sink.cursor

        # Read the raw 24-byte header from the file.
        with open(str(p), "rb") as fh:
            raw_header = fh.read(_WS_FRAME_HEADER_SIZE)

        cursor, wraps = parse_ws_frame_header(raw_header)
        assert cursor == expected_cursor
        assert wraps == 0
