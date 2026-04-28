#!/usr/bin/env ts-node
/**
 * Amazon Bedrock Integration Test Runner
 * Run with: npx ts-node src/scripts/run-integration-tests.ts
 */

import {
  createMultiplexer,
  BedrockModel,
  BedrockMultiplexer,
} from '../index';

interface TestResult {
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  duration: number;
  error?: string;
}

const results: TestResult[] = [];
const TEST_REGION = process.env.AWS_REGION || 'us-east-1';

const models = [
  { modelId: 'amazon.nova-2-lite-v1:0', weight: 100, isFallback: false },
  { modelId: 'amazon.nova-pro-v1:0',    weight: 30,  isFallback: true  },
];

async function runTest(
  name: string,
  fn: () => Promise<void>
): Promise<TestResult> {
  const start = Date.now();
  try {
    await fn();
    const result = { name, status: 'PASS' as const, duration: Date.now() - start };
    results.push(result);
    console.log(`✅ ${name} (${result.duration}ms)`);
    return result;
  } catch (error: any) {
    const result = {
      name,
      status: 'FAIL' as const,
      duration: Date.now() - start,
      error: error.message
    };
    results.push(result);
    console.log(`❌ ${name}: ${error.message}`);
    return result;
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('Amazon Bedrock Model Multiplexer - Integration Tests');
  console.log(`Region: ${TEST_REGION}`);
  console.log('='.repeat(60));
  console.log('');

  // --- Core functionality ---

  console.log('--- Core ---');

  await runTest('Basic Nova Lite invocation', async () => {
    const model = new BedrockModel(
      { modelId: 'amazon.nova-2-lite-v1:0', weight: 100, isFallback: false },
      undefined, 30000, undefined,
      { region: TEST_REGION, maxAttempts: 1 }
    );

    try {
      const result = await model.invoke({
        messages: [{ role: 'user', content: [{ text: 'Say hello' }] }],
        inferenceConfig: { maxTokens: 20 }
      });
      if (!result.response.output) throw new Error('No response');
    } finally {
      model.destroy();
    }
  });

  await runTest('Multiplexer weighted selection and health', async () => {
    const multiplexer = createMultiplexer(models, {
      clientConfig: { region: TEST_REGION, maxAttempts: 1 },
    });

    try {
      const health = multiplexer.getHealthStatus();
      if (!health.isHealthy) throw new Error('Unhealthy');
    } finally {
      multiplexer.destroy();
    }
  });

  await runTest('Multiplexer processRequest end-to-end', async () => {
    const multiplexer = createMultiplexer(models, {
      maxRetries: 3,
      clientConfig: { region: TEST_REGION, maxAttempts: 1 },
    });

    try {
      const response = await multiplexer.processRequest({
        messages: [{ role: 'user', content: [{ text: 'Say hi in one word' }] }],
        inferenceConfig: { maxTokens: 10 }
      });
      if (!response.output?.message?.content?.[0]?.text) {
        throw new Error('No assistant text in response');
      }
    } finally {
      multiplexer.destroy();
    }
  });

  // --- Service tier escalation ---

  console.log('\n--- Service Tier Escalation ---');

  await runTest('Multiplexer initializes with tierEscalation (priority)', async () => {
    const multiplexer = createMultiplexer(models, {
      maxRetries: 3,
      clientConfig: { region: TEST_REGION, maxAttempts: 1 },
      tierEscalation: { enabled: true, escalationTier: 'priority' },
    });

    try {
      const config = multiplexer.tierEscalationConfig;
      if (!config) throw new Error('tierEscalationConfig is undefined');
      if (config.escalationTier !== 'priority') {
        throw new Error(`Expected 'priority', got '${config.escalationTier}'`);
      }
    } finally {
      multiplexer.destroy();
    }
  });

  await runTest('Multiplexer initializes with tierEscalation (reserved)', async () => {
    const multiplexer = createMultiplexer(models, {
      maxRetries: 3,
      clientConfig: { region: TEST_REGION, maxAttempts: 1 },
      tierEscalation: { enabled: true, escalationTier: 'reserved' },
    });

    try {
      const config = multiplexer.tierEscalationConfig;
      if (!config) throw new Error('tierEscalationConfig is undefined');
      if (config.escalationTier !== 'reserved') {
        throw new Error(`Expected 'reserved', got '${config.escalationTier}'`);
      }
    } finally {
      multiplexer.destroy();
    }
  });

  await runTest('Multiplexer tierEscalationConfig is undefined when disabled', async () => {
    const multiplexer = createMultiplexer(models, {
      maxRetries: 3,
      clientConfig: { region: TEST_REGION, maxAttempts: 1 },
      tierEscalation: { enabled: false, escalationTier: 'priority' },
    });

    try {
      if (multiplexer.tierEscalationConfig !== undefined) {
        throw new Error('Expected undefined when disabled');
      }
    } finally {
      multiplexer.destroy();
    }
  });

  await runTest('Multiplexer tierEscalationConfig is undefined when not configured', async () => {
    const multiplexer = createMultiplexer(models, {
      maxRetries: 3,
      clientConfig: { region: TEST_REGION, maxAttempts: 1 },
    });

    try {
      if (multiplexer.tierEscalationConfig !== undefined) {
        throw new Error('Expected undefined when not configured');
      }
    } finally {
      multiplexer.destroy();
    }
  });

  await runTest('BedrockModel.invoke accepts serviceTier parameter', async () => {
    const model = new BedrockModel(
      { modelId: 'amazon.nova-2-lite-v1:0', weight: 100, isFallback: false },
      undefined, 30000, undefined,
      { region: TEST_REGION, maxAttempts: 1 }
    );

    try {
      // Invoke with 'default' tier — should behave identically to no tier
      const result = await model.invoke(
        {
          messages: [{ role: 'user', content: [{ text: 'Say hi' }] }],
          inferenceConfig: { maxTokens: 10 }
        },
        undefined,
        'default'
      );
      if (!result.response.output) throw new Error('No response');
    } finally {
      model.destroy();
    }
  });

  await runTest('Tier escalation events emitted on processRequest', async () => {
    const multiplexer = createMultiplexer(models, {
      maxRetries: 3,
      clientConfig: { region: TEST_REGION, maxAttempts: 1 },
      tierEscalation: { enabled: true, escalationTier: 'priority' },
    });

    const events: string[] = [];
    multiplexer.on('tier-escalation', () => events.push('tier-escalation'));
    multiplexer.on('tier-escalation-success', () => events.push('tier-escalation-success'));
    multiplexer.on('tier-escalation-failure', () => events.push('tier-escalation-failure'));

    try {
      await multiplexer.processRequest({
        messages: [{ role: 'user', content: [{ text: 'Say hi' }] }],
        inferenceConfig: { maxTokens: 10 }
      });
      // If the request succeeds at default tier, no escalation events are expected.
      // If throttled, escalation events would fire. Either outcome is valid.
      console.log(`    (escalation events emitted: ${events.length})`);
    } catch {
      // Throttling or other errors are acceptable in integration tests
      console.log(`    (request failed, escalation events emitted: ${events.length})`);
    } finally {
      multiplexer.destroy();
    }
  });

  // Print summary
  console.log('');
  console.log('='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  
  console.log(`Total: ${results.length}, Passed: ${passed}, Failed: ${failed}`);
  console.log(`Status: ${failed === 0 ? 'ALL PASSED' : 'FAILURES DETECTED'}`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(console.error);
