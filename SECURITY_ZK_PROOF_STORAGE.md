# Private ZK data at rest

Proof witnesses, private proof inputs, and nullifier-tree frontiers are
encrypted before they cross the database boundary. The storage envelope uses
AES-256-GCM with a fresh random 96-bit nonce and a fresh data-encryption key
for every value. The nonce, ciphertext, and wrapped data key are safe to store
together; the plaintext data key is never written to the database.

The data key is wrapped by a key-encryption key held by AWS KMS or HashiCorp
Vault Transit. This is envelope encryption: database administrators can see an
opaque envelope, but cannot decrypt it without access to the KMS/Vault policy.
Associated data binds an envelope to its record (for example, `proof:<hash>`
or `tree:<ledger-sequence>`), so copying a valid ciphertext to another row
causes AES-GCM authentication to fail.

## Provider configuration

Use one provider in production:

```text
# AWS KMS
PROOF_STORAGE_PROVIDER=kms
PROOF_STORAGE_KMS_KEY_ID=arn:aws:kms:us-east-1:123456789012:key/...
AWS_REGION=us-east-1

# Or Vault Transit
PROOF_STORAGE_PROVIDER=vault
VAULT_ADDR=https://vault.example.internal
VAULT_TOKEN=<short-lived workload token>
PROOF_STORAGE_VAULT_KEY=stellarflow-proof-storage
VAULT_TRANSIT_MOUNT=transit
```

Do not set a shared AES key in an environment variable. KMS/Vault is the
source of the wrapping key, and access should be granted through the workload
identity with audit logging and least privilege.

Migration `0009` adds nullable JSONB envelope columns to the shielded tables.
They are nullable to support rolling deploys and historical public-only rows;
new persistence code should populate `encrypted_proof_inputs` and
`encrypted_tree_state` and must not place private values in the existing
plaintext JSON fields.
