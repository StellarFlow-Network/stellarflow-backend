export interface PriceUpdatePayload {
  symbol: string;
  price: number;
  timestamp: number;
}

export class PriceUpdateEvent {
  public readonly type = 'price-update' as const;

  constructor(
    public readonly symbol: string,
    public readonly price: number,
    public readonly timestamp: number = Date.now(),
  ) {}

  toJSON(): PriceUpdatePayload {
    return {
      symbol: this.symbol,
      price: this.price,
      timestamp: this.timestamp,
    };
  }

 static fromJSON(payload: PriceUpdatePayload): PriceUpdateEvent {
    return new PriceUpdateEvent(payload.symbol, payload.price, payload.timestamp);
  }
}
