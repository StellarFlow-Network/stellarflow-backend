/**
 * GovernanceTurnoutService (Issue #1064)
 *
 * Reads daily voting-turnout data from the `governance_turnout_daily`
 * TimescaleDB continuous aggregate (prisma/governance_turnout_aggregate.sql).
 * The aggregate keeps one row per (day, category, voter), which lets us derive
 * exact distinct-voter counts and the cumulative electorate with plain SQL.
 */

import prisma from "../lib/prisma.js";
import {
  buildTurnoutAnalytics,
  type TurnoutAnalytics,
  type TurnoutDailyRow,
  type TurnoutOverallRow,
} from "../analytics/governanceTurnout.js";

export interface TurnoutQuery {
  from: Date;
  to: Date;
  /** Restrict to one proposal category (GovernanceProposal.actionType). */
  category?: string;
}

type CategoryRow = {
  bucket: Date;
  category: string;
  voters: number;
  votes: number;
  total_weight: string;
  eligible_voters: number;
};

type OverallRow = Omit<CategoryRow, "category">;

export async function getTurnoutAnalytics(
  query: TurnoutQuery,
): Promise<TurnoutAnalytics> {
  const { from, to } = query;
  const category = query.category ?? null;

  const [categoryRows, overallRows] = await Promise.all([
    prisma.$queryRaw<CategoryRow[]>`
      WITH daily AS (
        SELECT bucket,
               category,
               COUNT(*)::int                  AS voters,
               SUM(vote_count)::int           AS votes,
               SUM(total_weight)::text        AS total_weight
        FROM governance_turnout_daily
        WHERE bucket >= ${from} AND bucket <= ${to}
          AND (${category}::text IS NULL OR category = ${category}::text)
        GROUP BY bucket, category
      ),
      first_seen AS (
        SELECT MIN(bucket) AS first_bucket
        FROM governance_turnout_daily
        GROUP BY account_id
      )
      SELECT d.bucket,
             d.category,
             d.voters,
             d.votes,
             d.total_weight,
             (SELECT COUNT(*) FROM first_seen f WHERE f.first_bucket <= d.bucket)::int
               AS eligible_voters
      FROM daily d
      ORDER BY d.bucket ASC, d.category ASC;
    `,
    prisma.$queryRaw<OverallRow[]>`
      WITH daily AS (
        SELECT bucket,
               COUNT(DISTINCT account_id)::int AS voters,
               SUM(vote_count)::int            AS votes,
               SUM(total_weight)::text         AS total_weight
        FROM governance_turnout_daily
        WHERE bucket >= ${from} AND bucket <= ${to}
          AND (${category}::text IS NULL OR category = ${category}::text)
        GROUP BY bucket
      ),
      first_seen AS (
        SELECT MIN(bucket) AS first_bucket
        FROM governance_turnout_daily
        GROUP BY account_id
      )
      SELECT d.bucket,
             d.voters,
             d.votes,
             d.total_weight,
             (SELECT COUNT(*) FROM first_seen f WHERE f.first_bucket <= d.bucket)::int
               AS eligible_voters
      FROM daily d
      ORDER BY d.bucket ASC;
    `,
  ]);

  const toCategoryRow = (r: CategoryRow): TurnoutDailyRow => ({
    bucket: r.bucket,
    category: r.category,
    voters: r.voters,
    votes: r.votes,
    totalWeight: r.total_weight,
    eligibleVoters: r.eligible_voters,
  });
  const toOverallRow = (r: OverallRow): TurnoutOverallRow => ({
    bucket: r.bucket,
    voters: r.voters,
    votes: r.votes,
    totalWeight: r.total_weight,
    eligibleVoters: r.eligible_voters,
  });

  return buildTurnoutAnalytics(
    categoryRows.map(toCategoryRow),
    overallRows.map(toOverallRow),
  );
}
