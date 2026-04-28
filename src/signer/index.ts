import dotenv from 'dotenv';
import { createSigner, SignerConfig } from './signer.factory';
import { ISigner } from './signer.interface';

dotenv.config();

const config: SignerConfig = {
  backend: (process.env.SIGNER_BACKEND as 'kms' | 'local') || 'local',
  kmsKeyId: process.env.AWS_KMS_KEY_ID,
  kmsRegion: process.env.AWS_REGION,
  stellarPublicKey: process.env.STELLAR_PUBLIC_KEY,
  localSecret: process.env.STELLAR_SECRET || process.env.ORACLE_SECRET_KEY || process.env.SOROBAN_ADMIN_SECRET,
};

export const signer: ISigner = createSigner(config);
export * from './signer.interface';
export * from './kms-signer.service';
export * from './local-signer.service';
export * from './signer.factory';
