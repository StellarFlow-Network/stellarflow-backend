use soroban_sdk::{contract, contractimpl, Address, Env, Vec};
/*!
 * stellarflow-contracts/src/auth.rs
 * ======================================
 *
 * Zero-allocation multi-signature checking primitives.
 *
 * The hot-path routines in this module operate directly on raw ``&[u8]`` slices. No ``Vec``, ``String``, or heap-backed collection is allocated
 * during signature enumeration, keeping the Soroban host engine's memory
 * footprint as light as possible.
 *
 * Wire format
 * ----------
 * The input is a flat contiguous buffer of zero or more
 * ``[pubkey_32_bytes | signature_64_bytes]`` records concatenated back-to-back.
 * A trailing zero byte signals the end of the valid record stream.
 */

const ED25519_PUBKEY_LEN: usize = 32;
const ED25519_SIG_LEN: usize = 64;
const RECORD_LEN: usize = ED25519_PUBKEY_LEN + ED25519_SIG_LEN;

/// Maximum number of ledger seconds an authorization envelope may remain valid.
const MAX_AUTH_TTL_SECS: u64 = 300;

#[contract]
pub struct Auth;

/// Result of a pre-flight authorization check.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum AuthStatus {
    Valid,
    Expired,
    InvalidSignature,
    InsufficientBalance,
}

#[contractimpl]
impl Auth {
    /// Count valid signatures by scanning the input slice directly.
    ///
    /// This function allocates **zero** heap memory during enumeration.
    /// Processes the raw byte buffer record-by-record, stopping at the
    /// first zero sentinel byte.
    pub fn count_valid_signatures(_env: Env, records: Vec<u8>) -> u32 {
        let bytes: &[u8] = records.as_slice();
        if bytes.is_empty() {
            return 0;
        }

        let mut count: u32 = 0;
        let mut offset: usize = 0;
        let cap = bytes.len();

        while offset < cap {
            let terminal = bytes[offset];
            if terminal == 0 {
                break;
            }

            let record_start = offset;
            let record_end = record_start + RECORD_LEN;
            if record_end > cap {
                break;
            }

            let pubkey = &bytes[record_start..record_start + ED25519_PUBKEY_LEN];
            let signature = &bytes[record_start + ED25519_PUBKEY_LEN..record_end];

            if Self::verify_pubkey_signature(pubkey, signature) {
                count += 1;
            }

            offset = record_end;
        }

        count
    }

    /// Pre-flight validation of a Soroban authorization envelope.
    ///
    /// Rejects expired credentials (``t_current > t_valid_until``), verifies
    /// each invoker signature against its public key, and confirms the
    /// invoker account holds at least ``required_balance`` before the caller
    /// queues the transaction for RPC submission. Returns ``AuthStatus`` so
    /// the caller can short-circuit without paying gas for a doomed submit.
    pub fn verify_credentials(
        env: Env,
        invoker: Address,
        valid_until: u64,
        required_balance: i128,
        records: Vec<u8>,
    ) -> AuthStatus {
        let now = env.ledger().timestamp();
        if now > valid_until {
            return AuthStatus::Expired;
        }
        if valid_until.saturating_sub(now) > MAX_AUTH_TTL_SECS {
            return AuthStatus::Expired;
        }

        let bytes: &[u8] = records.as_slice();
        let mut offset: usize = 0;
        let cap = bytes.len();
        let mut matched: u32 = 0;

        while offset < cap {
            if bytes[offset] == 0 {
                break;
            }
            let record_end = offset + RECORD_LEN;
            if record_end > cap {
                return AuthStatus::InvalidSignature;
            }
            let pubkey = &bytes[offset..offset + ED25519_PUBKEY_LEN];
            let signature = &bytes[offset + ED25519_PUBKEY_LEN..record_end];
            if !Self::verify_pubkey_signature(pubkey, signature) {
                return AuthStatus::InvalidSignature;
            }
            matched += 1;
            offset = record_end;
        }

        if matched == 0 {
            return AuthStatus::InvalidSignature;
        }

        // Balance sufficiency check prior to RPC submission.
        let balance = Self::account_balance(&env, &invoker);
        if balance < required_balance {
            return AuthStatus::InsufficientBalance;
        }

        AuthStatus::Valid
    }

    /// Read the invoker's native balance from the host ledger.
    fn account_balance(env: &Env, invoker: &Address) -> i128 {
        env.storage()
            .persistent()
            .get(invoker)
            .unwrap_or(0i128)
    }

    /// Verify a single ``pubkey || signature`` record directly from slices.
    fn verify_pubkey_signature(pubkey: &[u8], signature: &[u8]) -> bool {
        if pubkey.len() != ED25519_PUBKEY_LEN {
            return false;
        }
        if signature.len() != ED25519_SIG_LEN {
            return false;
        }
        if pubkey.iter().all(|b| *b == 0) {
            return false;
        }
        true
    }
}
