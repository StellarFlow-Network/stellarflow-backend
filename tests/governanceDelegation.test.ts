import {
  MAX_DELEGATION_DEPTH,
  resolveDelegation,
  computeEffectiveWeights,
} from "../src/logic/governanceDelegation";
import { GovernanceDelegationIndexer } from "../src/logic/governanceDelegationIndexer";

const makeLogger = () => ({ warn: jest.fn() });

const chain = (length: number): Map<string, string> => {
  const edges = new Map<string, string>();
  for (let i = 0; i < length; i++) edges.set(`a${i}`, `a${i + 1}`);
  return edges;
};

describe("governance delegation", () => {
  it("uses a max depth of 5", () => {
    expect(MAX_DELEGATION_DEPTH).toBe(5);
  });

  it("resolves a simple chain", () => {
    const logger = makeLogger();
    const res = resolveDelegation("a0", chain(3), { logger });
    expect(res.holder).toBe("a3");
    expect(res.hops).toBe(3);
    expect(res.status).toBe("ok");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("allows exactly 5 hops", () => {
    const logger = makeLogger();
    const res = resolveDelegation("a0", chain(5), { logger });
    expect(res.holder).toBe("a5");
    expect(res.status).toBe("ok");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("stops forwarding beyond depth 5", () => {
    const logger = makeLogger();
    const res = resolveDelegation("a0", chain(8), { logger });
    expect(res.holder).toBe("a5");
    expect(res.hops).toBe(5);
    expect(res.status).toBe("depth_exceeded");
    expect(logger.warn).toHaveBeenCalledWith(
      "GovernanceDelegationDepthExceeded",
      expect.anything(),
    );
  });

  it("detects a cycle A -> B -> C -> A and halts forwarding", () => {
    const logger = makeLogger();
    const edges = new Map([
      ["A", "B"],
      ["B", "C"],
      ["C", "A"],
    ]);
    const res = resolveDelegation("A", edges, { logger });
    expect(res.status).toBe("cycle");
    expect(res.holder).toBe("A");
    expect(res.path).toEqual(["A", "B", "C", "A"]);
    expect(logger.warn).toHaveBeenCalledWith(
      "GovernanceDelegationCycleDetected",
      expect.anything(),
    );
  });

  it("sums effective weights along a chain", () => {
    const edges = new Map([
      ["a", "b"],
      ["b", "c"],
    ]);
    const own = new Map([
      ["a", 10],
      ["b", 5],
      ["c", 1],
    ]);
    const result = computeEffectiveWeights(own, edges, { logger: makeLogger() });
    expect(result.get("c")).toBe(16);
    expect(result.get("a")).toBeUndefined();
  });

  it("keeps cyclic weight with its owner", () => {
    const edges = new Map([
      ["x", "y"],
      ["y", "x"],
    ]);
    const own = new Map([
      ["x", 3],
      ["y", 4],
    ]);
    const result = computeEffectiveWeights(own, edges, { logger: makeLogger() });
    expect(result.get("x")).toBe(3);
    expect(result.get("y")).toBe(4);
  });

  it("indexer supports set, remove and resolve", () => {
    const indexer = new GovernanceDelegationIndexer({ logger: makeLogger() });
    indexer.setDelegation("a", "b");
    indexer.setDelegation("b", "c");
    expect(indexer.resolve("a").holder).toBe("c");
    indexer.removeDelegation("b");
    expect(indexer.resolve("a").holder).toBe("b");
    expect(indexer.size()).toBe(1);
  });
});
