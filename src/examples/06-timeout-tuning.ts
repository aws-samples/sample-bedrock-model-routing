/**
 * Example 6: Timeout Tuning
 *
 * Demonstrates how to configure and calibrate the per-request timeout.
 *
 * Key facts:
 * - Default timeout: 30,000ms
 * - Timeout fires → TimeoutError → circuit breaker records a failure → fail-fast
 * - NO cross-model failover on timeout (unlike rate limits)
 * - Enough timeouts (5 in 60s) → circuit breaker opens → model taken out of rotation
 * - Too aggressive: trips breakers on healthy-but-slow models
 * - Too generous: callers wait too long before seeing errors
 *
 * Rule of thumb: set timeout to 2–3× your observed p99 latency.
 */
import 'dotenv/config';
import { ConverseCommandInput } from '@aws-sdk/client-bedrock-runtime';
import { createMultiplexer, ModelConfiguration } from 'bedrock-model-multiplexer';

async function main(): Promise<void> {
  const models: ModelConfiguration[] = [
    { modelId: 'amazon.nova-2-lite-v1:0',   weight: 100, isFallback: false },
    { modelId: 'amazon.nova-pro-v1:0',    weight: 30,  isFallback: true  },
  ];

  // --- Step 1: Start with a conservative timeout for initial deployment ---
  const multiplexer = createMultiplexer(models, {
    defaultTimeoutMs: 30000, // 30s — safe default while you gather data
    maxRetries: 3,
    clientConfig: { region: 'us-east-1', maxAttempts: 1 },
  });

  // --- Step 2: Send some traffic to build up latency data ---
  const input: Omit<ConverseCommandInput, 'modelId'> = {
    messages: [
      { role: 'user', content: [{ text: 'Summarize the theory of relativity in three sentences.' }] },
    ],
    inferenceConfig: { maxTokens: 200 },
  };

  console.log('Sending requests to gather latency data...');
  for (let i = 0; i < 5; i++) {
    try {
      await multiplexer.processRequest(input);
      console.log(`  Request ${i + 1}: ✅`);
    } catch (error: any) {
      console.log(`  Request ${i + 1}: ❌ ${error.message}`);
    }
  }

  // --- Step 3: Use health metrics to determine the right timeout ---
  const health = multiplexer.getHealthStatus();

  console.log('\nObserved latency metrics:');
  console.log(`  Avg: ${health.metrics.averageLatencyMs.toFixed(0)}ms`);
  console.log(`  P99: ${health.metrics.p99LatencyMs.toFixed(0)}ms`);

  // Per-model latency
  for (const [modelId, model] of Object.entries(health.models)) {
    console.log(`  ${modelId}: avg ${model.avgResponseTimeMs.toFixed(0)}ms`);
  }

  // Calculate suggested timeout
  const suggestedTimeout = Math.ceil(health.metrics.p99LatencyMs * 2.5);
  console.log(`\nSuggested timeout (2.5× p99): ${suggestedTimeout}ms`);

  // --- Timeout guidelines by workload ---
  console.log('\nTimeout guidelines:');
  console.log('  Short completions (< 200 tokens):     5,000–10,000ms');
  console.log('  Medium completions (200–1000 tokens):  15,000–30,000ms');
  console.log('  Long completions (1000+ tokens):       45,000–90,000ms');
  console.log('  Streaming (first token):               10,000–15,000ms');

  // --- Step 4: Re-create multiplexer with tuned timeout ---
  multiplexer.destroy();

  const tunedMultiplexer = createMultiplexer(models, {
    defaultTimeoutMs: suggestedTimeout || 15000, // Use observed data, or 15s if no data
    maxRetries: 3,
    clientConfig: { region: 'us-east-1', maxAttempts: 1 },
  });

  console.log(`\nRecreated multiplexer with timeout: ${suggestedTimeout || 15000}ms`);

  // Note: The multiplexer does NOT dynamically adjust timeouts at runtime.
  // Health metrics are observational — use them to inform config, then set
  // defaultTimeoutMs accordingly. This keeps timeout behavior deterministic.

  tunedMultiplexer.destroy();
}

main().catch(console.error);
