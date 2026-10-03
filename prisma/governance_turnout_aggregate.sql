-- Issue #1064 — Governance voting turnout: TimescaleDB continuous aggregate.
--
-- Provides the `governance_turnout_daily` relation read by
-- GET /api/v1/governance/analytics/turnout.
--
-- Apply AFTER the Prisma tables ("GovernanceVote", "GovernanceProposal") exist:
--
--     npm run db:governance-turnout
--
-- The script is idempotent and safe to re-run.
--
-- One row per (day, proposal category, voting account):
--
--     bucket       timestamptz   start of the UTC day
--     category     text          GovernanceProposal.actionType ('uncategorized' if unset)
--     account_id   text          voter
--     vote_count   bigint        votes the account cast that day in that category
--     total_weight numeric       sum of the voting weight of those votes
--
-- Keeping the voter in the grain (instead of a COUNT(DISTINCT ...), which
-- continuous aggregates do not support) lets the API derive exact distinct-voter
-- counts and the cumulative eligible-voter base with plain SQL.
--
-- Behaviour by environment:
--   * TimescaleDB available -> hypertable `governance_vote_fact` (kept in sync
--     from "GovernanceVote" by a trigger) + continuous aggregate with an hourly
--     refresh policy.
--   * Plain PostgreSQL      -> a regular view with identical columns, so the
--     endpoint works (unaccelerated) in development and CI.

DO $governance_turnout$
DECLARE
  has_timescale boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb')
    INTO has_timescale;

  IF NOT has_timescale THEN
    -- Views can't be replaced with a different column list, so drop first when
    -- this script previously created the fallback view.
    IF EXISTS (SELECT 1 FROM pg_views WHERE schemaname = current_schema() AND viewname = 'governance_turnout_daily') THEN
      EXECUTE 'DROP VIEW governance_turnout_daily';
    END IF;

    EXECUTE $view$
      CREATE VIEW governance_turnout_daily AS
      SELECT
        -- "votedAt" is a UTC wall-clock timestamp: truncate it, then tag it as UTC
        -- so the column is timestamptz, matching the continuous aggregate.
        date_trunc('day', v."votedAt") AT TIME ZONE 'UTC' AS bucket,
        COALESCE(p."actionType", 'uncategorized')         AS category,
        v."accountId"                                     AS account_id,
        COUNT(*)                                          AS vote_count,
        SUM(v."weight")                                   AS total_weight
      FROM "GovernanceVote" v
      LEFT JOIN "GovernanceProposal" p ON p."proposalId" = v."proposalId"
      GROUP BY 1, 2, 3
    $view$;
    RAISE NOTICE 'timescaledb not available: created plain view governance_turnout_daily';
    RETURN;
  END IF;

  CREATE EXTENSION IF NOT EXISTS timescaledb;

  -- 1. Time-series fact table. "GovernanceVote" cannot itself be a hypertable
  --    (its primary key does not include the time column), so votes are mirrored
  --    here with a (time, id) key.
  EXECUTE $tbl$
    CREATE TABLE IF NOT EXISTS governance_vote_fact (
      voted_at   timestamptz    NOT NULL,
      vote_id    integer        NOT NULL,
      account_id text           NOT NULL,
      proposal_id text          NOT NULL,
      category   text           NOT NULL,
      choice     text           NOT NULL,
      weight     numeric(38,18) NOT NULL,
      PRIMARY KEY (voted_at, vote_id)
    )
  $tbl$;

  PERFORM create_hypertable(
    'governance_vote_fact', 'voted_at',
    chunk_time_interval => INTERVAL '30 days',
    if_not_exists       => TRUE,
    migrate_data        => TRUE
  );

  -- 2. Keep the fact table in sync with "GovernanceVote".
  EXECUTE $fn$
    CREATE OR REPLACE FUNCTION governance_vote_fact_sync() RETURNS trigger AS $body$
    BEGIN
      IF TG_OP IN ('UPDATE', 'DELETE') THEN
        DELETE FROM governance_vote_fact
         WHERE vote_id = OLD."id"
           AND voted_at = (OLD."votedAt" AT TIME ZONE 'UTC');
      END IF;

      IF TG_OP IN ('INSERT', 'UPDATE') THEN
        INSERT INTO governance_vote_fact
          (voted_at, vote_id, account_id, proposal_id, category, choice, weight)
        VALUES (
          NEW."votedAt" AT TIME ZONE 'UTC',
          NEW."id",
          NEW."accountId",
          NEW."proposalId",
          COALESCE(
            (SELECT p."actionType" FROM "GovernanceProposal" p
              WHERE p."proposalId" = NEW."proposalId"),
            'uncategorized'
          ),
          NEW."choice",
          NEW."weight"
        )
        ON CONFLICT (voted_at, vote_id) DO UPDATE
          SET account_id = EXCLUDED.account_id,
              proposal_id = EXCLUDED.proposal_id,
              category = EXCLUDED.category,
              choice = EXCLUDED.choice,
              weight = EXCLUDED.weight;
      END IF;

      RETURN NULL;
    END;
    $body$ LANGUAGE plpgsql
  $fn$;

  EXECUTE 'DROP TRIGGER IF EXISTS governance_vote_fact_sync ON "GovernanceVote"';
  EXECUTE $trg$
    CREATE TRIGGER governance_vote_fact_sync
    AFTER INSERT OR UPDATE OR DELETE ON "GovernanceVote"
    FOR EACH ROW EXECUTE FUNCTION governance_vote_fact_sync()
  $trg$;

  -- 3. Backfill existing votes.
  EXECUTE $backfill$
    INSERT INTO governance_vote_fact
      (voted_at, vote_id, account_id, proposal_id, category, choice, weight)
    SELECT
      v."votedAt" AT TIME ZONE 'UTC',
      v."id",
      v."accountId",
      v."proposalId",
      COALESCE(p."actionType", 'uncategorized'),
      v."choice",
      v."weight"
    FROM "GovernanceVote" v
    LEFT JOIN "GovernanceProposal" p ON p."proposalId" = v."proposalId"
    ON CONFLICT (voted_at, vote_id) DO NOTHING
  $backfill$;

  -- 4. Continuous aggregate (WITH NO DATA so it can be created inside a
  --    transaction; the refresh policy below materialises history).
  IF NOT EXISTS (
    SELECT 1 FROM timescaledb_information.continuous_aggregates
     WHERE view_name = 'governance_turnout_daily'
  ) THEN
    -- A leftover plain view from a non-Timescale run would block the name.
    IF EXISTS (SELECT 1 FROM pg_views WHERE schemaname = current_schema() AND viewname = 'governance_turnout_daily') THEN
      EXECUTE 'DROP VIEW governance_turnout_daily';
    END IF;

    EXECUTE $cagg$
      CREATE MATERIALIZED VIEW governance_turnout_daily
      WITH (timescaledb.continuous) AS
      SELECT
        time_bucket(INTERVAL '1 day', voted_at) AS bucket,
        category,
        account_id,
        COUNT(*)    AS vote_count,
        SUM(weight) AS total_weight
      FROM governance_vote_fact
      GROUP BY 1, 2, 3
      WITH NO DATA
    $cagg$;
  END IF;

  -- Include not-yet-materialised buckets so today's turnout is visible.
  EXECUTE 'ALTER MATERIALIZED VIEW governance_turnout_daily SET (timescaledb.materialized_only = false)';

  -- 5. Refresh policy: start_offset NULL materialises all history on the first
  --    run; afterwards only invalidated buckets are recomputed.
  PERFORM add_continuous_aggregate_policy(
    'governance_turnout_daily',
    start_offset      => NULL,
    end_offset        => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour',
    if_not_exists     => TRUE
  );

  RAISE NOTICE 'governance_turnout_daily continuous aggregate is in place';
END
$governance_turnout$;
