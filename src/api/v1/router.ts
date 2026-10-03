import { Router, Request, Response } from 'express';

const router = Router();

interface ZkParamsConfig {
  cdnUrl: string;
  version: string;
  sha256Checksum: string;
}

const ZK_PARAMS_REGISTRY: Record<string, ZkParamsConfig> = {
  default: {
    cdnUrl: 'https://cdn.example.com/zk/params/default_v1.0.0.zkey',
    version: 'v1.0.0',
    sha256Checksum: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  }
};

router.get('/zk/params/:circuit_id', (req: Request, res: Response) => {
  const { circuit_id } = req.params;
  const config = ZK_PARAMS_REGISTRY[circuit_id] || ZK_PARAMS_REGISTRY['default'];

  return res.status(200).json({
    success: true,
    circuit_id,
    version: config.version,
    cdn_url: config.cdnUrl,
    checksum: config.sha256Checksum
  });
});

export default router;
