import { Request, Response } from 'express';
import { sendApiError } from '../lib/apiError.js';
import { getRelayerKeyService, RelayerKeyError } from '../services/relayerKeyService';
import { getDekRotationService } from '../services/dekRotationService';
import { triggerManualRotation } from '../jobs/dekRotationJob';
import { logger } from '../utils/logger';
import { getWebAuthnService, WebAuthnError } from '../services/webAuthnService';

export interface WebAuthnAttestation {
  id: string;
  rawId: string;
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string;
  };
  getClientExtensionResults?: () => Promise<Map<string, unknown>;
}

export interface WebAuthnAssertionExpected {
  challenge: string;
  origin: string;
  rpId?: string;
  allowCredentials?: { id: string; type: 'public-key'; }[];
}

export interface WebAuthnRegistrationExpected {
  challenge: string;
  origin: string;
  rpId?: string;
  rpName?: string;
  userVerificationRequirement?: 'required' | 'preferred' | 'discouraged';
  authenticatorSelectionAttachment?: 'platform' | 'cross-platform';
}

/**
 * Admin API Controller for Relayer Key Management
 *
 * Endpoints:
 * - POST   /admin/relayers/:id/keys         - Generate new key pair
 * - GET    /admin/relayers/:id/keys         - Get key information
 * - PUT    /admin/relayers/:id/keys/rotate  - Rotate key pair
 * - DELETE /admin/relayers/:id/keys         - Delete key pair
 * - POST   /admin/relayers/:id/keys/validate - Validate encrypted key
 * - GET    /admin/relayers/keys             - List all relayer keys
 * - GET    /admin/relayers/keys/rotation-stats - Get DEK rotation statistics
 * - POST   /admin/relayers/keys/rotate-deks - Trigger manual dek rotation
 * - POST   /admin/relayers/webauthn/register/challenge - Generate WebAuthn registration challenge
 * - POST   /admin/relayers/webauthn/register/verify   - Verify WebAuthn registration
 * - POST   /admin/relayers/webauthn/authenticate/challenge - Generate WebAuthn authentication challenge
 * - POST   /admin/relayers/webauthn/authenticate/verify   - Verify WebAuthn authentication
 */

/**
 * POST /admin/relayers/:id/keys
 * Generate and store a new Ed25519 key pair for a relayer
 */
export const generateRelayerKeys = async (req: Request, res: Response): Promise<void> => {
  try {
    const relayerId = parseInt(req.params.id);
    const { force } = req.query;

    if (isNaN(relayerId)) {
      sendApiError(res, 400, 'INVALID_RELAYER_ID', 'Relayer ID must be a number');
      return;
    }

    logger.info(`[RelayerKeyController] Generating keys for relayer ${relayerId} (force=${force})`);

    const keyService = getRelayerKeyService();
    const keyInfo = await keyService.generateAndStoreKeyPair(relayerId, {
      force: force === 'true',
    });

    res.status(201).json({
      success: true,
      message: 'Key pair generated and stored successfully',
      data: {
        relayerId: keyInfo.relayerId,
        relayerName: keyInfo.relayerName,
        publicKey: keyInfo.publicKey,
        dekVersion: keyInfo.dekVersion,
        keyGeneratedAt: keyInfo.keyGeneratedAt,
        dekRotationScheduledAt: keyInfo.dekRotationScheduledAt,
      },
    });
  } catch (error: any) {
    logger.error('[RelayerKeyController] Failed to generate keys:', error);

    if (error instanceof RelayerKeyError) {
      if (error.code === 'RELAYER_NOT_FOUND') {
        sendApiError(res, 404, 'RELAYER_NOT_FOUND', error.message);
      } else if (error.code === 'KEY_ALREADY_EXISTS') {
        sendApiError(res, 409, 'KEY_ALREADY_EXISTS', error.message);
      } else {
        sendApiError(res, 500, error.code, error.message);
      }
    } else {
      sendApiError(res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to generate key pair');
    }
  }
};

/**
 * GET /admin/relayers/:id/keys
 * Get key information for a relayer (without exposing private key)
 */
export const getRelayerKeyInfo = async (req: Request, res: Response): Promise<void> => {
  try {
    const relayerId = parseInt(req.params.id);

    if (isNaN(relayerId)) {
      sendApiError(res, 400, 'INVALID_RELAYER_ID', 'Relayer ID must be a number');
      return;
    }

    const keyService = getRelayerKeyService();
    const keyInfo = await keyService.getKeyInfo(relayerId);

    if (!keyInfo) {
      sendApiError(res, 404, 'RELAYUR_NOT_FOUND', `Relayer ${relayerId} not found`);
      return;
    }

    res.json({
      success: true,
      data: {
        relayerId: keyInfo.relayerId,
        relayerName: keyInfo.relayerName,
        publicKey: keyInfo.publicKey,
        hasPrivateKey: keyInfo.hasPrivateKey,
        dekVersion: keyInfo.dekVersion,
        keyGeneratedAt: keyInfo.keyGeneratedAt,
        dekEncryptedAt: keyInfo.dekEncryptedAt,
        dekRotationScheduledAt: keyInfo.dekRotationScheduledAt,
      },
    });
  } catch (error: any) {
    logger.error('[RelayerKeyController] Failed to get key info:', error);
    sendApiError(res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to retrieve key information');
  }
};

/**
 * PUT /admin/relayers/:id/keys/rotate
 * Rotate a relayer's key pair (generates new keys)
 */
export const rotateRelayerKeys = async (req: Request, res: Response): Promise<void> => {
  try {
    const relayerId = parseInt(req.params.id);

    if (isNaN(relayerId)) {
      sendApiError(res, 400, 'INVALID_RELAYER_ID', 'Relayer ID must be a number');
      return;
    }

    const attestation = req.body?.webAuthn?.attestation as WebAuthnAttestation | undefined;
    if (!attestation) {
      sendApiError(res, 400, 'WEBAUTHN_ATTESTATION_REQUIRED', 'WebAuthn attestation is required for key rotation');
      return;
    }

    const webAuthnService = getWebAuthnService();
    const verified = await webAuthnService.verifyAttestation(attestation, {
      challenge: req.body?.webAuthn?.challenge,
      origin: req.body?.webAuthn?.origin,
      rpId: req.body?.webAuthn?.rpId,
    });

    if (!verified) {
      sendApiError(res, 401, 'WEBAUTHN_VERIFICATION_FAILED', 'WebAuthn attestation verification failed');
      return;
    }

    logger.warn(`[RelayerKeyController] Rotating key pair for relayer ${relayerId}`);

    const keyService = getRelayerKeyService();
    const keyInfo = await keyService.rotateKeyPair(relayerId);

    res.json({
      success: true,
      message: 'Key pair rotated successfully',
      data: {
        relayerId: keyInfo.relayerId,
        relayerName: keyInfo.relayerName,
        publicKey: keyInfo.publicKey,
        dekVersion: keyInfo.dekVersion,
        keyGeneratedAt: keyInfo.keyGeneratedAt,
        dekRotationScheduledAt: keyInfo.dekRotationScheduledAt,
      },
    });
  } catch (error: any) {
    logger.error('[RelayerKeyController] Failed to rotate keys:', error);

    if (error instanceof RelayerKeyError) {
      if (error.code === 'RELAYUR_NOT_FOUND') {
        sendApiError(res, 404, 'RELAYUR_NOT_FOUND', error.message);
      } else {
        sendApiError(res, 500, error.code, error.message);
      }
    } else if (error instanceof WebAuthnError) {
      sendApiError(res, 401, error.code, error.message);
    } else {
      sendApiError(res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to rotate key pair');
    }
  }
};

/**
 * DELETE /admin/relayers/:id/keys
 * Delete a relayer's key pair (irreversible)
 */
export const deleteRelayerKeys = async (req: Request, res: Response): Promise<void> => {
  try {
    const relayerId = parseInt(req.params.id);
    const { confirm } = req.query;

    if (isNaN(relayerId)) {
      sendApiError(res, 400, 'INVALID_RELAYER_ID', 'Relayer ID must be a number');
      return;
    }

    if (confirm !== 'true') {
      sendApiError(
        res,
        400,
        'CONFIRMATION_REQUIRED',
        'Add ?confirm=true to confirm key deletion',
      );
      return;
    }

    const attestation = req.body?.webAuthn?.attestation as WebAuthnAttestation | undefined;
    if (!attestation) {
      sendApiError(res, 400, 'WEBAUTHN_ATTESTATION_REQUIRED', 'WebAuthn attestation is required for key deletion');
      return;
    }

    const webAuthnService = getWebAuthnService();
    const verified = await webAuthnService.verifyAttestation(attestation, {
      challenge: req.body?.webAuthn?.challenge,
      origin: req.body?.webAuthn?.origin,
      rpId: req.body?.webAuthn?.rpId,
    });

    if (!verified) {
      sendApiError(res, 401, 'WEBAUTHN_VERIFICATION_FAILED', 'WebAuthn attestation verification failed');
      return;
    }

    logger.warn(`[RelayerKeyController] Deleting key pair for relayer ${relayerId}`);

    const keyService = getRelayerKeyService();
    await keyService.deleteKeyPair(relayerId);

    res.json({
      success: true,
      message: 'Key pair deleted successfully',
    });
  } catch (error: any) {
    logger.error('[RelayerKeyController] Failed to delete keys:', error);

    if (error instanceof RelayerKeyError) {
      if (error.code === 'RELAYER_NOT_FOUND') {
        sendApiError(res, 404, 'RELAYER_NOT_FOUND', error.message);
      } else {
        sendApiError(res, 500, error.code, error.message);
      }
    } else if (error instanceof WebAuthnError) {
      sendApiError(res, 401, error.code, error.message);
    } else {
      sendApiError(res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to delete key pair');
    }
  }
};

/**
 * POST /admin/relayers/:id/keys/validate
 * Validate that encrypted key can be decrypted successfully
 */
export const validateRelayerKey = async (req: Request, res: Response): Promise<void> => {
  try {
    const relayerId = parseInt(req.params.id);

    if (isNaN(relayerId)) {
      sendApiError(res, 400, 'INVALID_RELAYUR_ID', 'Relayer ID must be a number');
      return;
    }

    logger.info(`[RelayerKeyController] Validating encrypted key for relayer ${relayerId}`);

    const keyService = getRelayerKeyService();
    const isValid = await keyService.validateEncryptedKey(relayerId);

    res.json({
      success: true,
      message: 'Key validation successful',
      data: {
        relayerId,
        isValid,
      },
    });
  } catch (error: any) {
    logger.error('[RelayerKeyController] Key validation failed:', error);

    if (error instanceof RelayerKeyError) {
      if (error.code === 'RELAYER_NOT_FOUND') {
        sendApiError(res, 404, 'RELAYER_NOT_FOUND', error.message);
      } else if (error.code === 'NO_PRIVATE_KEY') {
        sendApiError(res, 404, 'NO_PRIVATE_KEY', error.message);
      } else {
        sendApiError(res, 500, 'VALIDATION_FAILED', error.message);
      }
    } else {
      sendApiError(res, 500, 'VALIDATION_FAILED', 'Key validation failed');
    }
  }
};

/**
 * GET /admin/relayers/keys
 * List all relayers with their key information
 */
export const listAllRelayerKeys = async (req: Request, res: Response): Promise<void> => {
  try {
    const keyService = getRelayerKeyService();
    const keys = await keyService.listAllKeys();

    res.json({
      success: true,
      data: {
        total: keys.length,
        relayers: keys.map((key) => ({
          relayerId: key.relayerId,
          relayerName: key.relayerName,
          publicKey: key.publicKey,
          hasPrivateKey: key.hasPrivateKey,
          dekVersion: key.dekVersion,
          keyGeneratedAt: key.keyGeneratedAt,
          dekEncryptedAt: key.dekEncryptedAt,
          dekRotationScheduledAt: key.dekRotationScheduledAt,
        })),
      },
    });
  } catch (error: any) {
    logger.error('[RelayerKeyController] Failed to list keys:', error);
    sendApiError(res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to list relayer keys');
  }
};

/**
 * GET /admin/relayers/keys/rotation-stats
 * Get dek rotation statistics for monitoring
 */
export const getRotationStats = async (req: Request, res: Response): Promise<void> => {
  try {
    const rotationService = getDekRotationService();
    const stats = await rotationService.getRotationStats();

    // Find severely overdue relayers
    const severelyOverdue = await rotationService.findSeverelyOverdueRelayers(24);

    res.json({
      success: true,
      data: {
        totalWithKeys: stats.totalWithKeys,
        overdueCount: stats.overdueCount,
        upcomingCount: stats.upcomingCount,
        neverRotatedCount: stats.neverRotatedCount,
        severelyOverdue: severelyOverdue.map((r) => ({
          id: r.id,
          name: r.name,
          dekVersion: r.dekVersion,
          dekEncryptedAt: r.dekEncryptedAt,
          dekRotationScheduledAt: r.dekRotationScheduledAt,
        })),
      },
    });
  } catch (error: any) {
    logger.error('[RelayerKeyController] Failed to get rotation stats:', error);
    sendApiError(res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to retrieve rotation statistics');
  }
};

/**
 * POST /admin/relayers/keys/rotate-deks
 * Manually trigger dek rotation for all overdue relayers
 */
export const triggerDekRotation = async (req: Request, res: Response): Promise<void> => {
  try {
    const { dryRun, maxRelayers } = req.query;

    const attestation = req.body?.webAuthn?.attestation as WebAuthnAttestation | undefined;
    if (!attestation) {
      sendApiError(res, 400, 'WEBAUTHN_ATTESTATION_REQUIRED', 'WebAuthn attestation is required for manual DEK rotation');
      return;
    }

    const webAuthnService = getWebAuthnService();
    const verified = await webAuthnService.verifyAttestation(attestation, {
      challenge: req.body?.webAuthn?.challenge,
      origin: req.body?.webAuthn?.origin,
      rpId: req.body?.webAuthn?.rpId,
    });

    if (!verified) {
      sendApiError(res, 401, 'WEBAUTHN_VERIFICATION_FAILED', 'WebAuthn attestation verification failed');
      return;
    }

    logger.info(
      `[RelayerKeyController] Manual DEK rotation triggered (dryRun=${dryRun}, maxRelayers=${maxRelayers})`,
    );

    const rotationService = getDekRotationService();
    const summary = await rotationService.rotateAllOverdueDeks({
      dryRun: dryRun === 'true',
      maxRelayers: maxRelayers ? parseInt(maxRelayers as string) : undefined,
    });

    res.json({
      success: true,
      message:
        summary.totalRelayers === 0
          ? 'No relayers need DEK rotation'
          : `DEK rotation completed: ${summary.rotatedCount}/${summary.totalRelayers} succeeded`,
      data: {
        totalRelayers: summary.totalRelayers,
        rotatedCount: summary.rotatedCount,
        failedCount: summary.failedCount,
        skippedCount: summary.skippedCount,
        durationMs: summary.durationMs,
        startedAt: summary.startedAt,
        completedAt: summary.completedAt,
        results: summary.results,
      },
    });
  } catch (error: any) {
    logger.error('[RelayerKeyController] Failed to trigger DEK rotation:', error);
    if (error instanceof WebAuthnError) {
      sendApiError(res, 401, error.code, error.message);
    } else {
      sendApiError(res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to trigger DEK rotation');
    }
  }
};

/**
 * GET /admin/relayers/:id/public-key
 * Get public key for a relayer (convenience endpoint for signature verification)
 */
export const getRelayerPublicKey = async (req: Request, res: Response): Promise<void> => {
  try {
    const relayerId = parseInt(req.params.id);

    if (isNaN(relayerId)) {
      sendApiError(res, 400, 'INVALID_RELAYER_ID', 'Relayer ID must be a number');
      return;
    }

    const keyService = getRelayerKeyService();
    const keyInfo = await keyService.getKeyInfo(relayerId);

    if (!keyInfo) {
      sendApiError(res, 404, 'RELAYER_NOT_FOUND', `Relayer ${relayerId} not found`);
      return;
    }

    res.json({
      success: true,
      data: {
        relayerId: keyInfo.relayerId,
        publicKey: keyInfo.publicKey,
      },
    });
  } catch (error: any) {
    logger.error('[RelayerKeyController] Failed to get public key:', error);
    sendApiError(res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to retrieve public key');
  }
};

/**
 * POST /admin/relayers/webauthn/register/challenge
 * Generate a WebAuthn registration challenge and store it in PostgreSQL
 */
export const generateWebAuthnRegistrationChallenge = async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId, username, displayName } = req.body;
    if (!userId || typeof userId !== 'string') {
      sendApiError(res, 400, 'INVALID_USER_ID', 'userId is required');
      return;
    }

    const webAuthnService = getWebAuthnService();
    const options = await webAuthnService.generateRegistrationOptions({
      userId,
      username: username || userId,
      displayName: displayName || username || userId,
    });

    res.json({
      success: true,
      data: options,
    });
  } catch (error: any) {
    logger.error('[RelayerKeyController] Failed to generate WebAuthn registration challenge:', error);
    if (error instanceof WebAuthnError) {
      sendApiError(res, 400, error.code, error.message);
    } else {
      sendApiError(res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to generate WebAuthn registration challenge');
    }
  }
};

/**
 * POST /admin/relayers/webauthn/register/verify
 * Verify a WebAuthn registration response and store the credential public key in PostgreSQL
 */
export const verifyWebAuthnRegistration = async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId, attestation, challenge, origin, rpId } = req.body;
    if (!userId || typeof userId !== 'string') {
      sendApiError(res, 400, 'INVALID_USER_ID', 'userId is required');
      return;
    }
    if (!attestation) {
      sendApiError(res, 400, 'WEBAUTHN_ATTESTATION_REQUIRED', 'WebAuthn attestation is required');
      return;
    }

    const webAuthnService = getWebAuthnService();
    const result = await webAuthnService.verifyRegistration(userId, attestation as WebAuthnAttestation, {
      challenge,
      origin,
      rpId,
    });

    res.json({
      success: true,
      message: 'WebAuthn registration verified successfully',
      data: result,
    });
  } catch (error: any) {
    logger.error('[RelayerKeyController] Failed to verify WebAuthn registration:', error);
    if (error instanceof WebAuthnError) {
      sendApiError(res, 400, error.code, error.message);
    } else {
      sendApiError(res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to verify WebAuthn registration');
    }
  }
};

/**
 * POST /admin/relayers/webauthn/authenticate/challenge
 * Generate a WebAuthn authentication challenge and store it in PostgreSQL
 */
export const generateWebAuthnAuthenticationChallenge = async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId } = req.body;
    if (!userId || typeof userId !== 'string') {
      sendApiError(res, 400, 'INVALID_USER_ID', 'userId is required');
      return;
    }

    const webAuthnService = getWebAuthnService();
    const options = await webAuthnService.generateAuthenticationOptions(userId);

    res.json({
      success: true,
      data: options,
    });
  } catch (error: any) {
    logger.error('[RelayerKeyController] Failed to generate WebAuthn authentication challenge:', error);
    if (error instanceof WebAuthnError) {
      sendApiError(res, 400, error.code, error.message);
    } else {
      sendApiError(res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to generate WebAuthn authentication challenge');
    }
  }
};

/**
 * POST /admin/relayers/webauthn/authenticate/verify
 * Verify a WebAuthn authentication response and return a short-lived token
 */
export const verifyWebAuthnAuthentication = async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId, attestation, challenge, origin, rpId } = req.body;
    if (!userId || typeof userId !== 'string') {
      sendApiError(res, 400, 'INVALID_USER_ID', 'userId is required');
      return;
    }
    if (!attestation) {
      sendApiError(res, 400, 'WEBAUTHN_ATTESTATION_REQUIRED', 'WebAuthn attestation is required');
      return;
    }

    const webAuthnService = getWebAuthnService();
    const result = await webAuthnService.verifyAuthentication(userId, attestation as WebAuthnAttestation, {
      challenge,
      origin,
      rpId,
    });

    res.json({
      success: true,
      message: 'WebAuthn authentication verified successfully',
      data: result,
    });
  } catch (error: any) {
    logger.error('[RelayerKeyController] Failed to verify WebAuthn authentication:', error);
    if (error instanceof WebAuthnError) {
      sendApiError(res, 401, error.code, error.message);
    } else {
      sendApiError(res, 500, 'INTERNAL_SERVER_ERROR', 'Failed to verify WebAuthn authentication');
    }
  }
};
