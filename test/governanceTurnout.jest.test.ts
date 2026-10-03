/**
 * Unit tests for governance turnout analytics (Issue #1064).
 *
 * Covers the pure turnout maths and the controller's query validation /
 * response shaping. The database is replaced by an injected fetcher; the SQL
 * itself is exercised against TimescaleDB in the PR's verification notes.
 */
import { describe, it, expect, jest } from "@jest/globals";
import type { Request, Response } from "express";
import {
  buildTurnoutAnalytics,
  computeTrend,
  computeTurnoutPct,
  type TurnoutDailyRow,
  type TurnoutOverallRow,
} from "../src/analytics/governanceTurnout";
import {
  createTurnoutHandler,
  parseTurnoutQuery,
  MAX_RANGE_DAYS,
  TURNOUT_DEFINITION,
} from "../src/controllers/governanceTurnoutController";

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const categoryRow = (
  date: string,
  category: string,
  voters: number,
  eligibleVoters: number,
  votes = voters,
): TurnoutDailyRow => ({
  bucket: day(date),
  category,
  voters,
  votes,
  totalWeight: String(voters * 10),
  eligibleVoters,
});

describe("computeTurnoutPct", () => {
  it("returns the share of eligible voters, rounded to 2 dp", () => {
    expect(computeTurnoutPct(1, 3)).toBe(33.33);
    expect(computeTurnoutPct(2, 3)).toBe(66.67);
    expect(computeTurnoutPct(4, 4)).toBe(100);
  });

  it("is 0 when there is no electorate", () => {
    expect(computeTurnoutPct(0, 0)).toBe(0);
    expect(computeTurnoutPct(5, 0)).toBe(0);
  });

  it("never exceeds 100%", () => {
    expect(computeTurnoutPct(7, 5)).toBe(100);
  });
});

describe("computeTrend", () => {
  it("needs at least two data points", () => {
    expect(computeTrend([])).toEqual({ direction: "insufficient_data", changePct: 0 });
    expect(computeTrend([50])).toEqual({ direction: "insufficient_data", changePct: 0 });
  });

  it("detects rising participation", () => {
    expect(computeTrend([10, 20, 40, 50])).toEqual({ direction: "up", changePct: 30 });
  });

  it("detects falling participation", () => {
    expect(computeTrend([80, 70, 40, 30])).toEqual({ direction: "down", changePct: -40 });
  });

  it("treats changes under 1pp as flat", () => {
    expect(computeTrend([50, 50.4, 50.2, 50.6]).direction).toBe("flat");
  });

  it("ignores the middle day when the count is odd", () => {
    // earlier=[10], later=[30]; middle 999 must not skew the result.
    expect(computeTrend([10, 999, 30])).toEqual({ direction: "up", changePct: 20 });
  });
});

describe("buildTurnoutAnalytics", () => {
  const categoryRows: TurnoutDailyRow[] = [
    categoryRow("2026-09-03", "Upgrade", 4, 4),
    categoryRow("2026-09-01", "FeeChange", 2, 2),
    categoryRow("2026-09-02", "FeeChange", 2, 4),
    categoryRow("2026-09-02", "uncategorized", 1, 4),
  ];
  const overallRows: TurnoutOverallRow[] = [
    { bucket: day("2026-09-02"), voters: 3, votes: 3, totalWeight: "16", eligibleVoters: 4 },
    { bucket: day("2026-09-01"), voters: 2, votes: 2, totalWeight: "30", eligibleVoters: 2 },
  ];

  const result = buildTurnoutAnalytics(categoryRows, overallRows);

  it("computes turnout per day and category, ordered by date then category", () => {
    expect(result.byCategory.map((p) => [p.date, p.category, p.turnoutPct])).toEqual([
      ["2026-09-01", "FeeChange", 100],
      ["2026-09-02", "FeeChange", 50],
      ["2026-09-02", "uncategorized", 25],
      ["2026-09-03", "Upgrade", 100],
    ]);
  });

  it("rolls categories up using distinct voters, ordered by date", () => {
    expect(result.overall.map((p) => [p.date, p.voters, p.turnoutPct])).toEqual([
      ["2026-09-01", 2, 100],
      ["2026-09-02", 3, 75],
    ]);
  });

  it("summarises participation trends per category", () => {
    const fee = result.categories.find((c) => c.category === "FeeChange")!;
    expect(fee).toMatchObject({
      activeDays: 2,
      totalVotes: 4,
      avgTurnoutPct: 75,
      peakTurnoutPct: 100,
      latestTurnoutPct: 50,
      trend: { direction: "down", changePct: -50 },
    });

    const upgrade = result.categories.find((c) => c.category === "Upgrade")!;
    expect(upgrade.trend.direction).toBe("insufficient_data");
    expect(result.categories.map((c) => c.category)).toEqual([
      "FeeChange",
      "Upgrade",
      "uncategorized", // code-point order: uppercase sorts before lowercase
    ]);
  });

  it("returns empty structures when there is no data", () => {
    expect(buildTurnoutAnalytics([], [])).toEqual({
      overall: [],
      byCategory: [],
      categories: [],
    });
  });
});

describe("parseTurnoutQuery", () => {
  const now = new Date("2026-09-26T12:00:00.000Z");

  it("defaults to the 90 days before now", () => {
    const parsed = parseTurnoutQuery({}, now);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.to).toEqual(now);
    expect(parsed.value.from.toISOString()).toBe("2026-06-28T00:00:00.000Z");
    expect(parsed.value.category).toBeUndefined();
  });

  it("floors `from` to the start of its UTC day so the first bucket is included", () => {
    const parsed = parseTurnoutQuery(
      { from: "2026-09-02T15:30:00Z", to: "2026-09-10T00:00:00Z" },
      now,
    );
    expect(parsed.ok && parsed.value.from.toISOString()).toBe("2026-09-02T00:00:00.000Z");
  });

  it("accepts a valid category", () => {
    const parsed = parseTurnoutQuery({ category: "Fee Change" }, now);
    expect(parsed.ok && parsed.value.category).toBe("Fee Change");
  });

  it.each([
    [{ to: "nope" }, "Invalid `to`"],
    [{ from: "nope" }, "Invalid `from`"],
    [{ from: "2026-09-10T00:00:00Z", to: "2026-09-01T00:00:00Z" }, "earlier than"],
    [{ from: "2024-01-01T00:00:00Z", to: "2026-01-01T00:00:00Z" }, `${MAX_RANGE_DAYS} days`],
    [{ category: "x'; DROP TABLE" }, "`category` must be"],
    [{ category: "" }, "`category` must be"],
    [{ category: "a".repeat(65) }, "`category` must be"],
    [{ category: ["a", "b"] }, "single string"],
  ] as Array<[Record<string, unknown>, string]>)("rejects %j", (query, message) => {
    const parsed = parseTurnoutQuery(query as Request["query"], now);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain(message);
  });
});

describe("createTurnoutHandler", () => {
  const makeRes = () => {
    const res = { status: jest.fn(), json: jest.fn() };
    res.status.mockReturnValue(res);
    return res as unknown as Response & {
      status: jest.Mock;
      json: jest.Mock;
    };
  };

  it("responds with range, definition and analytics", async () => {
    const analytics = buildTurnoutAnalytics(
      [categoryRow("2026-09-01", "FeeChange", 1, 2)],
      [{ bucket: day("2026-09-01"), voters: 1, votes: 1, totalWeight: "10", eligibleVoters: 2 }],
    );
    const fetcher = jest.fn<() => Promise<typeof analytics>>().mockResolvedValue(analytics);
    const res = makeRes();

    await createTurnoutHandler(fetcher as never)(
      { query: { from: "2026-09-01T00:00:00Z", to: "2026-09-05T00:00:00Z", category: "FeeChange" } } as unknown as Request,
      res,
    );

    expect(fetcher).toHaveBeenCalledWith({
      from: day("2026-09-01"),
      to: new Date("2026-09-05T00:00:00Z"),
      category: "FeeChange",
    });
    const body = (res.json as jest.Mock).mock.calls[0]![0] as any;
    expect(body.success).toBe(true);
    expect(body.data.category).toBe("FeeChange");
    expect(body.data.definition).toBe(TURNOUT_DEFINITION);
    expect(body.data.range).toEqual({
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-09-05T00:00:00.000Z",
    });
    expect(body.data.overall[0].turnoutPct).toBe(50);
  });

  it("returns 400 without touching the database for bad input", async () => {
    const fetcher = jest.fn();
    const res = makeRes();

    await createTurnoutHandler(fetcher as never)(
      { query: { from: "garbage" } } as unknown as Request,
      res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns 500 when the query fails", async () => {
    const fetcher = jest.fn<() => Promise<never>>().mockRejectedValue(new Error("db down"));
    const res = makeRes();
    const spy = jest.spyOn(console, "error").mockImplementation(() => undefined);

    await createTurnoutHandler(fetcher as never)({ query: {} } as unknown as Request, res);

    expect(res.status).toHaveBeenCalledWith(500);
    spy.mockRestore();
  });
});
