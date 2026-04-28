export class PriceUpdateEvent {
  constructor(
    public readonly symbol: string,
    public readonly price: number,
    public readonly timestamp: number = Date.now(),
  ) {}
}