"""Envelope encryption for private proof material and nullifier-tree state.

The database must never receive a proof witness, private input, or Merkle-tree
frontier in plaintext.  This module keeps the data-encryption operation local
and fast (AES-256-GCM), while the key-encryption key remains in AWS KMS or
HashiCorp Vault.  A fresh data key is generated for every stored value, so a
database compromise does not expose a reusable application-wide AES key.

The provider protocol is intentionally small so tests and other HSM providers
can be supplied without coupling persistence code to a cloud SDK.
"""

from __future__ import annotations

import base64
import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Mapping, Protocol

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

__all__ = [
    "EncryptedValue",
    "EnvelopeKeyProvider",
    "KmsEnvelopeKeyProvider",
    "VaultEnvelopeKeyProvider",
    "ProofEncryptor",
    "proof_encryptor_from_environment",
]


def _b64(value: bytes) -> str:
    return base64.b64encode(value).decode("ascii")


def _unb64(value: str) -> bytes:
    return base64.b64decode(value.encode("ascii"), validate=True)


class EnvelopeKeyProvider(Protocol):
    """Provider for wrapping and unwrapping AES data keys."""

    key_id: str

    def generate_data_key(self) -> tuple[bytes, bytes]:
        """Return ``(plaintext_key, provider_wrapped_key)``."""

    def decrypt_data_key(self, wrapped_key: bytes) -> bytes:
        """Unwrap a provider-encrypted AES data key."""


@dataclass(frozen=True)
class EncryptedValue:
    """Serializable AES-256-GCM envelope stored alongside a database row."""

    ciphertext: str
    nonce: str
    wrapped_key: str
    key_id: str
    version: int = 1
    algorithm: str = "AES-256-GCM"

    def as_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "algorithm": self.algorithm,
            "ciphertext": self.ciphertext,
            "nonce": self.nonce,
            "wrapped_key": self.wrapped_key,
            "key_id": self.key_id,
        }

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "EncryptedValue":
        if value.get("version") != 1 or value.get("algorithm") != "AES-256-GCM":
            raise ValueError("Unsupported proof encryption envelope")
        required = ("ciphertext", "nonce", "wrapped_key", "key_id")
        if any(not isinstance(value.get(field), str) for field in required):
            raise ValueError("Malformed proof encryption envelope")
        return cls(
            ciphertext=value["ciphertext"],
            nonce=value["nonce"],
            wrapped_key=value["wrapped_key"],
            key_id=value["key_id"],
        )


class KmsEnvelopeKeyProvider:
    """AWS KMS data-key provider.

    KMS owns the customer-managed key; only a one-use plaintext AES data key
    is returned to this process and the wrapped copy is safe to persist.
    """

    def __init__(self, key_id: str, *, region_name: str | None = None) -> None:
        if not key_id:
            raise ValueError("A KMS key id is required")
        import boto3

        self.key_id = key_id
        self._client = boto3.client(
            "kms", region_name=region_name or os.getenv("AWS_REGION") or "us-east-1"
        )

    def generate_data_key(self) -> tuple[bytes, bytes]:
        response = self._client.generate_data_key(KeyId=self.key_id, KeySpec="AES_256")
        return bytes(response["Plaintext"]), bytes(response["CiphertextBlob"])

    def decrypt_data_key(self, wrapped_key: bytes) -> bytes:
        response = self._client.decrypt(CiphertextBlob=wrapped_key, KeyId=self.key_id)
        return bytes(response["Plaintext"])


class VaultEnvelopeKeyProvider:
    """HashiCorp Vault Transit data-key provider using its HTTP API.

    Vault's transit key is never exported.  The plaintext data key exists only
    for the duration of the local AES operation; the persisted value is Vault's
    opaque ciphertext.
    """

    def __init__(
        self,
        key_id: str,
        *,
        address: str | None = None,
        token: str | None = None,
        mount: str = "transit",
        timeout: float = 5.0,
    ) -> None:
        self.key_id = key_id
        self._address = (address or os.environ.get("VAULT_ADDR", "")).rstrip("/")
        self._token = token or os.environ.get("VAULT_TOKEN", "")
        self._mount = mount.strip("/")
        self._timeout = timeout
        if not self._address or not self._token:
            raise ValueError("VAULT_ADDR and VAULT_TOKEN are required")

    def _request(self, path: str, payload: Mapping[str, Any]) -> Mapping[str, Any]:
        body = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            f"{self._address}/v1/{path.lstrip('/')}",
            data=body,
            headers={
                "Content-Type": "application/json",
                "X-Vault-Token": self._token,
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                result = json.load(response)
        except (urllib.error.URLError, TimeoutError) as exc:
            raise RuntimeError("Vault transit request failed") from exc
        if not isinstance(result, dict) or not isinstance(result.get("data"), dict):
            raise RuntimeError("Vault transit returned an invalid response")
        return result["data"]

    def generate_data_key(self) -> tuple[bytes, bytes]:
        data = self._request(f"{self._mount}/datakey/plaintext/{self.key_id}", {"bits": 256})
        try:
            return _unb64(data["plaintext"]), data["ciphertext"].encode("utf-8")
        except (KeyError, TypeError, ValueError) as exc:
            raise RuntimeError("Vault did not return a valid data key") from exc

    def decrypt_data_key(self, wrapped_key: bytes) -> bytes:
        data = self._request(
            f"{self._mount}/decrypt/{self.key_id}",
            {"ciphertext": wrapped_key.decode("utf-8")},
        )
        try:
            return _unb64(data["plaintext"])
        except (KeyError, TypeError, ValueError) as exc:
            raise RuntimeError("Vault did not return a valid plaintext data key") from exc


class ProofEncryptor:
    """Encrypt/decrypt JSON values at the persistence boundary."""

    def __init__(self, provider: EnvelopeKeyProvider) -> None:
        self._provider = provider

    def encrypt(self, value: Any, *, associated_data: str) -> EncryptedValue:
        raw_key, wrapped_key = self._provider.generate_data_key()
        plaintext_key = bytearray(raw_key)
        nonce = os.urandom(12)
        try:
            plaintext = json.dumps(
                value, ensure_ascii=False, separators=(",", ":"), sort_keys=True
            ).encode("utf-8")
            ciphertext = AESGCM(bytes(plaintext_key)).encrypt(
                nonce, plaintext, associated_data.encode("utf-8")
            )
            return EncryptedValue(
                ciphertext=_b64(ciphertext),
                nonce=_b64(nonce),
                wrapped_key=_b64(wrapped_key),
                key_id=self._provider.key_id,
            )
        finally:
            # Best-effort clearing prevents accidental reuse of the DEK in this
            # process.  Python cannot guarantee erasure of immutable copies.
            plaintext_key[:] = b"\x00" * len(plaintext_key)

    def decrypt(self, envelope: EncryptedValue | Mapping[str, Any], *, associated_data: str) -> Any:
        parsed = envelope if isinstance(envelope, EncryptedValue) else EncryptedValue.from_mapping(envelope)
        key = bytearray(self._provider.decrypt_data_key(_unb64(parsed.wrapped_key)))
        try:
            plaintext = AESGCM(bytes(key)).decrypt(
                _unb64(parsed.nonce),
                _unb64(parsed.ciphertext),
                associated_data.encode("utf-8"),
            )
            return json.loads(plaintext.decode("utf-8"))
        finally:
            key[:] = b"\x00" * len(key)


def proof_encryptor_from_environment() -> ProofEncryptor | None:
    """Build the configured encryptor, or ``None`` for public-only deployments.

    If a private field is received without a configured provider, the
    persistence boundary fails closed instead of writing that field in
    plaintext.
    """
    provider = os.getenv("PROOF_STORAGE_PROVIDER", "").lower()
    if provider == "kms":
        key_id = os.getenv("PROOF_STORAGE_KMS_KEY_ID") or os.getenv("KMS_ENVELOPE_KEY_ID")
        if not key_id:
            raise RuntimeError("PROOF_STORAGE_KMS_KEY_ID is required for KMS proof storage")
        return ProofEncryptor(KmsEnvelopeKeyProvider(key_id))
    if provider == "vault":
        key_id = os.getenv("PROOF_STORAGE_VAULT_KEY")
        if not key_id:
            raise RuntimeError("PROOF_STORAGE_VAULT_KEY is required for Vault proof storage")
        return ProofEncryptor(
            VaultEnvelopeKeyProvider(
                key_id,
                mount=os.getenv("VAULT_TRANSIT_MOUNT", "transit"),
            )
        )
    if provider:
        raise RuntimeError("PROOF_STORAGE_PROVIDER must be either 'kms' or 'vault'")
    return None
