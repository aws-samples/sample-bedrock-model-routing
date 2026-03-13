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

  // Test 1: Basic connectivity
  await runTest('Basic Nova Lite invocation', async () => {
    const model = new BedrockModel({
      modelId: 'amazon.nova-2-lite-v1:0',
      weight: 100,
      isFallback: false
    });

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

  // Test 2: Multiplexer with fallback
  await runTest('Multiplexer weighted selection', async () => {
    const multiplexer = createMultiplexer([
      {
        modelId: 'amazon.nova-2-lite-v1:0',
        weight: 100,
        isFallback: false
      }
    ]);

    try {
      const health = multiplexer.getHealthStatus();
      if (!health.isHealthy) throw new Error('Unhealthy');
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
  console.log(`Status: ${failed === 0 ? 'READY FOR PRODUCTION' : 'NOT READY'}`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(console.error);
