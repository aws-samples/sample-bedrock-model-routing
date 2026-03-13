/**
 * Example 7: Event System
 *
 * Demonstrates every event the multiplexer emits. The multiplexer extends
 * Node.js EventEmitter — you can use on(), once(), removeListener(), etc.
 *
 * Events cover the full request lifecycle: receipt → model selection →
 * invocation start → invocation complete → success/error → stats update.
 */
import 'dotenv/config';
import { ConverseCommandInput } from '@aws-sdk/client-bedrock-runtime';
import { createMultiplexer, ModelConfiguration } from 'bedrock-model-multiplexer';

async function main(): Promise<void> {
  const models: ModelConfiguration[] = [
    { modelId: 'amazon.nova-2-lite-v1:0',   weight: 100, isFallback: false },
    { modelId: 'amazon.nova-pro-v1:0',    weight: 30,  isFallback: true  },
  ];

  const multiplexer = createMultiplexer(models, {
    maxRetries: 3,
    clientConfig: { region: 'us-east-1', maxAttempts: 1 },
  });

  // --- Request lifecycle events ---

  multiplexer.on('request', (input) => {
    console.log('📥 [request] Request received');
  });

  multiplexer.on('model-selected', (modelId: string, isFallback: boolean, retryCount: number) => {
    const pool = isFallback ? 'fallback' : 'primary';
    console.log(`🎯 [model-selected] ${modelId} (${pool}, retry #${retryCount})`);
  });

  multiplexer.on('model-invocation-start', (modelId: string, requestId: string) => {
    console.log(`🚀 [model-invocation-start] ${modelId} [${requestId}]`);
  });

  multiplexer.on('model-invocation-complete', (modelId: string, requestId: string, latency: number) => {
    console.log(`⏱️  [model-invocation-complete] ${modelId} [${requestId}] ${latency}ms`);
  });

  multiplexer.on('success', (_response, outcome) => {
    console.log(`✅ [success] ${outcome.modelId} — ${outcome.latency}ms`);
  });

  multiplexer.on('error', (error, outcome) => {
    console.log(`❌ [error] ${outcome?.modelId} — ${error?.message}`);
  });

  // --- Model management events ---

  multiplexer.on('model-added', (modelId: string) => {
    console.log(`➕ [model-added] ${modelId}`);
  });

  multiplexer.on('model-removed', (modelId: string) => {
    console.log(`➖ [model-removed] ${modelId}`);
  });

  multiplexer.on('model-circuit-open-skipped', (modelId: string) => {
    console.log(`⏭️  [model-circuit-open-skipped] ${modelId}`);
  });

  // --- Stats events ---

  multiplexer.on('stats', (stats) => {
    const total = stats.successCount + stats.rateLimitCount + stats.failFastCount;
    console.log(`📊 [stats] ${total} requests, ${stats.successCount} success`);
  });

  multiplexer.on('stats-reset', () => {
    console.log('🔄 [stats-reset] Statistics cleared');
  });

  // --- Fire a request to trigger events ---
  const input: Omit<ConverseCommandInput, 'modelId'> = {
    messages: [
      { role: 'user', content: [{ text: 'Hi there' }] },
    ],
    inferenceConfig: { maxTokens: 50 },
  };

  console.log('--- Sending request ---\n');
  try {
    await multiplexer.processRequest(input);
  } catch {
    // Expected in demo environment
  }

  // --- Trigger model management events ---
  console.log('\n--- Dynamic model management ---\n');

  multiplexer.addModel({
    modelId: 'amazon.titan-text-express-v1',
    weight: 20,
    isFallback: true,
  });

  multiplexer.removeModel('amazon.titan-text-express-v1');

  // --- Trigger stats-reset event ---
  console.log('\n--- Resetting stats ---\n');
  multiplexer.resetStats();

  multiplexer.destroy();
}

main().catch(console.error);
