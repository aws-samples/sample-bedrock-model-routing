/**
 * Example 8: Statistics and Monitoring
 *
 * Demonstrates getStats() for cumulative request statistics and per-model
 * breakdowns. Stats are useful for dashboards, alerting, and understanding
 * traffic patterns.
 *
 * For real-time health assessments (circuit breaker state, error rates),
 * see 05-health-checks.ts instead.
 */
import 'dotenv/config';
import { ConverseCommandInput } from '@aws-sdk/client-bedrock-runtime';
import { createMultiplexer, ModelConfiguration } from 'bedrock-model-multiplexer';

async function main(): Promise<void> {
  const models: ModelConfiguration[] = [
    { modelId: 'amazon.nova-2-lite-v1:0',   weight: 100, isFallback: false },
    { modelId: 'amazon.titan-text-express-v1', weight: 50, isFallback: false },
    { modelId: 'amazon.nova-pro-v1:0',    weight: 30,  isFallback: true  },
  ];

  const multiplexer = createMultiplexer(models, {
    maxRetries: 3,
    clientConfig: { region: 'us-east-1', maxAttempts: 1 },
  });

  // --- Send some traffic ---
  const questions = [
    'What is 2+2?',
    'Explain gravity in one sentence.',
    'Name three programming languages.',
    'What color is the sky?',
    'Define photosynthesis briefly.',
  ];

  for (const q of questions) {
    const input: Omit<ConverseCommandInput, 'modelId'> = {
      messages: [{ role: 'user', content: [{ text: q }] }],
      inferenceConfig: { maxTokens: 100 },
    };
    try {
      await multiplexer.processRequest(input);
    } catch {
      // Expected in demo environment
    }
  }

  // --- Aggregate statistics ---
  const stats = multiplexer.getStats();

  console.log('Overall statistics:');
  console.log(`  Successes:    ${stats.successCount}`);
  console.log(`  Rate limits:  ${stats.rateLimitCount}`);
  console.log(`  Fail-fast:    ${stats.failFastCount}`);

  const total = stats.successCount + stats.rateLimitCount + stats.failFastCount;
  const successRate = total > 0 ? (stats.successCount / total * 100).toFixed(1) : 'N/A';
  console.log(`  Success rate: ${successRate}%`);

  // --- Latency metrics ---
  console.log('\nLatency metrics:');
  console.log(`  Average: ${stats.latencyMetrics.average.toFixed(1)}ms`);
  console.log(`  P50:     ${stats.latencyMetrics.p50}ms`);
  console.log(`  P95:     ${stats.latencyMetrics.p95}ms`);
  console.log(`  P99:     ${stats.latencyMetrics.p99}ms`);
  console.log(`  Min:     ${stats.latencyMetrics.min}ms`);
  console.log(`  Max:     ${stats.latencyMetrics.max}ms`);

  // --- Per-model statistics ---
  console.log('\nPer-model statistics:');
  for (const [modelId, modelStats] of Object.entries(stats.modelStats)) {
    console.log(`  ${modelId}:`);
    console.log(`    Successes:   ${modelStats.successCount}`);
    console.log(`    Rate limits: ${modelStats.rateLimitCount}`);
    console.log(`    Fail-fast:   ${modelStats.failFastCount}`);
    console.log(`    Avg latency: ${modelStats.averageLatency.toFixed(1)}ms`);
    console.log(`    Is fallback: ${modelStats.isFallback}`);
  }

  // --- Periodic monitoring with the 'stats' event ---
  console.log('\nYou can also subscribe to periodic stats events:');
  console.log("  multiplexer.on('stats', (stats) => { ... });");
  console.log('Stats are emitted after each completed request.\n');

  // --- Reset stats ---
  multiplexer.resetStats();
  console.log('Stats reset. New counts:');
  const reset = multiplexer.getStats();
  console.log(`  Successes: ${reset.successCount}, Rate limits: ${reset.rateLimitCount}`);

  multiplexer.destroy();
}

main().catch(console.error);
