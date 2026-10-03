import { Router, type Request, type Response } from "express";
import {
  InvalidLedgerProofError,
  verifySorobanStateProof,
} from "../services/sorobanStateProofService";

const router = Router();

router.post("/verify-proof", (req: Request, res: Response) => {
  try {
    const result = verifySorobanStateProof(req.body);
    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof InvalidLedgerProofError) {
      return res.status(400).json({
        code: error.code,
        message: error.message,
      });
    }
    return res.status(400).json({
      code: "InvalidLedgerProof",
      message: "The supplied ledger proof is invalid.",
    });
  }
});

export default router;
