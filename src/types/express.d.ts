import type { Relayer } from "./relayer.types";

declare global {
  namespace Express {
    interface Request {
      relayer: Relayer;
    }
  }
}

export {};

export {};
