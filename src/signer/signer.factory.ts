import { KMSClient } from '@aws-sdk/client-kms';
import { ISigner } from './signer.interface';
import { KmsSignerService } from './kms-signer.service';
import { LocalSignerService } from './local-signer.service';

export interface SignerConfig {
  backend: 'kms' | 'local';
  kmsKeyId?: string | undefined;
  kmsRegion?: string | undefined;
  stellarPublicKey?: string | undefined;
  localSecret?: string | undefined;
}

/**
 * ConfigurationError — thrown when signer configuration is invalid or missing.
 */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

/**
 * createSigner — Factory function to instantiate the correct ISigner implementation.
 * 
 * Reads the backend type and returns either KmsSignerService or LocalSignerService.
 * "kms"   → KmsSignerService (production)
 * "local" → LocalSignerService (development/test only)
 * 
 * @param config - The signer configuration object
 * @returns An instance of ISigner
 * @throws ConfigurationError if required fields are missing for the selected backend
 */
export function createSigner(config: SignerConfig): ISigner {
  if (config.backend === 'kms') {
    if (!config.kmsKeyId) {
      throw new ConfigurationError('kmsKeyId is required when SIGNER_BACKEND=kms');
    }
    if (!config.stellarPublicKey) {
      throw new ConfigurationError('stellarPublicKey is required when SIGNER_BACKEND=kms');
    }

    const kmsClient = new KMSClient({ region: config.kmsRegion || 'us-east-1' });
    
    return new KmsSignerService(
      config.kmsKeyId,
      config.stellarPublicKey,
      kmsClient
    );
  }

  if (config.backend === 'local') {
    if (!config.localSecret) {
      throw new ConfigurationError('localSecret is required when SIGNER_BACKEND=local');
    }
    
    if (process.env.NODE_ENV === 'production') {
      throw new ConfigurationError('LocalSignerService is NOT allowed in production');
    }

    return new LocalSignerService(config.localSecret);
  }

  throw new ConfigurationError(`Unsupported SIGNER_BACKEND: ${config.backend}`);
}
