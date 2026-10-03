import { parseRedisUsedMemory } from "../src/services/redisMemoryMetric";

describe("parseRedisUsedMemory", () => {
  it("reads used_memory from Redis INFO output", () => {
    expect(
      parseRedisUsedMemory(
        "# Memory\r\nused_memory:8192\r\nmaxmemory:65536\r\n",
      ),
    ).toBe(8192);
  });

  it("accepts a zero value", () => {
    expect(parseRedisUsedMemory("used_memory:0\n")).toBe(0);
  });

  it.each([
    "",
    "maxmemory:100",
    "used_memory:not-a-number",
    "used_memory:-1",
    "used_memory:9007199254740992",
  ])("rejects missing or invalid memory values: %s", (info) =>
    expect(parseRedisUsedMemory(info)).toBeNull(),
  );
});
