import {
  parseEvmCollateralLocked,
  parseSolanaCollateralLocked,
  type CollateralLockedEvent,
  type CollateralLockedFields,
} from "./collateralLockedEvent";

interface SocketLike {
  send(message: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: ((error: unknown) => void) | null;
}

export interface CollateralLockedFeedOptions {
  chainId: string;
  chainType: "EVM" | "SOLANA";
  websocketUrl: string;
  subscription: Record<string, unknown>;
  createSocket?: (url: string) => SocketLike;
  onEvent: (event: CollateralLockedEvent) => Promise<void>;
}

/**
 * Consumes a chain adapter's WebSocket notifications and forwards only
 * normalized CollateralLocked events to the bridge persistence/queue layer.
 */
export class CollateralLockedWebSocketFeed {
  private socket: SocketLike | undefined;

  constructor(private readonly options: CollateralLockedFeedOptions) {}

  start(): void {
    if (this.socket) return;
    const createSocket =
      this.options.createSocket ??
      ((url: string) => new (globalThis as any).WebSocket(url) as SocketLike);
    this.socket = createSocket(this.options.websocketUrl);
    this.socket.onopen = () => {
      this.socket?.send(JSON.stringify(this.options.subscription));
    };
    this.socket.onmessage = (message) => {
      void this.handleMessage(message.data);
    };
    this.socket.onerror = (error) => {
      console.error("[CollateralLockedFeed] WebSocket error", error);
    };
  }

  stop(): void {
    this.socket?.close();
    this.socket = undefined;
  }

  private async handleMessage(raw: string): Promise<void> {
    try {
      const payload = JSON.parse(raw) as {
        result?: { event?: string; fields?: CollateralLockedFields };
        params?: { result?: { value?: { logs?: string[]; fields?: CollateralLockedFields } } };
      };
      const fields = payload.result?.fields ?? payload.params?.result?.value?.fields;
      const event = fields
        ? this.options.chainType === "EVM"
          ? parseEvmCollateralLocked(this.options.chainId, fields)
          : parseSolanaCollateralLocked(
              this.options.chainId,
              `COLLATERAL_LOCKED:${JSON.stringify(fields)}`,
            )
        : payload.params?.result?.value?.logs
            ?.map((log) => parseSolanaCollateralLocked(this.options.chainId, log))
            .find((candidate): candidate is CollateralLockedEvent => candidate !== null);
      if (event) await this.options.onEvent(event);
    } catch (error) {
      console.error("[CollateralLockedFeed] Invalid event notification", error);
    }
  }
}
