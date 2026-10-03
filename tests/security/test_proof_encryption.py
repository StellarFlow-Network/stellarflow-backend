"""Tests for the private ZK data envelope."""

from __future__ import annotations

import base64

import pytest

from app.security.proof_encryption import EncryptedValue, ProofEncryptor


class FakeKeyProvider:
    key_id = "test-kms-key"

    def __init__(self) -> None:
        self._keys: dict[bytes, bytes] = {}

    def generate_data_key(self) -> tuple[bytes, bytes]:
        key = b"0123456789abcdef0123456789abcdef"
        wrapped = b"wrapped:" + base64.b64encode(key)
        self._keys[wrapped] = key
        return key, wrapped

    def decrypt_data_key(self, wrapped_key: bytes) -> bytes:
        return self._keys[wrapped_key]


def test_private_payload_round_trips_without_plaintext_in_envelope() -> None:
    encryptor = ProofEncryptor(FakeKeyProvider())
    payload = {"witness": ["secret", 42], "public_inputs": ["root"]}

    envelope = encryptor.encrypt(payload, associated_data="proof:abc")
    serialized = str(envelope.as_dict())

    assert encryptor.decrypt(envelope, associated_data="proof:abc") == payload
    assert "secret" not in serialized
    assert "public_inputs" not in serialized


def test_associated_data_prevents_moving_a_payload_between_records() -> None:
    encryptor = ProofEncryptor(FakeKeyProvider())
    envelope = encryptor.encrypt({"witness": "secret"}, associated_data="proof:abc")

    with pytest.raises(Exception):
        encryptor.decrypt(envelope, associated_data="proof:other")


def test_envelope_can_be_reconstituted_from_database_json() -> None:
    encryptor = ProofEncryptor(FakeKeyProvider())
    envelope = encryptor.encrypt({"frontier": ["a" * 64]}, associated_data="tree:1")
    restored = EncryptedValue.from_mapping(envelope.as_dict())

    assert encryptor.decrypt(restored, associated_data="tree:1") == {
        "frontier": ["a" * 64]
    }
