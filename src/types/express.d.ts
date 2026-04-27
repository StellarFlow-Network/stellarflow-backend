declare global {
  namespace Express {
    interface Request {
      relayer?: {
        id: number;
        name: string;
        allowedAssets: string[];
        /** Ed25519 public key (hex) registered for this relayer, if any */
        publicKey?: string | null;
      };
    }
  }
}

export {};
