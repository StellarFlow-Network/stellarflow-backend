import { Router } from 'express';
import { VaultController } from '../controllers/vaultController';

const router = Router();
const vaultController = new VaultController();

router.get('/positions/:account_id', (req, res) => {
  vaultController.getPosition(req, res);
});

export default router;
