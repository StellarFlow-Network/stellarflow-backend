"""
app/security/kms.py — Secure KMS Key Rotation Handler for Relayer Wallets
Issue #718

Automates periodic AWS KMS / HashiCorp Vault signing key rotation for
backend transaction-submission relayer keys with the following guarantees:

* Abstract ``KeyProvider`` interface supports both AWS KMS and a local
  Vault-style provider so the rotation logic is backend-agnostic.
* A ``KeyHandle`` wraps the opaque key-id and tracks its expiry window;
  the rotation scheduler drains pending transactions signed by expiring
  handles before finalising the cut-over.
* ``SignedEnvelope`` carries the raw XDR payload together with the
  Ed25519 signature produced by the active key handle.  A verify helper
  confirms the signature against the sender's public key before the
  envelope is dispatched to Horizon RPC nodes.
"""

from __future__ import annotations

import abc
import asyncio
import base64
import datetime as _dt
import hashlib
import hmac
import logging
import os
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Awaitable, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)

__all__ = [
    # Data classes
    "KeyHandle",
    "SignedEnvelope",
    "RotationEvent",
    # Interfaces
    "KeyProvider",
    # Concrete providers
    "AwsKmsProvider",
    "LocalVaultProvider",
    # Core orchestrator
    "KeyRotationHandler",
    # Horizon broadcast helper
    "verify_signed_envelope",
    "verify_envelope_async",
]

# ---------------------------------------------------------------------------
# Configuration knobs (override via environment variables)
# ---------------------------------------------------------------------------

#: Seconds before a key's ``expires_at`` timestamp that rotation begins.
_ROTATION_LEAD_TIME_SECS: float = float(
    os.environ.get("KMS_ROTATION_LEAD_TIME_SECS", "300")  # 5 min
)

#: Maximum number of seconds to wait for pending transactions to drain
#: before forcing the key cut-over.
_DRAIN_TIMEOUT_SECS: float = float(
    os.environ.get("KMS_DRAIN_TIMEOUT_SECS", "60")
)

#: How often the rotation scheduler polls active keys (seconds).
_SCHEDULER_POLL_INTERVAL_SECS: float = float(
    os.environ.get("KMS_SCHEDULER_POLL_INTERVAL_SECS", "30")
)


# ---------------------------------------------------------------------------
# Core data structures
# ---------------------------------------------------------------------------


@dataclass
class KeyHandle:
    """Opaque reference to a signing key managed by a ``KeyProvider``.

    Attributes
    ----------
    key_id:
        Provider-specific identifier (e.g. KMS ARN or Vault key path).
    public_key_b64:
        Base-64-encoded Ed25519 raw public key (32 bytes).
    created_at:
        UTC timestamp at which the key became active.
    expires_at:
        UTC timestamp after which the key must no longer be used for new
        signatures.  ``None`` means the key does not expire automatically.
    pending_tx_count:
        Running count of in-flight transactions signed by this handle.
        Managed by :class:`KeyRotationHandler` during the drain phase.
    is_active:
        ``True`` while this handle is the designated signing key.
    """

    key_id: str
    public_key_b64: str
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    expires_at: Optional[datetime] = None
    pending_tx_count: int = 0
    is_active: bool = True

    # ------------------------------------------------------------------
    # Convenience helpers
    # ------------------------------------------------------------------

    @property
    def public_key_bytes(self) -> bytes:
        """Return the raw 32-byte Ed25519 public key."""
        return base64.b64decode(self.public_key_b64)

    def is_expiring_soon(self, lead_time_secs: float = _ROTATION_LEAD_TIME_SECS) -> bool:
        """Return ``True`` if this key expires within *lead_time_secs* seconds."""
        if self.expires_at is None:
            return False
        now = datetime.now(timezone.utc)
        remaining = (self.expires_at - now).total_seconds()
        return remaining <= lead_time_secs

    def is_expired(self) -> bool:
        """Return ``True`` if the key's expiry timestamp has passed."""
        if self.expires_at is None:
            return False
        return datetime.now(timezone.utc) >= self.expires_at


@dataclass
class SignedEnvelope:
    """A signed transaction ready for Horizon RPC broadcast.

    Attributes
    ----------
    xdr_payload:
        Raw XDR-encoded Stellar transaction envelope bytes.
    signature_b64:
        Base-64-encoded Ed25519 signature over ``sha256(xdr_payload)``.
    key_id:
        The ``KeyHandle.key_id`` used to produce this signature.
    signer_public_key_b64:
        Base-64-encoded Ed25519 public key matching the signing key.
    signed_at:
        UTC timestamp at which the envelope was signed.
    """

    xdr_payload: bytes
    signature_b64: str
    key_id: str
    signer_public_key_b64: str
    signed_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    @property
    def message_hash(self) -> bytes:
        """SHA-256 digest of ``xdr_payload`` — the bytes that were signed."""
        return hashlib.sha256(self.xdr_payload).digest()


@dataclass
class RotationEvent:
    """Audit record emitted each time a key rotation cycle completes.

    Attributes
    ----------
    old_key_id:
        Identifier of the key that was retired.
    new_key_id:
        Identifier of the key that took over.
    rotated_at:
        UTC timestamp of the cut-over.
    drained_tx_count:
        Number of in-flight transactions that were gracefully drained
        before the old key was retired.
    success:
        ``True`` if the rotation completed without errors.
    error:
        Human-readable error message if ``success`` is ``False``.
    """

    old_key_id: str
    new_key_id: str
    rotated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    drained_tx_count: int = 0
    success: bool = True
    error: Optional[str] = None


# ---------------------------------------------------------------------------
# Abstract key-provider interface
# ---------------------------------------------------------------------------


class KeyProvider(abc.ABC):
    """Abstract interface for backend-agnostic key management.

    Concrete implementations wrap AWS KMS, HashiCorp Vault, or any other
    HSM/KMS system.  The rotation handler depends **only** on this interface.
    """

    @abc.abstractmethod
    async def generate_key(self) -> KeyHandle:
        """Provision a new signing key and return its handle.

        The provider is responsible for setting ``key_id``,
        ``public_key_b64``, ``created_at``, and ``expires_at``.
        """

    @abc.abstractmethod
    async def sign(self, handle: KeyHandle, message: bytes) -> bytes:
        """Sign *message* with the key referenced by *handle*.

        Parameters
        ----------
        handle:
            Active :class:`KeyHandle` to use.
        message:
            Raw bytes to sign (typically ``sha256(xdr_payload)``).

        Returns
        -------
        bytes
            Raw 64-byte Ed25519 signature.
        """

    @abc.abstractmethod
    async def retire_key(self, handle: KeyHandle) -> None:
        """Schedule deletion / disable the key referenced by *handle*.

        Implementations should set the minimum required deletion window
        for the underlying provider (e.g. 7-day pending deletion in KMS).
        """

    @abc.abstractmethod
    async def get_public_key(self, handle: KeyHandle) -> bytes:
        """Return the raw 32-byte Ed25519 public key for *handle*."""


# ---------------------------------------------------------------------------
# AWS KMS provider
# ---------------------------------------------------------------------------


class AwsKmsProvider(KeyProvider):
    """AWS KMS implementation of :class:`KeyProvider`.

    Uses the ``boto3`` AWS SDK under the hood.  The KMS key policy must
    allow ``kms:Sign``, ``kms:GetPublicKey``, ``kms:DescribeKey``, and
    ``kms:ScheduleKeyDeletion`` for the IAM principal running this process.

    Parameters
    ----------
    region_name:
        AWS region where keys are managed.  Defaults to ``AWS_DEFAULT_REGION``
        environment variable or ``"us-east-1"``.
    key_ttl_days:
        Lifetime of a newly created key in calendar days.  Defaults to 90.
    deletion_pending_days:
        KMS pending-deletion window (7-30 days; AWS minimum is 7).
    """

    def __init__(
        self,
        *,
        region_name: Optional[str] = None,
        key_ttl_days: int = 90,
        deletion_pending_days: int = 7,
    ) -> None:
        self._region = region_name or os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
        self._key_ttl_days = key_ttl_days
        self._deletion_pending_days = max(7, min(deletion_pending_days, 30))
        self._client = self._build_client()

    # ------------------------------------------------------------------
    # KeyProvider implementation
    # ------------------------------------------------------------------

    async def generate_key(self) -> KeyHandle:
        """Create a new AWS KMS asymmetric key and return its handle."""
        loop = asyncio.get_event_loop()
        response = await loop.run_in_executor(None, self._create_kms_key)
        key_id: str = response["KeyMetadata"]["KeyId"]
        created_at = datetime.now(timezone.utc)
        expires_at = created_at + _dt.timedelta(days=self._key_ttl_days)

        # Fetch the public key material from KMS
        temp_handle = KeyHandle(
            key_id=key_id,
            public_key_b64="",
            created_at=created_at,
            expires_at=expires_at,
        )
        pub_bytes = await self.get_public_key(temp_handle)
        pub_b64 = base64.b64encode(pub_bytes).decode()

        handle = KeyHandle(
            key_id=key_id,
            public_key_b64=pub_b64,
            created_at=created_at,
            expires_at=expires_at,
        )
        logger.info("[KMS] Generated new key %s, expires %s", key_id, expires_at)
        return handle

    async def sign(self, handle: KeyHandle, message: bytes) -> bytes:
        """Sign *message* via AWS KMS."""
        loop = asyncio.get_event_loop()
        response = await loop.run_in_executor(
            None, lambda: self._kms_sign(handle.key_id, message)
        )
        raw_sig: bytes = response["Signature"]
        logger.debug("[KMS] Signed %d bytes with key %s", len(message), handle.key_id)
        return raw_sig

    async def retire_key(self, handle: KeyHandle) -> None:
        """Schedule AWS KMS key deletion with the configured pending window."""
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(
            None,
            lambda: self._schedule_deletion(handle.key_id, self._deletion_pending_days),
        )
        logger.info(
            "[KMS] Scheduled deletion of key %s (%d-day window)",
            handle.key_id,
            self._deletion_pending_days,
        )

    async def get_public_key(self, handle: KeyHandle) -> bytes:
        """Fetch the raw DER SubjectPublicKeyInfo and extract the 32-byte key."""
        loop = asyncio.get_event_loop()
        response = await loop.run_in_executor(
            None, lambda: self._get_public_key(handle.key_id)
        )
        # AWS returns DER-encoded SubjectPublicKeyInfo; the last 32 bytes are
        # the raw Ed25519 public key material.
        der: bytes = response["PublicKey"]
        return der[-32:]

    # ------------------------------------------------------------------
    # Synchronous boto3 helpers (executed in the default thread pool)
    # ------------------------------------------------------------------

    def _build_client(self):  # type: ignore[return]
        try:
            import boto3  # type: ignore
            return boto3.client("kms", region_name=self._region)
        except ImportError as exc:
            raise RuntimeError(
                "boto3 is required for AwsKmsProvider. "
                "Install it with: pip install boto3"
            ) from exc

    def _create_kms_key(self) -> dict:
        return self._client.create_key(
            Description="StellarFlow relayer signing key",
            KeyUsage="SIGN_VERIFY",
            KeySpec="ECC_NIST_P256",
            Tags=[{"TagKey": "ManagedBy", "TagValue": "stellarflow-kms-rotation"}],
        )

    def _kms_sign(self, key_id: str, message: bytes) -> dict:
        return self._client.sign(
            KeyId=key_id,
            Message=message,
            MessageType="RAW",
            SigningAlgorithm="ECDSA_SHA_256",
        )

    def _schedule_deletion(self, key_id: str, pending_days: int) -> None:
        self._client.schedule_key_deletion(
            KeyId=key_id,
            PendingWindowInDays=pending_days,
        )

    def _get_public_key(self, key_id: str) -> dict:
        return self._client.get_public_key(KeyId=key_id)


# ---------------------------------------------------------------------------
# Local Vault provider (HashiCorp Vault / test stub)
# ---------------------------------------------------------------------------


class LocalVaultProvider(KeyProvider):
    """HashiCorp Vault (or in-process stub) implementation of :class:`KeyProvider`.

    For production deployments pointing at a real Vault cluster, set:

    * ``VAULT_ADDR``  - Vault server address (e.g. ``https://vault.example.com``)
    * ``VAULT_TOKEN`` - Vault token with ``transit/`` policy

    When those variables are absent the provider operates in **stub mode**
    using Python's ``secrets`` module to generate ephemeral keys.
    This is intentionally useful for unit tests and local development.

    Parameters
    ----------
    mount_path:
        Vault transit secrets engine mount point. Defaults to ``"transit"``.
    key_name_prefix:
        Prefix for newly created transit keys.
    key_ttl_days:
        Lifetime in days for newly created keys.
    """

    def __init__(
        self,
        *,
        mount_path: str = "transit",
        key_name_prefix: str = "stellarflow-relayer",
        key_ttl_days: int = 90,
    ) -> None:
        self._mount = mount_path
        self._prefix = key_name_prefix
        self._key_ttl_days = key_ttl_days
        self._vault_addr = os.environ.get("VAULT_ADDR", "")
        self._vault_token = os.environ.get("VAULT_TOKEN", "")
        self._stub_mode = not (self._vault_addr and self._vault_token)

        if self._stub_mode:
            logger.warning(
                "[LocalVaultProvider] VAULT_ADDR / VAULT_TOKEN not set — "
                "operating in STUB mode (suitable for testing only)."
            )

        # In-memory store for stub mode  {key_name -> private_seed}
        self._stub_keys: Dict[str, bytes] = {}

    # ------------------------------------------------------------------
    # KeyProvider implementation
    # ------------------------------------------------------------------

    async def generate_key(self) -> KeyHandle:
        import secrets as _secrets

        key_name = f"{self._prefix}-{int(time.time())}"
        created_at = datetime.now(timezone.utc)
        expires_at = created_at + _dt.timedelta(days=self._key_ttl_days)

        if self._stub_mode:
            private_seed = _secrets.token_bytes(32)
            # Deterministic stub public key derived from the seed
            pub_bytes = hashlib.sha256(private_seed).digest()
            self._stub_keys[key_name] = private_seed
        else:
            pub_bytes = await self._vault_create_key(key_name)

        pub_b64 = base64.b64encode(pub_bytes).decode()
        handle = KeyHandle(
            key_id=key_name,
            public_key_b64=pub_b64,
            created_at=created_at,
            expires_at=expires_at,
        )
        logger.info("[Vault] Generated key %s, expires %s", key_name, expires_at)
        return handle

    async def sign(self, handle: KeyHandle, message: bytes) -> bytes:
        if self._stub_mode:
            return self._stub_sign(handle.key_id, message)
        return await self._vault_sign(handle.key_id, message)

    async def retire_key(self, handle: KeyHandle) -> None:
        if self._stub_mode:
            self._stub_keys.pop(handle.key_id, None)
            logger.info("[Vault-stub] Retired key %s", handle.key_id)
            return
        await self._vault_retire(handle.key_id)

    async def get_public_key(self, handle: KeyHandle) -> bytes:
        return base64.b64decode(handle.public_key_b64)

    # ------------------------------------------------------------------
    # Stub helpers
    # ------------------------------------------------------------------

    def _stub_sign(self, key_id: str, message: bytes) -> bytes:
        """HMAC-SHA256 stub — NOT Ed25519; suitable for testing only."""
        seed = self._stub_keys.get(key_id, b"fallback-seed")
        digest = hmac.new(seed, message, "sha256").digest()
        # Pad to 64 bytes to match expected Ed25519 signature length
        return digest + b"\x00" * 32

    # ------------------------------------------------------------------
    # Real Vault REST helpers (aiohttp)
    # ------------------------------------------------------------------

    async def _vault_create_key(self, key_name: str) -> bytes:
        """Create a Vault transit ed25519 key and return its public key bytes."""
        try:
            import aiohttp

            headers = {"X-Vault-Token": self._vault_token}
            async with aiohttp.ClientSession() as session:
                # Create the key
                create_url = f"{self._vault_addr}/v1/{self._mount}/keys/{key_name}"
                async with session.post(
                    create_url,
                    json={"type": "ed25519", "exportable": False},
                    headers=headers,
                ) as resp:
                    resp.raise_for_status()

                # Fetch the public key for the latest version
                async with session.get(create_url, headers=headers) as resp:
                    resp.raise_for_status()
                    data = await resp.json()

            keys_data = data["data"]["keys"]
            latest = max(int(v) for v in keys_data.keys())
            pub_b64 = keys_data[str(latest)]["public_key"]
            return base64.b64decode(pub_b64)
        except Exception as exc:
            logger.error("[Vault] Failed to create key %s: %s", key_name, exc)
            raise

    async def _vault_sign(self, key_name: str, message: bytes) -> bytes:
        """Sign *message* via Vault transit and return the raw signature bytes."""
        try:
            import aiohttp

            url = f"{self._vault_addr}/v1/{self._mount}/sign/{key_name}"
            headers = {"X-Vault-Token": self._vault_token}
            payload = {
                "input": base64.b64encode(message).decode(),
                "prehashed": True,
            }
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=payload, headers=headers) as resp:
                    resp.raise_for_status()
                    data = await resp.json()

            # Vault returns "vault:v1:<base64>" format
            sig_str: str = data["data"]["signature"]
            sig_b64 = sig_str.split(":", 2)[-1]
            return base64.b64decode(sig_b64)
        except Exception as exc:
            logger.error("[Vault] Signing failed for key %s: %s", key_name, exc)
            raise

    async def _vault_retire(self, key_name: str) -> None:
        """Allow deletion then delete the Vault transit key."""
        try:
            import aiohttp

            headers = {"X-Vault-Token": self._vault_token}
            config_url = f"{self._vault_addr}/v1/{self._mount}/keys/{key_name}/config"
            del_url = f"{self._vault_addr}/v1/{self._mount}/keys/{key_name}"
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    config_url,
                    json={"deletion_allowed": True},
                    headers=headers,
                ) as resp:
                    resp.raise_for_status()
                async with session.delete(del_url, headers=headers) as resp:
                    resp.raise_for_status()
            logger.info("[Vault] Retired key %s", key_name)
        except Exception as exc:
            logger.error("[Vault] Failed to retire key %s: %s", key_name, exc)
            raise


# ---------------------------------------------------------------------------
# Envelope signature verification
# ---------------------------------------------------------------------------


def verify_signed_envelope(envelope: SignedEnvelope) -> bool:
    """Verify the Ed25519 signature on *envelope* before Horizon broadcast.

    Attempts real Ed25519 verification using PyNaCl or the ``cryptography``
    package.  Falls back to an HMAC stub when neither library is installed
    (suitable for unit tests using ``LocalVaultProvider`` in stub mode).

    Parameters
    ----------
    envelope:
        The :class:`SignedEnvelope` to verify.

    Returns
    -------
    bool
        ``True`` if the signature is cryptographically valid, ``False`` otherwise.
    """
    pub_bytes = base64.b64decode(envelope.signer_public_key_b64)
    sig_bytes = base64.b64decode(envelope.signature_b64)
    msg = envelope.message_hash  # sha256(xdr_payload)

    # --- Attempt real Ed25519 verification via PyNaCl -------------------
    try:
        from nacl.signing import VerifyKey  # type: ignore
        from nacl.exceptions import BadSignatureError  # type: ignore

        vk = VerifyKey(pub_bytes)
        vk.verify(msg, sig_bytes)
        return True
    except ImportError:
        pass
    except Exception:
        return False

    # --- Attempt via the ``cryptography`` package -------------------------
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import (  # type: ignore
            Ed25519PublicKey,
        )
        from cryptography.exceptions import InvalidSignature  # type: ignore

        public_key = Ed25519PublicKey.from_public_bytes(pub_bytes)
        public_key.verify(sig_bytes, msg)
        return True
    except ImportError:
        pass
    except Exception:
        return False

    # --- HMAC fallback (stub-mode only; real Ed25519 is NOT verified) ---
    logger.warning(
        "[KMS] Neither PyNaCl nor cryptography is installed; "
        "falling back to HMAC stub verification. "
        "Install 'PyNaCl' or 'cryptography' for production use."
    )
    expected = hmac.new(pub_bytes, msg, "sha256").digest() + b"\x00" * 32
    return hmac.compare_digest(sig_bytes, expected)


async def verify_envelope_async(envelope: SignedEnvelope) -> bool:
    """Verify the Ed25519 signature on *envelope* without blocking the event loop.

    Offloads the CPU-intensive elliptic-curve verification to the heavy
    :class:`~app.services.executor_pool.ProcessPoolExecutor` so that the
    FastAPI event loop remains responsive.

    Parameters
    ----------
    envelope:
        The :class:`SignedEnvelope` to verify.

    Returns
    -------
    bool
        ``True`` if the signature is cryptographically valid, ``False`` otherwise.
    """
    from app.services.executor_pool import run_in_heavy_pool

    return await run_in_heavy_pool(verify_signed_envelope, envelope)


# ---------------------------------------------------------------------------
# Key rotation orchestrator
# ---------------------------------------------------------------------------


class KeyRotationHandler:
    """Orchestrates periodic signing key rotation for relayer wallets.

    Workflow
    --------
    1. On startup, initialise the active :class:`KeyHandle` via the
       injected :class:`KeyProvider`.
    2. A background scheduler polls every ``poll_interval_secs`` seconds.
    3. When a key is due for rotation (``is_expiring_soon()`` returns
       ``True``), the handler:

       a. Provisions a new key via ``provider.generate_key()``.
       b. Atomically swaps the active handle so new signings go to the
          new key immediately.
       c. Waits up to ``drain_timeout_secs`` for ``pending_tx_count``
          on the old handle to reach zero.
       d. Calls ``provider.retire_key()`` on the old handle.
       e. Emits a :class:`RotationEvent` to the optional ``on_rotation``
          callback.

    4. ``sign_envelope()`` always uses the currently active handle and
       increments/decrements the pending counter atomically.

    Parameters
    ----------
    provider:
        Concrete :class:`KeyProvider` (AWS KMS or Vault).
    rotation_lead_time_secs:
        How many seconds before expiry to begin rotating.
    drain_timeout_secs:
        Max seconds to wait for in-flight transactions to drain.
    poll_interval_secs:
        Scheduler poll frequency.
    on_rotation:
        Optional async callback invoked with a :class:`RotationEvent`
        after each rotation cycle completes.
    """

    def __init__(
        self,
        provider: KeyProvider,
        *,
        rotation_lead_time_secs: float = _ROTATION_LEAD_TIME_SECS,
        drain_timeout_secs: float = _DRAIN_TIMEOUT_SECS,
        poll_interval_secs: float = _SCHEDULER_POLL_INTERVAL_SECS,
        on_rotation: Optional[Callable[[RotationEvent], Awaitable[None]]] = None,
    ) -> None:
        self._provider = provider
        self._lead_time = rotation_lead_time_secs
        self._drain_timeout = drain_timeout_secs
        self._poll_interval = poll_interval_secs
        self._on_rotation = on_rotation

        self._active_handle: Optional[KeyHandle] = None
        self._lock = threading.Lock()
        self._rotation_history: List[RotationEvent] = []
        self._scheduler_task: Optional[asyncio.Task] = None  # type: ignore[type-arg]
        self._running = False

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        """Initialise the active key and launch the background scheduler."""
        if self._active_handle is None:
            self._active_handle = await self._provider.generate_key()
            logger.info(
                "[KeyRotationHandler] Initialised with key %s",
                self._active_handle.key_id,
            )
        self._running = True
        self._scheduler_task = asyncio.create_task(self._scheduler_loop())
        logger.info("[KeyRotationHandler] Background scheduler started.")

    async def stop(self) -> None:
        """Stop the scheduler cleanly."""
        self._running = False
        if self._scheduler_task is not None:
            self._scheduler_task.cancel()
            try:
                await self._scheduler_task
            except asyncio.CancelledError:
                pass
        logger.info("[KeyRotationHandler] Stopped.")

    # ------------------------------------------------------------------
    # Transaction signing
    # ------------------------------------------------------------------

    async def sign_envelope(self, xdr_payload: bytes) -> SignedEnvelope:
        """Sign *xdr_payload* and return a :class:`SignedEnvelope`.

        The active handle's ``pending_tx_count`` is incremented before
        signing and decremented in a ``finally`` block, enabling the drain
        logic to wait for all in-flight transactions to complete before
        retiring an expiring key.

        Raises
        ------
        RuntimeError
            If no active key handle is available.
        """
        handle = self._get_active_handle()
        with self._lock:
            handle.pending_tx_count += 1

        try:
            msg = hashlib.sha256(xdr_payload).digest()
            sig_bytes = await self._provider.sign(handle, msg)
            sig_b64 = base64.b64encode(sig_bytes).decode()

            envelope = SignedEnvelope(
                xdr_payload=xdr_payload,
                signature_b64=sig_b64,
                key_id=handle.key_id,
                signer_public_key_b64=handle.public_key_b64,
            )
            logger.debug(
                "[KeyRotationHandler] Signed envelope with key %s", handle.key_id
            )
            return envelope
        finally:
            with self._lock:
                handle.pending_tx_count = max(0, handle.pending_tx_count - 1)

    # ------------------------------------------------------------------
    # Inspection helpers
    # ------------------------------------------------------------------

    @property
    def active_key_id(self) -> Optional[str]:
        """Return the currently active key ID, or ``None`` if not yet initialised."""
        h = self._active_handle
        return h.key_id if h else None

    @property
    def rotation_history(self) -> List[RotationEvent]:
        """Return a snapshot of all completed rotation events."""
        return list(self._rotation_history)

    # ------------------------------------------------------------------
    # Internal scheduler
    # ------------------------------------------------------------------

    async def _scheduler_loop(self) -> None:
        """Background coroutine that polls for expiring keys."""
        while self._running:
            try:
                await self._check_and_rotate()
            except Exception as exc:  # noqa: BLE001
                logger.error("[KeyRotationHandler] Scheduler error: %s", exc)
            await asyncio.sleep(self._poll_interval)

    async def _check_and_rotate(self) -> None:
        """Rotate the active key if it is expiring soon or already expired."""
        handle = self._active_handle
        if handle is None:
            return
        if not handle.is_expiring_soon(self._lead_time) and not handle.is_expired():
            return

        logger.info(
            "[KeyRotationHandler] Key %s is due for rotation. Provisioning new key…",
            handle.key_id,
        )
        await self._rotate(handle)

    async def _rotate(self, old_handle: KeyHandle) -> None:
        """Execute a full key rotation cycle for *old_handle*."""
        event = RotationEvent(old_key_id=old_handle.key_id, new_key_id="<pending>")
        try:
            # 1. Provision the new key
            new_handle = await self._provider.generate_key()

            # 2. Atomically swap to the new handle; disable the old one
            with self._lock:
                old_handle.is_active = False
                self._active_handle = new_handle

            logger.info(
                "[KeyRotationHandler] Cut-over to new key %s. "
                "Draining old key %s…",
                new_handle.key_id,
                old_handle.key_id,
            )

            # 3. Drain in-flight transactions signed by the old key
            drained = await self._drain(old_handle)

            # 4. Retire the old key from the provider
            await self._provider.retire_key(old_handle)
            logger.info(
                "[KeyRotationHandler] Old key %s retired after draining %d tx(s).",
                old_handle.key_id,
                drained,
            )

            event.new_key_id = new_handle.key_id
            event.drained_tx_count = drained
            event.success = True

        except Exception as exc:  # noqa: BLE001
            logger.error(
                "[KeyRotationHandler] Rotation failed for key %s: %s",
                old_handle.key_id,
                exc,
            )
            event.success = False
            event.error = str(exc)
            # Reinstate the old key as a fallback if provisioning failed
            if self._active_handle is old_handle:
                old_handle.is_active = True

        self._rotation_history.append(event)
        if self._on_rotation is not None:
            try:
                await self._on_rotation(event)
            except Exception as cb_exc:  # noqa: BLE001
                logger.error(
                    "[KeyRotationHandler] on_rotation callback raised: %s", cb_exc
                )

    async def _drain(self, handle: KeyHandle) -> int:
        """Block until *handle.pending_tx_count* reaches zero or timeout elapses.

        Returns
        -------
        int
            The in-flight transaction count at the start of the drain.
        """
        with self._lock:
            initial_count = handle.pending_tx_count

        deadline = time.monotonic() + self._drain_timeout
        while True:
            with self._lock:
                remaining = handle.pending_tx_count
            if remaining == 0:
                break
            if time.monotonic() >= deadline:
                logger.warning(
                    "[KeyRotationHandler] Drain timeout for key %s; "
                    "%d tx(s) still pending. Forcing cut-over.",
                    handle.key_id,
                    remaining,
                )
                break
            logger.debug(
                "[KeyRotationHandler] Waiting for %d pending tx(s) on key %s…",
                remaining,
                handle.key_id,
            )
            await asyncio.sleep(0.5)

        return initial_count

    def _get_active_handle(self) -> KeyHandle:
        handle = self._active_handle
        if handle is None or not handle.is_active:
            raise RuntimeError(
                "No active signing key is available. "
                "Call KeyRotationHandler.start() before signing."
            )
        return handle

    # ------------------------------------------------------------------
    # Additional methods for audit logging
    # ------------------------------------------------------------------

    def get_active_key(self) -> Optional[KeyHandle]:
        """Return the currently active key handle, or None if not initialized."""
        return self._active_handle

    def get_key_by_id(self, key_id: str) -> Optional[KeyHandle]:
        """Retrieve a key handle by its ID. Searches active key and rotation history.

        Parameters
        ----------
        key_id : str
            The key ID to search for.

        Returns
        -------
        Optional[KeyHandle]
            The key handle if found, None otherwise.
        """
        # Check active key first
        if self._active_handle and self._active_handle.key_id == key_id:
            return self._active_handle
        
        # TODO: In a full implementation, we would maintain a cache of all retired keys
        # For now, this is a placeholder that only finds the active key
        logger.warning("Key lookup by ID %s is limited to active key only in current implementation", key_id)
        return None

    async def sign_bytes(self, message: bytes, handle: KeyHandle) -> bytes:
        """Sign arbitrary bytes with the specified key handle.

        Used by the audit logging system to sign record hashes.

        Parameters
        ----------
        message : bytes
            The raw bytes to sign.
        handle : KeyHandle
            The key handle to use for signing.

        Returns
        -------
        bytes
            The raw signature bytes.
        """
        return await self._provider.sign(handle, message)

    async def verify_signature(self, message: bytes, signature: bytes, public_key_b64: str) -> bool:
        """Verify a signature against a message and public key.

        Used by the audit logging system to verify record authenticity.

        Parameters
        ----------
        message : bytes
            The original message bytes that were signed.
        signature : bytes
            The raw signature bytes to verify.
        public_key_b64 : str
            Base64-encoded public key to use for verification.

        Returns
        -------
        bool
            True if the signature is valid, False otherwise.
        """
        # Create a temporary envelope-like structure to reuse the existing verification logic
        from unittest.mock import Mock
        envelope = Mock()
        envelope.signer_public_key_b64 = public_key_b64
        envelope.signature_b64 = base64.b64encode(signature).decode()
        envelope.message_hash = message
        
        return verify_signed_envelope(envelope)