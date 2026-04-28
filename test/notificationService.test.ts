import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import axios from 'axios';
import { 
  NotificationService, 
  AlertType, 
  AlertSeverity,
  notificationService,
  sendKillSwitchAlert,
  sendSystemFailureAlert,
  sendFailoverEventAlert,
  sendPriceAnomalyAlert
} from '../src/services/notificationService';

// Mock axios
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock console methods to avoid test output
jest.mock('console', () => ({
  debug: jest.fn(),
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

describe('NotificationService', () => {
  let service: NotificationService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new NotificationService({
      discordWebhookUrl: 'https://discord.com/api/webhooks/test',
      slackWebhookUrl: 'https://hooks.slack.com/services/test',
      enabledPlatforms: ['discord', 'slack'],
      rateLimitMinutes: 1,
      retryAttempts: 2,
      timeoutMs: 5000
    });
  });

  describe('sendAlert', () => {
    it('should send Discord alert successfully', async () => {
      mockedAxios.post.mockResolvedValueOnce({ status: 200 });

      const alert = {
        type: AlertType.KILL_SWITCH_TRIGGERED,
        severity: AlertSeverity.CRITICAL,
        title: 'Test Alert',
        message: 'Test message',
        timestamp: new Date()
      };

      const result = await service.sendAlert(alert);

      expect(result).toBe(true);
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'https://discord.com/api/webhooks/test',
        expect.objectContaining({
          username: 'StellarFlow Alerts',
          embeds: expect.any(Array)
        }),
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 5000
        }
      );
    });

    it('should fallback to Slack if Discord fails', async () => {
      mockedAxios.post
        .mockRejectedValueOnce(new Error('Discord failed'))
        .mockResolvedValueOnce({ status: 200 });

      const alert = {
        type: AlertType.SYSTEM_FAILURE,
        severity: AlertSeverity.HIGH,
        title: 'Test Alert',
        message: 'Test message',
        timestamp: new Date()
      };

      const result = await service.sendAlert(alert);

      expect(result).toBe(true);
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    });

    it('should respect rate limiting', async () => {
      mockedAxios.post.mockResolvedValue({ status: 200 });

      const alert = {
        type: AlertType.PRICE_ANOMALY,
        severity: AlertSeverity.MEDIUM,
        title: 'Test Alert',
        message: 'Test message',
        timestamp: new Date(),
        service: 'test-service'
      };

      // First call should succeed
      const result1 = await service.sendAlert(alert);
      expect(result1).toBe(true);

      // Second call should be rate limited
      const result2 = await service.sendAlert(alert);
      expect(result2).toBe(false);
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    });
  });

  describe('convenience methods', () => {
    it('should send kill switch alert', async () => {
      mockedAxios.post.mockResolvedValue({ status: 200 });

      await sendKillSwitchAlert({
        reason: 'Test kill switch',
        service: 'test-service'
      });

      expect(mockedAxios.post).toHaveBeenCalled();
    });

    it('should send system failure alert', async () => {
      mockedAxios.post.mockResolvedValue({ status: 200 });

      await sendSystemFailureAlert({
        error: 'Test error',
        service: 'test-service'
      });

      expect(mockedAxios.post).toHaveBeenCalled();
    });

    it('should send failover event alert', async () => {
      mockedAxios.post.mockResolvedValue({ status: 200 });

      await sendFailoverEventAlert({
        fromRegion: 'PRIMARY',
        toRegion: 'SECONDARY',
        reason: 'Test failover',
        automatic: true
      });

      expect(mockedAxios.post).toHaveBeenCalled();
    });

    it('should send price anomaly alert', async () => {
      mockedAxios.post.mockResolvedValue({ status: 200 });

      await sendPriceAnomalyAlert({
        currency: 'BTC',
        rate: 50000,
        expectedRate: 48000,
        deviationPercent: 4.17,
        source: 'test-source'
      });

      expect(mockedAxios.post).toHaveBeenCalled();
    });
  });

  describe('configuration', () => {
    it('should update configuration', () => {
      const newConfig = {
        rateLimitMinutes: 10,
        retryAttempts: 5
      };

      service.updateConfig(newConfig);
      const config = service.getConfig();

      expect(config.rateLimitMinutes).toBe(10);
      expect(config.retryAttempts).toBe(5);
    });

    it('should clear rate limit', () => {
      service.clearRateLimit();
      const status = service.getRateLimitStatus();
      expect(Object.keys(status)).toHaveLength(0);
    });
  });

  describe('payload formatting', () => {
    it('should format Discord payload correctly', () => {
      const alert = {
        type: AlertType.KILL_SWITCH_TRIGGERED,
        severity: AlertSeverity.CRITICAL,
        title: 'Critical Alert',
        message: 'System halted',
        timestamp: new Date(),
        details: {
          reason: 'Test reason',
          service: 'test-service'
        }
      };

      const payload = (service as any).formatDiscordPayload(alert);

      expect(payload.username).toBe('StellarFlow Alerts');
      expect(payload.embeds).toHaveLength(1);
      expect(payload.embeds[0].title).toBe('Critical Alert');
      expect(payload.embeds[0].color).toBe(0xff0000); // Red for critical
      expect(payload.embeds[0].fields).toContainEqual({
        name: 'Reason',
        value: 'Test reason',
        inline: false
      });
    });

    it('should format Slack payload correctly', () => {
      const alert = {
        type: AlertType.FAILOVER_EVENT,
        severity: AlertSeverity.HIGH,
        title: 'Failover Event',
        message: 'System failed over',
        timestamp: new Date(),
        region: 'PRIMARY'
      };

      const payload = (service as any).formatSlackPayload(alert);

      expect(payload.username).toBe('StellarFlow Alerts');
      expect(payload.blocks).toBeDefined();
      expect(payload.blocks[0].text.text).toContain('🟠 Failover Event');
    });
  });
});
