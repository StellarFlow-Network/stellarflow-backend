import fs from "fs";
import path from "path";
import crypto from "crypto";
import { logger } from "../utils/logger";

export interface ZkParamMetadata {
  circuitId: string;
  version: string;
  fileSize: number;
  checksumSha256: string;
  cdnUrl: string;
  provingKeyUrl: string;
  verifyingKeyUrl: string;
  updatedAt: string;
}

export interface ZkCdnConfig {
  s3Region?: string;
  s3Bucket?: string;
  cdnBaseUrl?: string;
  localStorageDir?: string;
}

export class ZkCdnManager {
  private bucket: string;
  private cdnBaseUrl: string;
  private storageDir: string;

  constructor(config?: ZkCdnConfig) {
    this.bucket = config?.s3Bucket || process.env.ZK_CDN_S3_BUCKET || process.env.S3_BUCKET || "stellarflow-zk-params";
    this.cdnBaseUrl = config?.cdnBaseUrl || process.env.ZK_CDN_BASE_URL || "https://cdn.stellarflow.network/zk/params";
    this.storageDir = config?.localStorageDir || process.env.ZK_STORAGE_DIR || path.join(process.cwd(), "data", "zk");

    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  async uploadCircuitKeys(
    circuitId: string,
    version: string,
    zkeyFilePath: string,
    vkeyFilePath?: string
  ): Promise<ZkParamMetadata> {
    if (!fs.existsSync(zkeyFilePath)) {
      throw new Error(`ZKey file not found at ${zkeyFilePath}`);
    }

    const fileBuffer = fs.readFileSync(zkeyFilePath);
    const fileSize = fileBuffer.length;
    const checksumSha256 = crypto.createHash("sha256").update(fileBuffer).digest("hex");

    const zkeyFilename = `${circuitId}-${version}.zkey`;
    this.saveLocally(zkeyFilename, fileBuffer);
    logger.info(`[ZkCdnManager] Uploaded/stored ${zkeyFilename} in CDN storage directory`);

    if (vkeyFilePath && fs.existsSync(vkeyFilePath)) {
      const vkeyBuffer = fs.readFileSync(vkeyFilePath);
      const vkeyFilename = `${circuitId}-${version}.vkey.json`;
      this.saveLocally(vkeyFilename, vkeyBuffer);
    }

    const cdnUrl = `${this.cdnBaseUrl}/${version}/${zkeyFilename}`;
    const verifyingKeyUrl = `${this.cdnBaseUrl}/${version}/${circuitId}-${version}.vkey.json`;

    return {
      circuitId,
      version,
      fileSize,
      checksumSha256,
      cdnUrl,
      provingKeyUrl: cdnUrl,
      verifyingKeyUrl,
      updatedAt: new Date().toISOString(),
    };
  }

  private saveLocally(filename: string, buffer: Buffer): void {
    const targetPath = path.join(this.storageDir, filename);
    fs.writeFileSync(targetPath, buffer);
    logger.info(`[ZkCdnManager] Saved key file locally at ${targetPath}`);
  }

  getOptimalParamUrls(circuitId: string, versionTag?: string): ZkParamMetadata {
    const version = versionTag || process.env.STABLE_SMART_CONTRACT_VERSION || "v1.0.0";
    const zkeyFilename = `${circuitId}-${version}.zkey`;
    const cdnUrl = `${this.cdnBaseUrl}/${version}/${zkeyFilename}`;
    const verifyingKeyUrl = `${this.cdnBaseUrl}/${version}/${circuitId}-${version}.vkey.json`;

    return {
      circuitId,
      version,
      fileSize: 0,
      checksumSha256: "",
      cdnUrl,
      provingKeyUrl: cdnUrl,
      verifyingKeyUrl,
      updatedAt: new Date().toISOString(),
    };
  }
}

export const zkCdnManager = new ZkCdnManager();
