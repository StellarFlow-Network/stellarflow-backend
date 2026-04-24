declare global {
  namespace Express {
    interface Request {
      relayer?: {
        id: number;
        name: string;
        allowedAssets: string[];
      };
    }
  }
}

export {};
