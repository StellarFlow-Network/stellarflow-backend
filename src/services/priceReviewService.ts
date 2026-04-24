import prisma from "../lib/prisma";
import type { MarketRate } from "./marketRate/types";
import { normalizeDateToUTC } from "../utils/timeUtils";
import {
  evaluatePriceMovement,
  PRICE_REVIEW_WINDOW_MS,
} from "./priceProtection";
import { webhookService } from "./webhook";

export const REVIEWABLE_CURRENCIES = new Set(["NGN", "KES", "GHS"]);

type ReviewStatus = "AUTO_APPROVED" | "PENDING" | "APPROVED" | "REJECTED";
type ContractStatus = "NOT_SUBMITTED" | "SUBMITTED" | "SKIPPED";

type RawReviewRow = {
  id: number;
  currency: string;
  rate: number | string;
  source: string;
  fetched_at: Date;
  review_status: ReviewStatus;
  contract_status: ContractStatus;
  review_reason: string | null;
  review_notes: string | null;
  baseline_rate: number | string | null;
  baseline_timestamp: Date | null;
  change_percent: number | string | null;
  memo_id: string | null;
  stellar_tx_hash: string | null;
  reviewed_at: Date | null;
  reviewed_by: string | null;
  created_at: Date;
  updated_at: Date;
};

export interface PendingPriceReview {
  id: number;
  currency: string;
  rate: number;
  source: string;
  fetchedAt: Date;
  reviewStatus: ReviewStatus;
  contractStatus: ContractStatus;
  reason: string | null;
  notes: string | null;
  baselineRate: number | null;
  baselineTimestamp: Date | null;
  changePercent: number | null;
  memoId: string | null;
  stellarTxHash: string | null;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PriceAssessment {
  reviewRecordId: number;
  manualReviewRequired: boolean;
  reason?: string | undefined;
  changePercent?: number | undefined;
  comparisonRate?: number | undefined;
  comparisonTimestamp?: Date | undefined;
}

function toNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapReviewRow(row: RawReviewRow): PendingPriceReview {
  return {
    id: row.id,
    currency: row.currency,
    rate: toNumber(row.rate) ?? 0,
    source: row.source,
    fetchedAt: new Date(row.fetched_at),
    reviewStatus: row.review_status,
    contractStatus: row.contract_status,
    reason: row.review_reason,
    notes: row.review_notes,
    baselineRate: toNumber(row.baseline_rate),
    baselineTimestamp: row.baseline_timestamp
      ? new Date(row.baseline_timestamp)
      : null,
    changePercent: toNumber(row.change_percent),
    memoId: row.memo_id,
    stellarTxHash: row.stellar_tx_hash,
    reviewedAt: row.reviewed_at ? new Date(row.reviewed_at) : null,
    reviewedBy: row.reviewed_by,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export class PriceReviewService {
  private schemaReadyPromise: Promise<void> | null = null;

  private ensureSchema(): Promise<void> {
    if (!this.schemaReadyPromise) {
      this.schemaReadyPromise = prisma
        .$executeRawUnsafe(
          `
          CREATE TABLE IF NOT EXISTS price_review_records (
            id SERIAL PRIMARY KEY,
            currency VARCHAR(10) NOT NULL,
            rate NUMERIC(20, 10) NOT NULL,
            source VARCHAR(100) NOT NULL,
            fetched_at TIMESTAMP(3) NOT NULL,
            review_status VARCHAR(20) NOT NULL DEFAULT 'AUTO_APPROVED',
            contract_status VARCHAR(20) NOT NULL DEFAULT 'NOT_SUBMITTED',
            review_reason TEXT NULL,
            review_notes TEXT NULL,
            baseline_rate NUMERIC(20, 10) NULL,
            baseline_timestamp TIMESTAMP(3) NULL,
            change_percent NUMERIC(10, 4) NULL,
            memo_id VARCHAR(28) NULL,
            stellar_tx_hash VARCHAR(128) NULL,
            reviewed_at TIMESTAMP(3) NULL,
            reviewed_by VARCHAR(100) NULL,
            created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
          );

          CREATE INDEX IF NOT EXISTS idx_price_review_currency_time
            ON price_review_records (currency, fetched_at DESC);

          CREATE INDEX IF NOT EXISTS idx_price_review_pending
            ON price_review_records (review_status, created_at DESC);

          CREATE INDEX IF NOT EXISTS idx_price_review_contract_status
            ON price_review_records (currency, contract_status, fetched_at DESC);
        `,
        )
        .then(() => undefined);
    }

    return this.schemaReadyPromise || Promise.resolve();
  }

  async assessRate(rate: MarketRate): Promise<PriceAssessment> {
    await this.ensureSchema();

    const normalizedRate = {
      ...rate,
      timestamp: normalizeDateToUTC(rate.timestamp),
      ...(rate.comparisonTimestamp && {
        comparisonTimestamp: normalizeDateToUTC(rate.comparisonTimestamp),
      }),
    };

    const currency = normalizedRate.currency.toUpperCase();
    const reviewable = REVIEWABLE_CURRENCIES.has(currency);
    const baseline = reviewable
      ? await this.getLatestSubmittedBaseline(
          currency,
          normalizedRate.timestamp,
        )
      : null;

    let reviewStatus: ReviewStatus = "AUTO_APPROVED";
    let contractStatus: ContractStatus = "NOT_SUBMITTED";
    let reason: string | undefined;
    let changePercent: number | undefined;
    let comparisonRate: number | undefined;
    let comparisonTimestamp: Date | undefined;

    if (reviewable && baseline) {
      const evaluation = evaluatePriceMovement({
        currentRate: normalizedRate.rate,
        baselineRate: baseline.rate,
        currency,
      });

      if (evaluation.isAnomalous) {
        reviewStatus = "PENDING";
        contractStatus = "SKIPPED";
        reason = evaluation.reason;
        changePercent = evaluation.changePercent;
        comparisonRate = baseline.rate;
        comparisonTimestamp = baseline.fetchedAt;
      }
    }

    const insertedRows = await prisma.$queryRaw<RawReviewRow[]>`
      INSERT INTO price_review_records (
        currency,
        rate,
        source,
        fetched_at,
        review_status,
        contract_status,
        review_reason,
        baseline_rate,
        baseline_timestamp,
        change_percent
      )
      VALUES (
        ${currency},
        ${normalizedRate.rate},
        ${normalizedRate.source},
        ${normalizedRate.timestamp},
        ${reviewStatus},
        ${contractStatus},
        ${reason ?? null},
        ${comparisonRate ?? null},
        ${comparisonTimestamp ?? null},
        ${changePercent ?? null}
      )
      RETURNING *;
    `;

    const inserted = insertedRows[0];
    if (!inserted) {
      throw new Error(`Failed to create price review record for ${currency}`);
    }

    if (reviewStatus === "PENDING" && reason) {
      await webhookService.sendManualReviewNotification({
        reviewId: inserted.id,
        currency,
        rate: normalizedRate.rate,
        previousRate: comparisonRate ?? 0,
        changePercent: changePercent ?? 0,
        source: normalizedRate.source,
        timestamp: normalizedRate.timestamp,
        reason: reason,
      });
    }

    return {
      reviewRecordId: inserted.id,
      manualReviewRequired: reviewStatus === "PENDING",
      ...(reason !== undefined && { reason }),
      ...(changePercent !== undefined && { changePercent }),
      ...(comparisonRate !== undefined && { comparisonRate }),
      ...(comparisonTimestamp !== undefined && { comparisonTimestamp }),
    };
  }

  async markContractSubmitted(
    reviewRecordId: number,
    memoId: string,
    stellarTxHash: string,
  ): Promise<void> {
    await this.ensureSchema();

    await prisma.$executeRaw`
      UPDATE price_review_records
SET
contract_status = 'SUBMITTED',
  memo_id = ${memoId},
stellar_tx_hash = ${stellarTxHash},
updated_at = CURRENT_TIMESTAMP
      WHERE id = ${reviewRecordId}
`;
  }

  async getPendingReviews(): Promise<PendingPriceReview[]> {
    await this.ensureSchema();

    const rows = await prisma.$queryRaw<RawReviewRow[]>`
SELECT *
  FROM price_review_records
      WHERE review_status = 'PENDING'
      ORDER BY created_at DESC
  `;

    return rows.map(mapReviewRow);
  }

  async getPendingReviewById(
    reviewId: number,
  ): Promise<PendingPriceReview | null> {
    await this.ensureSchema();

    const rows = await prisma.$queryRaw<RawReviewRow[]>`
SELECT *
  FROM price_review_records
      WHERE id = ${reviewId}
        AND review_status = 'PENDING'
      LIMIT 1
  `;

    return rows[0] ? mapReviewRow(rows[0]) : null;
  }

  async approveReview(params: {
    reviewId: number;
    reviewedBy?: string;
    reviewNotes?: string;
    memoId: string;
    stellarTxHash: string;
  }): Promise<PendingPriceReview> {
    await this.ensureSchema();

    const rows = await prisma.$queryRaw<RawReviewRow[]>`
      UPDATE price_review_records
SET
review_status = 'APPROVED',
  contract_status = 'SUBMITTED',
  review_notes = ${params.reviewNotes ?? null},
reviewed_by = ${params.reviewedBy ?? "manual-review"},
reviewed_at = CURRENT_TIMESTAMP,
  memo_id = ${params.memoId},
stellar_tx_hash = ${params.stellarTxHash},
updated_at = CURRENT_TIMESTAMP
      WHERE id = ${params.reviewId}
        AND review_status = 'PENDING'
RETURNING *
  `;

    const row = rows[0];
    if (!row) {
      throw new Error(`Pending review ${params.reviewId} was not found`);
    }

    return mapReviewRow(row);
  }

  async rejectReview(params: {
    reviewId: number;
    reviewedBy?: string;
    reviewNotes?: string;
  }): Promise<PendingPriceReview> {
    await this.ensureSchema();

    const rows = await prisma.$queryRaw<RawReviewRow[]>`
      UPDATE price_review_records
SET
review_status = 'REJECTED',
  contract_status = 'SKIPPED',
  review_notes = ${params.reviewNotes ?? null},
reviewed_by = ${params.reviewedBy ?? "manual-review"},
reviewed_at = CURRENT_TIMESTAMP,
  updated_at = CURRENT_TIMESTAMP
      WHERE id = ${params.reviewId}
        AND review_status = 'PENDING'
RETURNING *
  `;

    const row = rows[0];
    if (!row) {
      throw new Error(`Pending review ${params.reviewId} was not found`);
    }

    return mapReviewRow(row);
  }

  private async getLatestSubmittedBaseline(
    currency: string,
    timestamp: Date,
  ): Promise<{ rate: number; fetchedAt: Date } | null> {
    const windowStart = new Date(timestamp.getTime() - PRICE_REVIEW_WINDOW_MS);
    const rows = await prisma.$queryRaw<RawReviewRow[]>`
SELECT *
  FROM price_review_records
      WHERE currency = ${currency}
        AND contract_status = 'SUBMITTED'
        AND fetched_at >= ${windowStart}
        AND fetched_at < ${timestamp}
      ORDER BY fetched_at DESC
      LIMIT 1
  `;

    const row = rows[0];
    if (!row) {
      return null;
    }

    const rate = toNumber(row.rate);
    if (rate === null || rate <= 0) {
      return null;
    }

    return {
      rate,
      fetchedAt: new Date(row.fetched_at),
    };
  }
}

export const priceReviewService = new PriceReviewService();
