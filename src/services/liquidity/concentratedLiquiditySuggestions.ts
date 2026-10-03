import {
  suggestConcentratedLiquidityRebalance,
  type ConcentratedLiquidityPositionSnapshot,
  type ConcentratedLiquidityRebalancingSuggestion,
} from "./calculation";
import { broadcastToSessions } from "../../lib/socket";
import {
  NotificationEventType,
  userNotificationService,
} from "../userNotificationService";

export interface ConcentratedLiquiditySuggestionNotifier {
  notify(
    ownerId: string,
    suggestion: ConcentratedLiquidityRebalancingSuggestion,
  ): Promise<void>;
}

export class UserConcentratedLiquiditySuggestionNotifier
  implements ConcentratedLiquiditySuggestionNotifier
{
  async notify(
    ownerId: string,
    suggestion: ConcentratedLiquidityRebalancingSuggestion,
  ): Promise<void> {
    const data = { event: "liquidity.position.rebalance_suggestion", suggestion };
    broadcastToSessions("liquidity.position.rebalance_suggestion", {
      ownerId,
      ...data,
    });
    await userNotificationService.enqueueNotification({
      userId: ownerId,
      eventType: NotificationEventType.ACCOUNT_EVENT,
      title: "Liquidity position is out of range",
      message: `Position ${suggestion.positionId} has a new recommended price range.`,
      data,
    });
  }
}

export class ConcentratedLiquiditySuggestionEngine {
  constructor(private readonly notifier: ConcentratedLiquiditySuggestionNotifier) {}

  async evaluate(
    positions: readonly ConcentratedLiquidityPositionSnapshot[],
  ): Promise<ConcentratedLiquidityRebalancingSuggestion[]> {
    const suggestions = positions.flatMap((position) => {
      const suggestion = suggestConcentratedLiquidityRebalance(position);
      return suggestion ? [suggestion] : [];
    });
    await Promise.all(
      suggestions.map((suggestion) =>
        this.notifier.notify(suggestion.ownerId, suggestion),
      ),
    );
    return suggestions;
  }
}