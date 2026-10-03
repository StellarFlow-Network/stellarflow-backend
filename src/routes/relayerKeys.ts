import { Router } from 'express';
import {
  generateRelayerKeys,
  getRelayerKeyInfo,
  rotateRelayerKeys,
  deleteRelayerKeys,
  validateRelayerKey,
  listAllRelayerKeys,
  getRotationStats,
  triggerDekRotation,
  getRelayerPublicKey,
} from '../controllers/relayerKeyController';
import { requireKeyManagement } from '../middleware/roleMatrixMiddleware';
import { requireWebAuthnAttestation } from '../middleware/webauthnAttestationMiddleware';

const router = Router();

/**
 * Relayer Key Management Routes (Admin Only)
 *
 * Issue #1063 – every key management operation is restricted to ADMIN
 * authenticated sessions and each permission evaluation is audited.
 *
 * WeBAuTHN / Passkey Authentication (Issue #1063):
 * - Administrative wallet transfers and other sensitive mutations must be
 *   accompanied by a valid WebAuthn attestation signature over a server-
 *   issued challenge. Challenge seeds and passkey credential public keys
 *   are persisted in PostgreSQL and verified by the WebAuthn middleware.
 */
router.use(requireKeyManagement);

// List all relayer keys
router.get('/relayers/keys', listAllRelayerKeys);

// Get dek rotation statistics
router.get('/relayers/keys/rotation-stats', getRotationStats);

// Trigger manual dek rotation
router.post('/relayers/keys/rotate-deks', requireWebAuthn: requireWebAuthnAttestation, triggerDekRotation);

// Get public key for a specific relayer
router.get('/relayers/:id/public-key', getRelayerPublicKey);

// Get key information for a specific relayer
router.get('/relayers/:id/keys', getRelayerKeyInfo);

// Generate new key pair for a relayer
router.post('/relayers/:id/keys', requireWebAuthnAttestation, generateRelayerKeys);

// Rotate key pair for a relayer
router.put('/relayers/:id/keys/rotate', requireWebAuthnAttestation, rotateRelayerKeys);

// Validate encrypted key for a relayer
router.post('/relayers/:id/keys/validate', requireWebAuthnAttestation, validateRelayerKey);

// Delete key pair for a relayer (requires confirmation and WebAuthn attestation)
router.delete('/relayers/:id/keys', requireWebAuthnAttestation, deleteRelayerKeys);

export default router;
