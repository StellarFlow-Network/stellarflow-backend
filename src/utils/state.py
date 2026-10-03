"""Utility module providing a process‑safe state register for internal worker flags.

The register maintains a mapping from arbitrary string identifiers (e.g. ``asset_pair``
or ``worker_name``) to boolean flags that indicate whether a particular worker is
currently active.  All operations are protected by an inter-process file lock
(:func:`fcntl.flock`) ensuring safe concurrent access from multiple forked worker
processes.

On platforms without :func:`fcntl` (e.g. Windows), a module-level
:class:`multiprocessing.Lock` is used as a fallback — this prevents thread-level
races within a single process but does **not** guarantee cross-process exclusion.

Typical usage::

    from src.utils.state import StateRegister

    # Obtain a singleton instance (module‑level) or instantiate directly
    state = StateRegister()

    if not state.is_active('BTC/USD'):
        state.activate('BTC/USD')
        start_worker('BTC/USD')

    # Later, when the worker finishes
    state.deactivate('BTC/USD')

The implementation is deliberately lightweight and does not depend on any external
libraries so it can be used from both Python and TypeScript runtimes (via
inter‑process communication) without side effects.
"""

import os
import json
import tempfile
import multiprocessing
from typing import Dict, Optional

try:
    import fcntl
except ImportError:
    fcntl = None

# Fallback lock for platforms without fcntl — module-level so it survives forking.
_PROCESS_LOCK: Optional[multiprocessing.Lock] = multiprocessing.Lock() if fcntl is None else None


class StateRegister:
    """Process‑safe registry for boolean activity flags.

    Synchronisation uses :func:`fcntl.flock` on the lock file (``<filepath>.lock``),
    which works correctly across forked child processes on Linux.  On platforms
    without ``fcntl``, a module-level :class:`multiprocessing.Lock` fallback
    prevents intra-process thread races.

    Attributes:
        _filepath: Filepath to the local operational metadata file layout.
    """

    def __init__(self, filepath: str = "state_register.json") -> None:
        self._filepath = filepath
        self._lock_filepath = filepath + ".lock"
        dir_name = os.path.dirname(self._filepath) or "."
        if dir_name and not os.path.exists(dir_name):
            os.makedirs(dir_name, exist_ok=True)
        self._run_locked(self._init_file)

    # ------------------------------------------------------------------
    # Internal lock helpers
    # ------------------------------------------------------------------

    def _acquire_lock(self) -> Optional[object]:
        """Acquire the inter-process lock.

        Uses ``fcntl.flock`` on the lock file when available (Linux/macOS),
        falling back to the module-level ``multiprocessing.Lock``.

        Returns a context-manager-like *token* that must be passed to
        :meth:`_release_lock`, or ``None`` if no locking is available.
        """
        if fcntl is not None:
            lock_file = open(self._lock_filepath, "w")
            fcntl.flock(lock_file, fcntl.LOCK_EX)
            return lock_file
        if _PROCESS_LOCK is not None:
            _PROCESS_LOCK.acquire()
            return _PROCESS_LOCK
        return None

    def _release_lock(self, token: Optional[object]) -> None:
        """Release the lock acquired by :meth:`_acquire_lock`."""
        if token is None:
            return
        # ``multiprocessing.Lock`` is a factory function, not a class, so it
        # cannot be used with isinstance(). Identity is the correct check:
        # _acquire_lock yields the module-level singleton or a file object.
        if token is _PROCESS_LOCK:
            token.release()
        else:
            try:
                if fcntl is not None:
                    fcntl.flock(token, fcntl.LOCK_UN)
            except Exception:
                pass
            try:
                token.close()
            except Exception:
                pass

    def _run_locked(self, func, *args, **kwargs):
        """Execute *func* while holding the inter-process lock."""
        token = self._acquire_lock()
        try:
            return func(*args, **kwargs)
        finally:
            self._release_lock(token)

    def _init_file(self) -> None:
        if not os.path.exists(self._filepath):
            self._write_state_unsafe({})

    # ------------------------------------------------------------------
    # State I/O (callers must hold the lock)
    # ------------------------------------------------------------------

    def _load_state_unsafe(self) -> Dict[str, bool]:
        if not os.path.exists(self._filepath):
            return {}
        try:
            with open(self._filepath, "r", encoding="utf-8") as f:
                content = f.read().strip()
                if not content:
                    return {}
                return json.loads(content)
        except Exception:
            return {}

    def _write_state_unsafe(self, flags: Dict[str, bool]) -> None:
        dir_name = os.path.dirname(self._filepath) or "."
        fd, temp_path = tempfile.mkstemp(
            dir=dir_name,
            prefix=f".{os.path.basename(self._filepath)}.",
            suffix=".tmp"
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(flags, f)
                f.flush()
                os.fsync(f.fileno())
            os.replace(temp_path, self._filepath)
        except Exception:
            if os.path.exists(temp_path):
                try:
                    os.unlink(temp_path)
                except OSError:
                    pass
            raise

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def is_active(self, key: str) -> bool:
        """Return ``True`` if the flag for *key* is set, ``False`` otherwise.

        This method acquires the inter-process lock to guarantee a consistent view
        across all worker processes.
        """
        return self._run_locked(self._is_active_unsafe, key)

    def _is_active_unsafe(self, key: str) -> bool:
        flags = self._load_state_unsafe()
        return flags.get(key, False)

    def activate(self, key: str) -> None:
        """Mark the flag for *key* as active (``True``).

        If the key does not yet exist, it is created.
        """
        self._run_locked(self._activate_unsafe, key)

    def _activate_unsafe(self, key: str) -> None:
        flags = self._load_state_unsafe()
        flags[key] = True
        self._write_state_unsafe(flags)

    def try_acquire(self, key: str) -> bool:
        """Atomically check if *key* is inactive and, if so, activate it.

        Returns ``True`` when the caller successfully acquired the flag (i.e. no other
        worker was running for the same ``key``). Returns ``False`` if the flag was
        already ``True``.
        """
        def _try_acquire_unsafe() -> bool:
            flags = self._load_state_unsafe()
            if flags.get(key, False):
                return False
            flags[key] = True
            self._write_state_unsafe(flags)
            return True
        return self._run_locked(_try_acquire_unsafe)

    def deactivate(self, key: str) -> None:
        """Mark the flag for *key* as inactive (``False``).

        The key is retained in the mapping to allow future ``is_active`` checks
        without raising ``KeyError``.
        """
        self._run_locked(self._deactivate_unsafe, key)

    def _deactivate_unsafe(self, key: str) -> None:
        flags = self._load_state_unsafe()
        flags[key] = False
        self._write_state_unsafe(flags)

    # Alias for clarity when releasing a worker lock
    def release(self, key: str) -> None:
        """Convenient wrapper that forwards to :meth:`deactivate`.

        This can be used by ingestion code to explicitly free the allocation flag.
        """
        self.deactivate(key)

    def clear(self, key: str) -> None:
        """Remove *key* from the registry entirely.

        After removal, ``is_active`` will return ``False`` for the key.
        """
        self._run_locked(self._clear_unsafe, key)

    def _clear_unsafe(self, key: str) -> None:
        flags = self._load_state_unsafe()
        flags.pop(key, None)
        self._write_state_unsafe(flags)

    def snapshot(self) -> Dict[str, bool]:
        """Return a shallow copy of the current flags mapping.

        The copy is taken under lock to avoid race conditions; callers can safely
        iterate over the result without further synchronization.
        """
        return self._run_locked(self._load_state_unsafe)

    # Optional convenience context manager for safe activation/deactivation
    def guard(self, key: str):
        """Context manager that activates *key* on entry and deactivates on exit.

        Example::

            with state.guard('worker-1'):
                run_expensive_task()
        """
        return _StateGuard(self, key)


class _StateGuard:
    def __init__(self, register: StateRegister, key: str) -> None:
        self._register = register
        self._key = key

    def __enter__(self):
        self._register.activate(self._key)
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self._register.deactivate(self._key)
        # Propagate any exception
        return False


# Create a module‑level singleton for convenient import
state_register = StateRegister()
