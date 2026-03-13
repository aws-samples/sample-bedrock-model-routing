/**
 * Example 2: Weighted Selection
 *
 * Demonstrates how model weights control traffic distribution.
 * Higher weight = more likely to be selected. Primary models are
 * tried first; fallback models are only used when all primaries
 * are unavailable (circuit breakers open or skipped).
 */
import 'dotenv/config';
import { ConverseCommandInput } from '@aws-sdk/client-bedrock-runtime';
import { createMultiplexer, ModelConfiguration } from 'bedrock-model-multiplexer';

async function main(): Promise<void> {
  // Weights control selection probability within each pool (primary vs fallback).
  // Given weights [100, 50], the first model is selected ~67% of the time
  // and the second ~33% — the formula is: P(model) = weight / totalWeight.
  const models: ModelConfiguration[] = [
    { modelId: 'amazon.nova-2-lite-v1:0',   weight: 100, isFallback: false },
    { modelId: 'amazon.titan-text-express-v1', weight: 50, isFallback: false },
    // Fallback pool — only used when both primaries are unavailable
    { modelId: 'amazon.nova-pro-v1:0',    weight: 30,  isFallback: true  },
  ];

  const multiplexer = createMultiplexer(models, {
    maxRetries: 3,
    clientConfig: { region: 'us-east-1', maxAttempts: 1 },
  });

  // Track which models get selected across many requests
  const selectionCounts: Record<string, number> = {};

  multiplexer.on('model-invocation-start', (modelId: string) => {
    selectionCounts[modelId] = (selectionCounts[modelId] || 0) + 1;
  });

  // Send 20 requests and observe the distribution
  const input: Omit<ConverseCommandInput, 'modelId'> = {
    messages: [
      { role: 'user', content: [{ text: 'Hello' }] },
    ],
    inferenceConfig: { maxTokens: 50 },
  };

  for (let i = 0; i < 20; i++) {
    try {
      await multiplexer.processRequest(input);
    } catch {
      // Expected — we're observing selection, not responses
    }
  }

  // Print selection distribution
  console.log('Model selection distribution across 20 requests:');
  const total = Object.values(selectionCounts).reduce((a, b) => a + b, 0);
  for (const [modelId, count] of Object.entries(selectionCounts)) {
    const pct = ((count / total) * 100).toFixed(1);
    console.log(`  ${modelId}: ${count} selections (${pct}%)`);
  }

  multiplexer.destroy();
}

main().catch(console.error);
