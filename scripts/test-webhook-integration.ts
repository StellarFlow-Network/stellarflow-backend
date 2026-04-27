#!/usr/bin/env tsx

import { 
  sendKillSwitchAlert, 
  sendSystemFailureAlert, 
  sendFailoverEventAlert, 
  sendPriceAnomalyAlert,
  notificationService 
} from '../src/services/notificationService.js';

async function testWebhookIntegration() {
  console.log('🧪 Testing StellarFlow Webhook Integration...\n');

  try {
    // Test 1: Kill Switch Alert
    console.log('1️⃣ Testing Kill Switch Alert...');
    await sendKillSwitchAlert({
      reason: 'Test kill switch triggered by integration test',
      service: 'test-service',
      correlationId: 'test-kill-switch-001'
    });
    console.log('✅ Kill Switch Alert sent successfully\n');

    // Test 2: System Failure Alert
    console.log('2️⃣ Testing System Failure Alert...');
    await sendSystemFailureAlert({
      error: 'Test system failure for integration testing',
      service: 'test-service',
      correlationId: 'test-system-failure-001'
    });
    console.log('✅ System Failure Alert sent successfully\n');

    // Test 3: Failover Event Alert
    console.log('3️⃣ Testing Failover Event Alert...');
    await sendFailoverEventAlert({
      fromRegion: 'PRIMARY',
      toRegion: 'SECONDARY',
      reason: 'Test automatic failover triggered',
      automatic: true,
      correlationId: 'test-failover-001'
    });
    console.log('✅ Failover Event Alert sent successfully\n');

    // Test 4: Price Anomaly Alert
    console.log('4️⃣ Testing Price Anomaly Alert...');
    await sendPriceAnomalyAlert({
      currency: 'BTC',
      rate: 50000,
      expectedRate: 48000,
      deviationPercent: 4.17,
      source: 'test-oracle',
      correlationId: 'test-price-anomaly-001'
    });
    console.log('✅ Price Anomaly Alert sent successfully\n');

    // Test 5: Custom Alert
    console.log('5️⃣ Testing Custom Alert...');
    await notificationService.sendAlert({
      type: 'security_alert' as any,
      severity: 'high' as any,
      title: '🔐 Security Alert Test',
      message: 'This is a test security alert from the integration test',
      details: {
        ip_address: '192.168.1.100',
        user_agent: 'Test-Agent/1.0',
        suspicious_activity: 'Multiple failed login attempts'
      },
      timestamp: new Date(),
      service: 'security-service',
      correlationId: 'test-security-001'
    });
    console.log('✅ Custom Alert sent successfully\n');

    // Show rate limit status
    console.log('📊 Rate Limit Status:');
    const rateLimitStatus = notificationService.getRateLimitStatus();
    console.log(JSON.stringify(rateLimitStatus, null, 2));

    console.log('\n🎉 All webhook integration tests completed successfully!');
    console.log('\n📝 Configuration:');
    const config = notificationService.getConfig();
    console.log(`- Discord Webhook: ${config.discordWebhookUrl ? '✅ Configured' : '❌ Not configured'}`);
    console.log(`- Slack Webhook: ${config.slackWebhookUrl ? '✅ Configured' : '❌ Not configured'}`);
    console.log(`- Enabled Platforms: ${config.enabledPlatforms.join(', ')}`);
    console.log(`- Rate Limit: ${config.rateLimitMinutes} minutes`);
    console.log(`- Retry Attempts: ${config.retryAttempts}`);

  } catch (error) {
    console.error('❌ Webhook integration test failed:', error);
    process.exit(1);
  }
}

// Check if webhooks are configured
function checkConfiguration() {
  const hasDiscord = !!process.env.DISCORD_WEBHOOK_URL;
  const hasSlack = !!process.env.SLACK_WEBHOOK_URL;

  if (!hasDiscord && !hasSlack) {
    console.log('⚠️  No webhook URLs configured in environment variables.');
    console.log('Please set DISCORD_WEBHOOK_URL and/or SLACK_WEBHOOK_URL to test actual webhook delivery.');
    console.log('This test will run in dry-run mode without sending real webhooks.\n');
    return false;
  }

  console.log('✅ Webhook configuration detected:');
  if (hasDiscord) console.log(`- Discord: ${process.env.DISCORD_WEBHOOK_URL?.substring(0, 50)}...`);
  if (hasSlack) console.log(`- Slack: ${process.env.SLACK_WEBHOOK_URL?.substring(0, 50)}...`);
  console.log();

  return true;
}

// Main execution
async function main() {
  console.log('🚀 StellarFlow Webhook Integration Test\n');
  
  const isConfigured = checkConfiguration();
  
  if (!isConfigured) {
    console.log('🔧 To configure webhooks, add these to your .env file:');
    console.log('DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR_WEBHOOK_URL');
    console.log('SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR_WEBHOOK_URL');
    console.log('\nContinuing with test anyway...\n');
  }

  await testWebhookIntegration();
}

// Run the test
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
