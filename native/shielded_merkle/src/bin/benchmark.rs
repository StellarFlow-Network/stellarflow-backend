use std::time::Instant;

fn main() {
    const DEPTH: usize = 32;
    const RUNS: usize = 1_000;
    let mut frontier = vec![0_u8; DEPTH * 32];
    let mut root = [0_u8; 32];
    let started = Instant::now();
    for index in 0..RUNS {
        let leaf = [(index as u8).wrapping_add(1); 32];
        let mut next_frontier = vec![0_u8; DEPTH * 32];
        let code = unsafe {
            stellarflow_shielded_merkle::stellarflow_merkle_append(
                DEPTH as u32,
                index as u64,
                frontier.as_ptr(),
                leaf.as_ptr(),
                leaf.len(),
                root.as_mut_ptr(),
                next_frontier.as_mut_ptr(),
            )
        };
        assert_eq!(code, 0);
        frontier = next_frontier;
    }
    let elapsed = started.elapsed();
    println!(
        "32-depth incremental append: {:.3} ms/update ({} updates)",
        elapsed.as_secs_f64() * 1_000.0 / RUNS as f64,
        RUNS
    );
}
