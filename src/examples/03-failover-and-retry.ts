/**
 * Example 3: Failover and Retry
 *
 * Demonstrates cross-model failover behaviour. When a model returns a
 * ThrottlingException (rate limit), the multiplexer immediately skips it
 * and selects a different model — zero delay, no same-model retry.
 *
 * Key behaviours:
 * - RATE_LIMIT errors → skip model, try next (cross-model failover)
 * - FAIL_FAST errors (ValidationException, etc.) → fail immediately, no retry
 * - Timeout errors → fail immediately, no cross-model failover
 * - CircuitOpen errors → skip model, try next
 * - No models available → throw 503 MultiplexerError
 */
import 'dotenv/config';
import { ConverseCommandInput } from '@aws-sdk/client-bedrock-runtime';
import { createMultiplexer, ModelConfiguration, MultiplexerError } from 'bedrock-model-multiplexer';

async function main(): Promise<void> {
  const models: ModelConfiguration[] = [
    { modelId: 'amazon.nova-2-lite-v1:0',   weight: 100, isFallback: false },
    { modelId: 'amazon.titan-text-express-v1', weight: 50, isFallback: false },
    { modelId: 'amazon.nova-pro-v1:0',    weight: 30,  isFallback: true  },
  ];

  // maxRetries controls how many cross-model failover attempts the multiplexer
  // makes (not to be confused with clientConfig.maxAttempts which controls
  // SDK-level same-model retries). With maxRetries: 1, the multiplexer gets
  // 1 initial attempt + 1 retry = 2 models tried before giving up.
  //
  // clientConfig.maxAttempts: 1 disables SDK-level retries so the multiplexer
  // can fail over to a different model immediately instead of retrying the
  // same throttled model.
  const multiplexer = createMultiplexer(models, {
    maxRetries: 3,
    maxAttempts: 1, // disables SDK-level retries so the multiplexer can fail
    clientConfig: { region: 'us-east-1', maxAttempts: 1 },
  });

  // Watch the failover sequence
  multiplexer.on('model-invocation-start', (modelId: string, requestId: string) => {
    console.log(`  🚀 Trying model: ${modelId} [${requestId}]`);
  });

  multiplexer.on('model-circuit-open-skipped', (modelId: string) => {
    console.log(`  ⏭️  Skipped (circuit open): ${modelId}`);
  });

  const input: Omit<ConverseCommandInput, 'modelId'> = {
    messages: [
      { role: 'user', content: [{ text: 'Tell me a joke' }] },
    ],
    inferenceConfig: { maxTokens: 200 },
  };

  console.log('Sending request — watch the failover sequence:');
  try {
    const response = await multiplexer.processRequest(input);
    console.log('✅ Request succeeded');
  } catch (error: any) {
    // Distinguish multiplexer-level errors from SDK errors
    if (error instanceof MultiplexerError) {
      // 503: no models available, or retries exhausted
      console.log(`❌ Multiplexer error: ${error.message} (code: ${error.code})`);
      console.log('   This means no healthy models remain — check circuit breaker status.');
    } else {
      // SDK error from the last model tried (e.g., ValidationException)
      console.log(`❌ SDK error: ${error.name}: ${error.message}`);
    }
  }

  // --- Caller-side retry for 503 (all models down) ---
  console.log('\nDemonstrating caller-side retry with backoff:');

  async function callWithRetry(
    input: Omit<ConverseCommandInput, 'modelId'>,
    maxAttempts = 3,
    baseDelayMs = 1000
  ): Promise<void> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await multiplexer.processRequest(input);
        console.log('  ✅ Succeeded on attempt', attempt + 1);
        return;
      } catch (error: any) {
        if (error instanceof MultiplexerError && error.code === 'NO_MODELS_AVAILABLE' && attempt < maxAttempts - 1) {
          const delay = baseDelayMs * Math.pow(2, attempt);
          console.log(`  ⏳ All models down — waiting ${delay}ms before retry ${attempt + 2}`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        throw error;
      }
    }
  }

  try {
    await callWithRetry(input);
  } catch (error: any) {
    console.log(`  ❌ Gave up after retries: ${error.message}`);
  }

  multiplexer.destroy();
}

main().catch(console.error);
