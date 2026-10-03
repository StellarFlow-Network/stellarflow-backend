/**
 * Governance turnout analytics (Issue #1064).
 *
 * Pure functions that turn rows read from the `governance_turnout_daily`
 * TimescaleDB continuous aggregate (see prisma/governance_turnout_aggregate.sql)
 * into the API response. No I/O lives here so the maths is unit-testable.
 *
 * Definitions
 * -----------
 * - **voters**          distinct accounts that voted on a day (in a category).
 * - **eligibleVoters**  distinct accounts that have voted at least once on or
 *                       before that day, in any category. The protocol has no
 *                       on-chain voter registry, so the participating base
 *                       stands in for the electorate.
 * - **turnoutPct**      voters / eligibleVoters × 100, rounded to 2 dp.
 *
 * Days on which nobody voted in a category have no row; trend statistics are
 * computed over days with activity.
 */

export const TREND_FLAT_THRESHOLD_PP = 1;

/** One (day, category) row from the aggregate query. */
export interface TurnoutDailyRow {
  bucket: Date;
  category: string;
  voters: number;
  votes: number;
  /** Decimal string — weights exceed the safe range of a JS number. */
  totalWeight: string;
  eligibleVoters: number;
}

/** One day rolled up across every category (distinct voters, not a sum). */
export interface TurnoutOverallRow {
  bucket: Date;
  voters: number;
  votes: number;
  totalWeight: string;
  eligibleVoters: number;
}

export interface TurnoutPoint {
  date: string;
  voters: number;
  votes: number;
  totalWeight: string;
  eligibleVoters: number;
  turnoutPct: number;
}

export interface CategoryTurnoutPoint extends TurnoutPoint {
  category: string;
}

export type TrendDirection = "up" | "down" | "flat" | "insufficient_data";

export interface CategoryTrend {
  category: string;
  activeDays: number;
  totalVotes: number;
  avgTurnoutPct: number;
  peakTurnoutPct: number;
  latestTurnoutPct: number;
  trend: {
    direction: TrendDirection;
    /** Later-half average minus earlier-half average, in percentage points. */
    changePct: number;
  };
}

export interface TurnoutAnalytics {
  overall: TurnoutPoint[];
  byCategory: CategoryTurnoutPoint[];
  categories: CategoryTrend[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Code-point comparison — deterministic regardless of the host locale/ICU. */
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function computeTurnoutPct(voters: number, eligibleVoters: number): number {
  if (eligibleVoters <= 0) return 0;
  // Late-arriving backfills can momentarily put voters above the base; cap so
  // dashboards never show >100%.
  return round2(Math.min(voters / eligibleVoters, 1) * 100);
}

export function toDateKey(bucket: Date): string {
  return bucket.toISOString().slice(0, 10);
}

function toPoint(row: TurnoutOverallRow): TurnoutPoint {
  return {
    date: toDateKey(row.bucket),
    voters: row.voters,
    votes: row.votes,
    totalWeight: row.totalWeight,
    eligibleVoters: row.eligibleVoters,
    turnoutPct: computeTurnoutPct(row.voters, row.eligibleVoters),
  };
}

const mean = (values: number[]): number =>
  values.reduce((sum, v) => sum + v, 0) / values.length;

/**
 * Compare the average turnout of the later half of a category's active days
 * with the earlier half. An odd middle day is excluded so the halves are equal.
 */
export function computeTrend(turnoutPcts: number[]): CategoryTrend["trend"] {
  if (turnoutPcts.length < 2) {
    return { direction: "insufficient_data", changePct: 0 };
  }
  const half = Math.floor(turnoutPcts.length / 2);
  const earlier = turnoutPcts.slice(0, half);
  const later = turnoutPcts.slice(turnoutPcts.length - half);
  const changePct = round2(mean(later) - mean(earlier));

  let direction: TrendDirection = "flat";
  if (changePct >= TREND_FLAT_THRESHOLD_PP) direction = "up";
  else if (changePct <= -TREND_FLAT_THRESHOLD_PP) direction = "down";
  return { direction, changePct };
}

export function summarizeCategories(
  points: CategoryTurnoutPoint[],
): CategoryTrend[] {
  const grouped = new Map<string, CategoryTurnoutPoint[]>();
  for (const point of points) {
    const list = grouped.get(point.category) ?? [];
    list.push(point);
    grouped.set(point.category, list);
  }

  return [...grouped.entries()]
    .map(([category, list]) => {
      const ordered = [...list].sort((a, b) => compare(a.date, b.date));
      const pcts = ordered.map((p) => p.turnoutPct);
      return {
        category,
        activeDays: ordered.length,
        totalVotes: ordered.reduce((sum, p) => sum + p.votes, 0),
        avgTurnoutPct: round2(mean(pcts)),
        peakTurnoutPct: Math.max(...pcts),
        latestTurnoutPct: pcts[pcts.length - 1]!,
        trend: computeTrend(pcts),
      };
    })
    .sort((a, b) => compare(a.category, b.category));
}

export function buildTurnoutAnalytics(
  categoryRows: TurnoutDailyRow[],
  overallRows: TurnoutOverallRow[],
): TurnoutAnalytics {
  const byCategory: CategoryTurnoutPoint[] = categoryRows
    .map((row) => ({ category: row.category, ...toPoint(row) }))
    .sort(
      (a, b) => compare(a.date, b.date) || compare(a.category, b.category),
    );

  const overall = overallRows
    .map(toPoint)
    .sort((a, b) => compare(a.date, b.date));

  return { overall, byCategory, categories: summarizeCategories(byCategory) };
}
