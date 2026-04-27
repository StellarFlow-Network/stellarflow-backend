import axios from 'axios';
import { WebhookReporter } from '../src/utils/webhookReporter';

// Mock axios to prevent real HTTP requests
jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock console methods to prevent test output pollution
const originalConsoleError = console.error;
const originalConsoleLog = console.log;

describe('WebhookReporter', () => {
  let reporter: WebhookReporter;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Reset environment variables
    originalEnv = { ...process.env };
    
    // Mock console methods
    console.error = jest.fn();
    console.log = jest.fn();
    
    // Clear axios mocks
    jest.clearAllMocks();
    
    // Create fresh reporter instance
    reporter = new WebhookReporter();
    
    // Clear rate limits
    reporter.clearRateLimit();
  });

  afterEach(() => {
    // Restore environment variables
    process.env = originalEnv;
    
    // Restore console methods
    console.error = originalConsoleError;
    console.log = originalConsoleLog;
  });

  describe('sendCriticalAlert', () => {
    it('should send Discord webhook when Discord URL is configured', async () => {
      // Setup
      process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/test';
      process.env.SLACK_WEBHOOK_URL = '';
      process.env.WEBHOOK_RATE_LIMIT_MINUTES = '5';

      const testError = new Error('Test error message');
      const fetcherName = 'TestFetcher';

      // Mock successful Discord response
      mockedAxios.post.mockResolvedValueOnce({
        status: 204,
      });

      // Execute
      await reporter.sendCriticalAlert(testError, fetcherName);

      // Verify Discord webhook was called
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'https://discord.com/api/webhooks/test',
        expect.objectContaining({
          username: 'StellarFlow Alert',
          content: '🚨 **Critical Fetcher Failure**',
          embeds: expect.arrayContaining([
            expect.objectContaining({
              title: '❌ TestFetcher Failed',
              color: 0xFF0000,
              fields: expect.arrayContaining([
                expect.objectContaining({
                  name: '🔧 Fetcher',
                  value: 'TestFetcher',
                  inline: true,
                }),
                expect.objectContaining({
                  name: '📝 Error',
                  value: '```Test error message```',
                  inline: false,
                }),
              ]),
            }),
          ]),
        }),
        {
          headers: {
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        }
      );

      // Verify success log
      expect(console.log).toHaveBeenCalledWith('Critical alert sent for TestFetcher');
    });

    it('should fallback to Slack when Discord fails', async () => {
      // Setup
      process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/test';
      process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/test';
      process.env.WEBHOOK_RATE_LIMIT_MINUTES = '5';

      const testError = new Error('Test error message');
      const fetcherName = 'TestFetcher';

      // Mock Discord failure and Slack success
      mockedAxios.post
        .mockRejectedValueOnce(new Error('Discord failed'))
        .mockResolvedValueOnce({
          status: 200,
        });

      // Execute
      await reporter.sendCriticalAlert(testError, fetcherName);

      // Verify both webhooks were attempted
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
      
      // Verify Discord was called first
      expect(mockedAxios.post).toHaveBeenNthCalledWith(1,
        'https://discord.com/api/webhooks/test',
        expect.any(Object),
        expect.any(Object)
      );

      // Verify Slack was called as fallback
      expect(mockedAxios.post).toHaveBeenNthCalledWith(2,
        'https://hooks.slack.com/services/test',
        expect.objectContaining({
          text: '🚨 Critical Fetcher Failure',
          username: 'StellarFlow Alert',
          attachments: expect.arrayContaining([
            expect.objectContaining({
              color: 'danger',
              title: '❌ TestFetcher Failed',
              fields: expect.arrayContaining([
                expect.objectContaining({
                  title: '🔧 Fetcher',
                  value: 'TestFetcher',
                  short: true,
                }),
                expect.objectContaining({
                  title: '📝 Error',
                  value: 'Test error message',
                  short: false,
                }),
              ]),
            }),
          ]),
        }),
        expect.any(Object)
      );

      // Verify success log
      expect(console.log).toHaveBeenCalledWith('Critical alert sent for TestFetcher');
    });

    it('should handle string errors', async () => {
      // Setup
      process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/test';
      process.env.SLACK_WEBHOOK_URL = '';
      process.env.WEBHOOK_RATE_LIMIT_MINUTES = '5';

      const testError = 'String error message';
      const fetcherName = 'TestFetcher';

      // Mock successful Discord response
      mockedAxios.post.mockResolvedValueOnce({
        status: 204,
      });

      // Execute
      await reporter.sendCriticalAlert(testError, fetcherName);

      // Verify Discord webhook was called with string error
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'https://discord.com/api/webhooks/test',
        expect.objectContaining({
          embeds: expect.arrayContaining([
            expect.objectContaining({
              fields: expect.arrayContaining([
                expect.objectContaining({
                  name: '📝 Error',
                  value: '```String error message```',
                  inline: false,
                }),
              ]),
            }),
          ]),
        }),
        expect.any(Object)
      );
    });

    it('should respect rate limiting', async () => {
      // Setup
      process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/test';
      process.env.SLACK_WEBHOOK_URL = '';
      process.env.WEBHOOK_RATE_LIMIT_MINUTES = '5';

      const testError = new Error('Test error message');
      const fetcherName = 'TestFetcher';

      // Mock successful Discord response
      mockedAxios.post.mockResolvedValue({
        status: 204,
      });

      // Execute first alert
      await reporter.sendCriticalAlert(testError, fetcherName);

      // Execute second alert immediately (should be rate limited)
      await reporter.sendCriticalAlert(testError, fetcherName);

      // Verify only one webhook call was made
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
      
      // Verify rate limit log
      expect(console.log).toHaveBeenCalledWith('Webhook alert for TestFetcher rate limited');
    });

    it('should allow different fetchers to bypass rate limits', async () => {
      // Setup
      process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/test';
      process.env.SLACK_WEBHOOK_URL = '';
      process.env.WEBHOOK_RATE_LIMIT_MINUTES = '5';

      const testError = new Error('Test error message');

      // Mock successful Discord response
      mockedAxios.post.mockResolvedValue({
        status: 204,
      });

      // Execute alerts for different fetchers
      await reporter.sendCriticalAlert(testError, 'Fetcher1');
      await reporter.sendCriticalAlert(testError, 'Fetcher2');

      // Verify both webhooks were called
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    });

    it('should handle webhook failures gracefully', async () => {
      // Setup
      process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/test';
      process.env.SLACK_WEBHOOK_URL = '';
      process.env.WEBHOOK_RATE_LIMIT_MINUTES = '5';

      const testError = new Error('Test error message');
      const fetcherName = 'TestFetcher';

      // Mock Discord failure
      mockedAxios.post.mockRejectedValueOnce(new Error('Network error'));

      // Execute
      await reporter.sendCriticalAlert(testError, fetcherName);

      // Verify error was logged
      expect(console.error).toHaveBeenCalledWith('Failed to send critical alert for TestFetcher');
    });

    it('should work with no webhook URLs configured', async () => {
      // Setup
      process.env.DISCORD_WEBHOOK_URL = '';
      process.env.SLACK_WEBHOOK_URL = '';
      process.env.WEBHOOK_RATE_LIMIT_MINUTES = '5';

      const testError = new Error('Test error message');
      const fetcherName = 'TestFetcher';

      // Execute
      await reporter.sendCriticalAlert(testError, fetcherName);

      // Verify no HTTP requests were made
      expect(mockedAxios.post).not.toHaveBeenCalled();
      
      // Verify error was logged
      expect(console.error).toHaveBeenCalledWith('Failed to send critical alert for TestFetcher');
    });
  });

  describe('rate limiting', () => {
    beforeEach(() => {
      process.env.WEBHOOK_RATE_LIMIT_MINUTES = '1'; // 1 minute for testing
    });

    it('should allow alerts after rate limit expires', async () => {
      // Setup
      process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/test';
      process.env.SLACK_WEBHOOK_URL = '';

      const testError = new Error('Test error message');
      const fetcherName = 'TestFetcher';

      // Mock successful Discord response
      mockedAxios.post.mockResolvedValue({
        status: 204,
      });

      // Execute first alert
      await reporter.sendCriticalAlert(testError, fetcherName);

      // Mock time passage (more than rate limit)
      const originalDateNow = Date.now;
      Date.now = jest.fn(() => originalDateNow() + 2 * 60 * 1000); // 2 minutes later

      // Execute second alert after rate limit expires
      await reporter.sendCriticalAlert(testError, fetcherName);

      // Verify both webhooks were called
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);

      // Restore Date.now
      Date.now = originalDateNow;
    });
  });

  describe('utility methods', () => {
    it('should clear rate limit for specific fetcher', () => {
      // Setup
      process.env.WEBHOOK_RATE_LIMIT_MINUTES = '5';

      // Manually set a rate limit
      const reporter = new WebhookReporter();
      (reporter as any).lastSentTimes.set('TestFetcher', Date.now());

      // Clear specific fetcher
      reporter.clearRateLimit('TestFetcher');

      // Verify rate limit was cleared
      const status = reporter.getRateLimitStatus();
      expect(status['TestFetcher']).toBeUndefined();
    });

    it('should clear all rate limits', () => {
      // Setup
      process.env.WEBHOOK_RATE_LIMIT_MINUTES = '5';

      // Manually set rate limits
      const reporter = new WebhookReporter();
      (reporter as any).lastSentTimes.set('TestFetcher1', Date.now());
      (reporter as any).lastSentTimes.set('TestFetcher2', Date.now());

      // Clear all rate limits
      reporter.clearRateLimit();

      // Verify all rate limits were cleared
      const status = reporter.getRateLimitStatus();
      expect(Object.keys(status)).toHaveLength(0);
    });

    it('should provide rate limit status', () => {
      // Setup
      process.env.WEBHOOK_RATE_LIMIT_MINUTES = '5';

      const reporter = new WebhookReporter();
      const now = Date.now();
      (reporter as any).lastSentTimes.set('TestFetcher', now - 60000); // 1 minute ago

      // Get status
      const status = reporter.getRateLimitStatus();

      // Verify status
      expect(status['TestFetcher']).toEqual({
        lastSent: now - 60000,
        canSend: false, // Still within 5 minute rate limit
      });
    });
  });

  describe('message formatting', () => {
    it('should include stack trace in Discord message when available', async () => {
      // Setup
      process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/test';
      process.env.SLACK_WEBHOOK_URL = '';

      const testError = new Error('Test error');
      testError.stack = 'Error: Test error\n    at test.js:1:1';
      const fetcherName = 'TestFetcher';

      // Mock successful Discord response
      mockedAxios.post.mockResolvedValueOnce({
        status: 204,
      });

      // Execute
      await reporter.sendCriticalAlert(testError, fetcherName);

      // Verify stack trace is included
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'https://discord.com/api/webhooks/test',
        expect.objectContaining({
          embeds: expect.arrayContaining([
            expect.objectContaining({
              fields: expect.arrayContaining([
                expect.objectContaining({
                  name: '📚 Stack Trace',
                  value: '```Error: Test error\n    at test.js:1:1```',
                  inline: false,
                }),
              ]),
            }),
          ]),
        }),
        expect.any(Object)
      );
    });

    it('should truncate long stack traces', async () => {
      // Setup
      process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/test';
      process.env.SLACK_WEBHOOK_URL = '';

      const testError = new Error('Test error');
      testError.stack = 'Error: Test error\n' + '    at test.js:1:1\n'.repeat(100); // Very long stack
      const fetcherName = 'TestFetcher';

      // Mock successful Discord response
      mockedAxios.post.mockResolvedValueOnce({
        status: 204,
      });

      // Execute
      await reporter.sendCriticalAlert(testError, fetcherName);

      // Verify stack trace is truncated
      const call = mockedAxios.post.mock.calls[0];
      const stackTraceField = call[1].embeds[0].fields.find((f: any) => f.name === '📚 Stack Trace');
      expect(stackTraceField.value).toContain('...');
      expect(stackTraceField.value.length).toBeLessThan(1100); // Should be truncated
    });
  });
});
