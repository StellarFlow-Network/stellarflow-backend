import { Router, Request, Response } from 'express';
import { refreshSep38Quote } from '../../controllers/remittanceFxController';

const router = Router();

interface ZkParamsConfig {
  cdnUrl: string;
  version: string;
  sha256Checksum: string;
}

const ZK_PARAMS_REGISTRY: Record<string, ZkParamsConfig> = {
  default: {
    cdnUrl: 'https://cdn.example.com/zk/params/default_v1.0.0.z.key',
    version: 'v1.0.0',
    sha256Checksum: 'e3b0c44298c1c149afbf4c996fb92427ae41ed464ab94c4991b7855'
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

// SEP-38 exchange rate quote refresh engine.
// Issues a valid updated quote against live anchor rates and expires
// the previous quote.
router.post('/remittance/sep38/refresh-quote', refreshSep38Quote);
router.get('/remittance/sep38/refresh-quote', refreshSep38Quote);

export default router;
