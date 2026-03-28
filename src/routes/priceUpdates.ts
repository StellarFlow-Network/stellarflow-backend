import express, { Request, Response } from "express";
import { multiSigService, SignaturePayload } from "../services/multiSigService";

const router = express.Router();

/**
 * POST /api/v1/price-updates/multi-sig/request
 * Creates a multi-sig price update request.
 * Called by the initializing server to start the approval process.
 */
router.post("/multi-sig/request", async (req: Request, res: Response) => {
  try {
    const { priceReviewId, currency, rate, source, memoId } = req.body;

    if (!priceReviewId || !currency || rate === undefined || !source || !memoId) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: priceReviewId, currency, rate, source, memoId",
      });
    }

    const signatureRequest = await multiSigService.createMultiSigRequest(
      priceReviewId,
      currency,
      rate,
      source,
      memoId
    );

    res.json({
      success: true,
      data: signatureRequest,
    });
  } catch (error) {
    console.error("[API] Multi-sig request creation failed:", error);
    res.status(500).json({
      success: false,
      error: String(error),
    });
  }
});

/**
 * POST /api/v1/price-updates/sign
 * Endpoint for remote servers to request a signature.
 * This is called by peer servers in the multi-sig setup.
 * 
 * Requires:
 * - Authorization header with token (if MULTI_SIG_AUTH_TOKEN is set)
 * - Signature payload in body
 */
router.post("/sign", async (req: Request, res: Response) => {
  try {
    // Validate authorization if token is configured
    const authToken = process.env.MULTI_SIG_AUTH_TOKEN;
    if (authToken) {
      const authHeader = req.headers.authorization || "";
      const token = authHeader.startsWith("Bearer ")
        ? authHeader.slice(7)
        : authHeader;

      if (token !== authToken) {
        return res.status(403).json({
          success: false,
          error: "Unauthorized - invalid token",
        });
      }
    }

    const { multiSigPriceId } = req.body as SignaturePayload;

    if (!multiSigPriceId) {
      return res.status(400).json({
        success: false,
        error: "Missing multiSigPriceId",
      });
    }

    // Sign the price update locally
    const { signature, signerPublicKey } = await multiSigService.signMultiSigPrice(
      multiSigPriceId
    );

    const signerInfo = multiSigService.getLocalSignerInfo();

    res.json({
      success: true,
      data: {
        multiSigPriceId,
        signature,
        signerPublicKey,
        signerName: signerInfo.name,
      },
    });
  } catch (error) {
    console.error("[API] Signature creation failed:", error);
    res.status(400).json({
      success: false,
      error: String(error),
    });
  }
});

/**
 * POST /api/v1/price-updates/multi-sig/:multiSigPriceId/request-signature
 * Request a signature from a remote server.
 * The body should contain the remote server URL.
 */
router.post("/multi-sig/:multiSigPriceId/request-signature", async (req: Request, res: Response) => {
  try {
    const multiSigPriceId = req.params.multiSigPriceId;
    const { remoteServerUrl } = req.body;

    if (!multiSigPriceId || typeof multiSigPriceId !== "string" || !remoteServerUrl) {
      return res.status(400).json({
        success: false,
        error: "Missing multiSigPriceId (in URL) or remoteServerUrl (in body)",
      });
    }

    const result = await multiSigService.requestRemoteSignature(
      parseInt(multiSigPriceId, 10),
      remoteServerUrl
    );

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
      });
    }

    res.json({ success: true });
  } catch (error) {
    console.error("[API] Remote signature request failed:", error);
    res.status(500).json({
      success: false,
      error: String(error),
    });
  }
});

/**
 * GET /api/v1/price-updates/multi-sig/:multiSigPriceId/status
 * Get the status of a multi-sig price update.
 */
router.get("/multi-sig/:multiSigPriceId/status", async (req: Request, res: Response) => {
  try {
    const multiSigPriceId = req.params.multiSigPriceId;

    if (!multiSigPriceId || typeof multiSigPriceId !== "string") {
      return res.status(400).json({
        success: false,
        error: "Missing multiSigPriceId in URL",
      });
    }

    const multiSigPrice = await multiSigService.getMultiSigPrice(
      parseInt(multiSigPriceId, 10)
    );

    if (!multiSigPrice) {
      return res.status(404).json({
        success: false,
        error: `MultiSigPrice ${multiSigPriceId} not found`,
      });
    }

    res.json({
      success: true,
      data: {
        id: multiSigPrice.id,
        currency: multiSigPrice.currency,
        rate: multiSigPrice.rate,
        status: multiSigPrice.status,
        collectedSignatures: multiSigPrice.collectedSignatures,
        requiredSignatures: multiSigPrice.requiredSignatures,
        expiresAt: multiSigPrice.expiresAt,
        signers: multiSigPrice.multiSigSignatures?.map((sig: any) => ({
          publicKey: sig.signerPublicKey,
          name: sig.signerName,
          signedAt: sig.signedAt,
        })),
      },
    });
  } catch (error) {
    console.error("[API] Multi-sig status fetch failed:", error);
    res.status(500).json({
      success: false,
      error: String(error),
    });
  }
});

/**
 * GET /api/v1/price-updates/multi-sig/pending
 * Get all pending multi-sig price updates.
 * Useful for monitoring and coordination between servers.
 */
router.get("/multi-sig/pending", async (req: Request, res: Response) => {
  try {
    const pendingPrices = await multiSigService.getPendingMultiSigPrices();

    res.json({
      success: true,
      data: pendingPrices.map((price) => ({
        id: price.id,
        currency: price.currency,
        rate: price.rate,
        status: price.status,
        collectedSignatures: price.collectedSignatures,
        requiredSignatures: price.requiredSignatures,
        expiresAt: price.expiresAt,
        signerCount: price.multiSigSignatures?.length || 0,
      })),
    });
  } catch (error) {
    console.error("[API] Pending multi-sig fetch failed:", error);
    res.status(500).json({
      success: false,
      error: String(error),
    });
  }
});

/**
 * GET /api/v1/price-updates/multi-sig/:multiSigPriceId/signatures
 * Get all signatures for a multi-sig price update.
 * Only returns once all signatures are collected and approved.
 */
router.get("/multi-sig/:multiSigPriceId/signatures", async (req: Request, res: Response) => {
  try {
    const multiSigPriceId = req.params.multiSigPriceId;

    if (!multiSigPriceId || typeof multiSigPriceId !== "string") {
      return res.status(400).json({
        success: false,
        error: "Missing multiSigPriceId in URL",
      });
    }

    const multiSigPrice = await multiSigService.getMultiSigPrice(
      parseInt(multiSigPriceId, 10)
    );

    if (!multiSigPrice) {
      return res.status(404).json({
        success: false,
        error: `MultiSigPrice ${multiSigPriceId} not found`,
      });
    }

    if (multiSigPrice.status !== "APPROVED") {
      return res.status(400).json({
        success: false,
        error: `MultiSigPrice ${multiSigPriceId} is not approved yet (status: ${multiSigPrice.status})`,
      });
    }

    const signatures = await multiSigService.getSignatures(
      parseInt(multiSigPriceId, 10)
    );

    res.json({
      success: true,
      data: {
        multiSigPriceId: multiSigPrice.id,
        currency: multiSigPrice.currency,
        rate: multiSigPrice.rate,
        signatures: signatures.map((sig) => ({
          signerPublicKey: sig.signerPublicKey,
          signerName: sig.signerName,
          signature: sig.signature,
        })),
      },
    });
  } catch (error) {
    console.error("[API] Signature fetch failed:", error);
    res.status(500).json({
      success: false,
      error: String(error),
    });
  }
});

/**
 * POST /api/v1/price-updates/multi-sig/:multiSigPriceId/record-submission
 * Record that a multi-sig price has been submitted to Stellar.
 */
router.post("/multi-sig/:multiSigPriceId/record-submission", async (req: Request, res: Response) => {
  try {
    const multiSigPriceId = req.params.multiSigPriceId;
    const { memoId, stellarTxHash } = req.body;

    if (!multiSigPriceId || typeof multiSigPriceId !== "string" || !memoId || !stellarTxHash) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: multiSigPriceId (in URL), memoId, stellarTxHash (in body)",
      });
    }

    await multiSigService.recordSubmission(
      parseInt(multiSigPriceId, 10),
      memoId,
      stellarTxHash
    );

    res.json({ success: true });
  } catch (error) {
    console.error("[API] Submission recording failed:", error);
    res.status(500).json({
      success: false,
      error: String(error),
    });
  }
});

/**
 * GET /api/v1/price-updates/multi-sig/signer-info
 * Get this server's signer information.
 * Useful for remote servers to identify who is signing.
 */
router.get("/multi-sig/signer-info", async (req: Request, res: Response) => {
  try {
    const signerInfo = multiSigService.getLocalSignerInfo();
    res.json({
      success: true,
      data: signerInfo,
    });
  } catch (error) {
    console.error("[API] Signer info fetch failed:", error);
    res.status(500).json({
      success: false,
      error: String(error),
    });
  }
});

export default router;
