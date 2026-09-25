import prisma from "../lib/prisma";
import { NotificationEventType, UserNotificationService } from "./userNotificationService";

export interface WatchlistInput { token: string; targetPrice: number; direction?: "ABOVE" | "BELOW"; }

export class WatchlistService {
  constructor(private readonly notifications = new UserNotificationService()) {}
  private get client(): any { return prisma as any; }
  list(userId: number) { return this.client.watchlistItem.findMany({ where: { userId }, orderBy: { createdAt: "desc" } }); }
  create(userId: number, input: WatchlistInput) { return this.client.watchlistItem.create({ data: { userId, token: input.token.toUpperCase(), targetPrice: input.targetPrice, direction: input.direction ?? "ABOVE" } }); }
  update(userId: number, id: string, input: Partial<WatchlistInput> & { isActive?: boolean }) { return this.client.watchlistItem.updateMany({ where: { id, userId }, data: { ...(input.token && { token: input.token.toUpperCase() }), ...(input.targetPrice !== undefined && { targetPrice: input.targetPrice }), ...(input.direction && { direction: input.direction }), ...(input.isActive !== undefined && { isActive: input.isActive }) } }); }
  delete(userId: number, id: string) { return this.client.watchlistItem.deleteMany({ where: { id, userId } }); }
  async evaluatePrice(token: string, price: number): Promise<number> {
    const items = await this.client.watchlistItem.findMany({ where: { token: token.toUpperCase(), isActive: true } });
    let triggered = 0;
    for (const item of items) {
      const matches = item.direction === "ABOVE" ? price >= Number(item.targetPrice) : price <= Number(item.targetPrice);
      if (!matches) continue;
      await this.notifications.enqueueNotification({ userId: String(item.userId), eventType: NotificationEventType.ACCOUNT_EVENT, title: `${item.token} price alert`, message: `${item.token} reached ${price}; target was ${item.targetPrice}.`, data: { token: item.token, price, targetPrice: Number(item.targetPrice), direction: item.direction } });
      await this.client.watchlistItem.update({ where: { id: item.id }, data: { lastTriggeredAt: new Date(), isActive: false } });
      triggered += 1;
    }
    return triggered;
  }
}

export const watchlistService = new WatchlistService();