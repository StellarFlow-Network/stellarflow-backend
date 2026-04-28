export interface MessageBus {
  publish<T = any>(channel: string, message: T): Promise<void>;
  subscribe(channel: string, handler: (message: any) => void): Promise<void>;
}