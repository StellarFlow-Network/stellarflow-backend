/**
 * Governance Proposal Controller
 *
 * Handles: GET /api/v1/governance/proposals/:proposal_id
 *
 * Returns the proposal's final voting tally, voter participation and – when
 * the export worker has published the immutable result snapshot to IPFS – the
 * content hash (CID) together with a verification link.
 *
 * @swagger
 * tags:
 *   - name: Governance
 *     description: Voter history and delegation management
 */

import { Request, Response } from "express";
import { sendApiError } from "../lib/apiError.js";
import { getProposalResultDetail } from "../services/governanceResultService.js";
import { ipfsClient } from "../services/ipfsClient.js";

const PROPOSAL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * GET /api/v1/governance/proposals/:proposal_id
 *
 * @swagger
 * /api/v1/governance/proposals/{proposal_id}:
 *   get:
 *     tags:
 *       - Governance
 *     summary: Governance proposal detail with result verification link
 *     description: >
 *       Returns a governance proposal with its final voting tally, the number
 *       of voters and, once the result snapshot has been exported to IPFS, the
 *       content hash (CID) and a public gateway verification link for the
 *       immutable snapshot document.
 *     parameters:
 *       - in: path
 *         name: proposal_id
 *         required: true
 *         schema:
 *           type: string
 *           maxLength: 128
 *         description: On-chain proposal identifier
 *     responses:
 *       '200':
 *         description: Proposal detail with optional IPFS verification link
 *       '400':
 *         description: Invalid proposal identifier
 *       '404':
 *         description: Proposal not found
 *       '500':
 *         description: Internal server error
 */
export async function getProposalResult(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const proposalId =
      typeof req.params.proposal_id === "string"
        ? req.params.proposal_id
        : undefined;

    if (!proposalId || !PROPOSAL_ID_RE.test(proposalId)) {
      sendApiError(
        res,
        400,
        "BAD_REQUEST",
        "proposal_id must be a 1-128 character identifier of letters, digits, '.', '_', ':' or '-'.",
      );
      return;
    }

    const detail = await getProposalResultDetail(proposalId);
    if (!detail) {
      sendApiError(
        res,
        404,
        "NOT_FOUND",
        `Governance proposal ${proposalId} was not found.`,
      );
      return;
    }

    res.json({
      success: true,
      data: {
        proposal: detail.proposal,
        tally: detail.tally,
        voterCount: detail.voterCount,
        verification: detail.resultExport
          ? {
              cid: detail.resultExport.cid,
              contentHash: detail.resultExport.contentHash,
              exportedAt: detail.resultExport.exportedAt,
              url: ipfsClient.gatewayUrl(detail.resultExport.cid),
            }
          : null,
      },
    });
  } catch (err) {
    console.error(
      "[GovernanceProposalController] getProposalResult error:",
      err,
    );
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      err instanceof Error ? err.message : undefined,
    );
  }
}
