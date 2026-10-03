# Soroban state proof endpoint

`POST /api/v1/state/verify-proof` accepts JSON with:

```json
{
  "ledgerHeaderXdr": "<base64 LedgerHeader XDR>",
  "ledgerEntryXdr": "<base64 ContractData LedgerEntry XDR>",
  "contractId": "<C... Stellar contract StrKey>",
  "keyXdr": "<base64 ScVal XDR>",
  "proof": [
    { "hash": "<32-byte sibling hash as 64 hex characters>", "side": "left" }
  ]
}
```

The verifier confirms the XDR types and that the ledger entry is the requested
ContractData key for the requested contract. It hashes the canonical
`BucketEntry.liveentry` XDR with SHA-256, folds the ordered sibling path by
hashing `left || right` at each level, then compares the result with the
`bucketListHash` from the decoded ledger header. A mismatch or malformed proof
returns HTTP 400 with code `InvalidLedgerProof`.

The proof only establishes inclusion relative to the supplied ledger header.
Clients must authenticate that header independently (for example, from a
consensus-verified ledger source); a header supplied by an untrusted RPC is not
itself a trust anchor.
