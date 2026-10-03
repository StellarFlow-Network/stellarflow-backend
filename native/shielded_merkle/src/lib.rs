//! Small C ABI for the shielded-tree hot path.
//!
//! The application currently defines its hash reference as the legacy
//! `poseidon2:<left>:<right>` SHA-256 fallback in `merkle_service.py` when no
//! configured Poseidon implementation is present.  This crate deliberately
//! implements that exact, versioned compatibility rule.  It must be replaced
//! together with the Python reference once circuit parameters are specified.

use num_bigint::BigUint;
use num_traits::Num;
use sha2::{Digest, Sha256};
use std::slice;
use std::sync::OnceLock;

const ELEMENT_BYTES: usize = 32;
const MAX_DEPTH: usize = 32;
const BN254_PRIME_DECIMAL: &str =
    "21888242871839275222246405745257275088548364400416034343698204186575808495617";

fn prime() -> &'static BigUint {
    static PRIME: OnceLock<BigUint> = OnceLock::new();
    PRIME.get_or_init(|| {
        BigUint::from_str_radix(BN254_PRIME_DECIMAL, 10).expect("constant BN254 prime is valid")
    })
}

fn zeroes() -> &'static Vec<[u8; ELEMENT_BYTES]> {
    static ZEROES: OnceLock<Vec<[u8; ELEMENT_BYTES]>> = OnceLock::new();
    ZEROES.get_or_init(|| {
        let modulus = prime();
        let mut zeroes = vec![[0_u8; ELEMENT_BYTES]; MAX_DEPTH + 1];
        for level in 0..MAX_DEPTH {
            zeroes[level + 1] = legacy_hash(&zeroes[level], &zeroes[level], modulus);
        }
        zeroes
    })
}

fn legacy_hash(left: &[u8], right: &[u8], modulus: &BigUint) -> [u8; ELEMENT_BYTES] {
    let left = BigUint::from_bytes_be(left) % modulus;
    let right = BigUint::from_bytes_be(right) % modulus;
    let payload = format!("poseidon2:{left}:{right}");
    let digest = Sha256::digest(payload.as_bytes());
    let result = BigUint::from_bytes_be(&digest) % modulus;
    let encoded = result.to_bytes_be();
    let mut output = [0_u8; ELEMENT_BYTES];
    output[ELEMENT_BYTES - encoded.len()..].copy_from_slice(&encoded);
    output
}

/// Append packed 32-byte leaves to an incremental binary tree.
///
/// `frontier` and `out_frontier` contain `depth * 32` bytes.  The function
/// never retains caller memory and returns an error code for invalid inputs.
#[no_mangle]
pub unsafe extern "C" fn stellarflow_merkle_append(
    depth: u32,
    leaf_count: u64,
    frontier: *const u8,
    leaves: *const u8,
    leaves_len: usize,
    out_root: *mut u8,
    out_frontier: *mut u8,
) -> i32 {
    let depth = depth as usize;
    if depth == 0
        || depth > MAX_DEPTH
        || leaf_count >= (1_u64 << depth)
        || leaves_len % ELEMENT_BYTES != 0
    {
        return 1;
    }
    if frontier.is_null()
        || out_root.is_null()
        || out_frontier.is_null()
        || (leaves_len != 0 && leaves.is_null())
    {
        return 2;
    }
    let leaf_total = leaves_len / ELEMENT_BYTES;
    if leaf_total as u64 > (1_u64 << depth) - leaf_count {
        return 3;
    }

    let frontier_len = depth * ELEMENT_BYTES;
    let frontier_in = slice::from_raw_parts(frontier, frontier_len);
    let leaves_in = slice::from_raw_parts(leaves, leaves_len);
    let modulus = prime();
    let zeroes = zeroes();
    let mut state = frontier_in.to_vec();
    let mut count = leaf_count;
    let mut root = zeroes[depth];

    for leaf in leaves_in.chunks_exact(ELEMENT_BYTES) {
        let mut node = [0_u8; ELEMENT_BYTES];
        node.copy_from_slice(leaf);
        for level in 0..depth {
            if ((count >> level) & 1) == 0 {
                state[level * ELEMENT_BYTES..(level + 1) * ELEMENT_BYTES].copy_from_slice(&node);
                node = legacy_hash(&node, &zeroes[level], &modulus);
            } else {
                node = legacy_hash(
                    &state[level * ELEMENT_BYTES..(level + 1) * ELEMENT_BYTES],
                    &node,
                    &modulus,
                );
            }
        }
        root = node;
        count += 1;
    }

    if leaf_total == 0 {
        // A caller with an existing frontier must provide its already persisted
        // root; empty updates are not valid state transitions.
        return 4;
    }
    slice::from_raw_parts_mut(out_root, ELEMENT_BYTES).copy_from_slice(&root);
    slice::from_raw_parts_mut(out_frontier, frontier_len).copy_from_slice(&state);
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_index_zero_and_is_deterministic() {
        let depth = 32;
        let frontier = vec![0_u8; depth * ELEMENT_BYTES];
        let leaf = [1_u8; ELEMENT_BYTES];
        let mut first_root = [0_u8; ELEMENT_BYTES];
        let mut first_frontier = vec![0_u8; depth * ELEMENT_BYTES];
        let first = unsafe {
            stellarflow_merkle_append(
                depth as u32,
                0,
                frontier.as_ptr(),
                leaf.as_ptr(),
                leaf.len(),
                first_root.as_mut_ptr(),
                first_frontier.as_mut_ptr(),
            )
        };
        assert_eq!(first, 0);
        let mut second_root = [0_u8; ELEMENT_BYTES];
        let mut second_frontier = vec![0_u8; depth * ELEMENT_BYTES];
        let second = unsafe {
            stellarflow_merkle_append(
                depth as u32,
                0,
                frontier.as_ptr(),
                leaf.as_ptr(),
                leaf.len(),
                second_root.as_mut_ptr(),
                second_frontier.as_mut_ptr(),
            )
        };
        assert_eq!(second, 0);
        assert_eq!(first_root, second_root);
        assert_eq!(first_frontier, second_frontier);
    }

    #[test]
    fn rejects_invalid_inputs() {
        let input = [0_u8; ELEMENT_BYTES];
        let mut root = [0_u8; ELEMENT_BYTES];
        let mut frontier = vec![0_u8; 32 * ELEMENT_BYTES];
        let result = unsafe {
            stellarflow_merkle_append(
                33,
                0,
                frontier.as_ptr(),
                input.as_ptr(),
                input.len(),
                root.as_mut_ptr(),
                frontier.as_mut_ptr(),
            )
        };
        assert_eq!(result, 1);
    }
}
