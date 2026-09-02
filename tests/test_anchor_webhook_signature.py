import hashlib
import hmac

from app.adapters.anchor import verify_hmac_signature


def test_verify_hmac_signature_accepts_sha256_prefix() -> None:
    payload = b'{"transaction":{"id":"abc","status":"DELIVERED"}}'
    secret = b"partner-secret"
    digest = hmac.new(secret, payload, hashlib.sha256).hexdigest()

    assert verify_hmac_signature(payload, f"sha256={digest}", secret) is True
    assert verify_hmac_signature(payload, digest, secret) is True
