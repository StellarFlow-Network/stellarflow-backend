import assert from "node:assert/strict";
import test from "node:test";
import { RpcLoadBalancer } from "../src/lib/rpcLoadBalancer";

test("weighted round robin distributes selections by weight", () => {
  const balancer = new RpcLoadBalancer([
    { url: "primary", weight: 2 },
    { url: "backup", weight: 1 },
  ]);
  const selected = Array.from({ length: 6 }, () => balancer.next()?.url);
  assert.deepEqual(selected, ["primary", "primary", "backup", "primary", "primary", "backup"]);
});

test("failed endpoints are skipped until cooldown expires", () => {
  const balancer = new RpcLoadBalancer(
    [{ url: "primary" }, { url: "backup" }],
    { cooldownMs: 100 },
  );
  balancer.recordFailure("primary", 2500, 1_000);
  assert.equal(balancer.next(1_050)?.url, "backup");
  assert.equal(balancer.next(1_101)?.url, "primary");
});

test("success restores an endpoint and records latency", () => {
  const balancer = new RpcLoadBalancer([{ url: "primary" }]);
  balancer.recordFailure("primary", 3_000, 1_000);
  balancer.recordSuccess("primary", 120);
  assert.deepEqual(balancer.snapshot(), [
    { url: "primary", weight: 1, healthy: true, latencyMs: 120 },
  ]);
});
