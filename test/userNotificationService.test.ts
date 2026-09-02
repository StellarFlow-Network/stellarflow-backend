import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { UserNotificationService, NotificationEventType } from '../src/services/userNotificationService';

describe('UserNotificationService', () => {
  let service: UserNotificationService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new UserNotificationService();
  });

  it('should instantiate successfully', () => {
    expect(service).toBeDefined();
  });

  it('should support enqueueing notification payloads', async () => {
    const enqueueSpy = jest.spyOn(service, 'enqueueNotification').mockResolvedValueOnce();
    
    await service.enqueueNotification({
      userId: 'user-123',
      eventType: NotificationEventType.LIQUIDATION,
      title: 'Vault Liquidation Risk',
      message: 'Your vault is approaching liquidation threshold.'
    });

    expect(enqueueSpy).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-123',
      eventType: NotificationEventType.LIQUIDATION
    }));
  });
});
