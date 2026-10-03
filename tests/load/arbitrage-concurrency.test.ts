import assert from "node:assert/strict";
import test from "node:test";

interface PoolState {
  reserveA: number;
  reserveB: number;
  completed: number;
}

async function executeSerialized(
  locks: Map<string, Promise<void>>,
  poolKey: string,
  operation: (state: PoolState) => void,
  states: Map<string, PoolState>,
): Promise<void> {
  const previous = locks.get(poolKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(poolKey, previous.then(() => current));
  await previous;
  try {
    operation(states.get(poolKey)!);
  } finally {
    release();
    if (locks.get(poolKey) === current) locks.delete(poolKey);
  }
}

test("executes 100 concurrent arbitrage orders across five pools consistently", async () => {
  const states = new Map(
    Array.from({ length: 5 }, (_, index) => [
      `pool-${index}`,
      { reserveA: 1_000_000, reserveB: 1_000_000, completed: 0 },
    ] as const),
  );
  const initialTotal = 10_000_000;
  const locks = new Map<string, Promise<void>>();

  await Promise.all(
    Array.from({ length: 100 }, (_, index) => {
      const poolKey = `pool-${index % 5}`;
      return executeSerialized(
        locks,
        poolKey,
        (state) => {
          const amount = 100 + (index % 10);
          const nextA = state.reserveA + amount;
          const nextB = state.reserveB - amount;
          if (nextB < 0) throw new Error("pool reserve underflow");
          state.reserveA = nextA;
          state.reserveB = nextB;
          state.completed += 1;
        },
        states,
      );
    }),
  );

  const completed = [...states.values()].reduce((total, state) => total + state.completed, 0);
  const finalTotal = [...states.values()].reduce(
    (total, state) => total + state.reserveA + state.reserveB,
    0,
  );
  assert.equal(completed, 100);
  assert.equal(finalTotal, initialTotal);
  assert.ok([...states.values()].every((state) => state.reserveA > 0 && state.reserveB > 0));
});