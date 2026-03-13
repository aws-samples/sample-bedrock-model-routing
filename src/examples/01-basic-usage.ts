/**
 * Example 1: Basic Usage
 *
 * Demonstrates the minimum setup needed to route a single Converse API
 * request through the multiplexer. You provide models with weights,
 * construct a standard ConverseCommandInput (minus modelId), and get
 * back a standard ConverseCommandOutput.
 */
import 'dotenv/config';
import { ConverseCommandInput } from '@aws-sdk/client-bedrock-runtime';
import { createMultiplexer, ModelConfiguration } from 'bedrock-model-multiplexer';

async function main(): Promise<void> {
  // 1. Define models — only multiplexer-owned concerns: modelId, weight, isFallback
  const models: ModelConfiguration[] = [
    { modelId: 'amazon.nova-2-lite-v1:0',   weight: 100, isFallback: false },
    { modelId: 'amazon.nova-pro-v1:0',    weight: 30,  isFallback: true  },
  ];

  // 2. Create the multiplexer — AWS SDK settings go in clientConfig (opaque passthrough)
  // clientConfig.maxAttempts: 1 disables SDK-level retries so the multiplexer
  // can fail over to a different model immediately instead of retrying the
  // same throttled model.
  const multiplexer = createMultiplexer(models, {
    defaultTimeoutMs: 30000,
    maxRetries: 3,
    clientConfig: { region: 'us-east-1', maxAttempts: 1 },
  });

  // 3. Build a standard ConverseCommandInput (minus modelId — the multiplexer stamps it)
  const input: Omit<ConverseCommandInput, 'modelId'> = {
    messages: [
      { role: 'user', content: [{ text: 'Explain quantum computing in one paragraph.' }] },
    ],
    inferenceConfig: { maxTokens: 300, temperature: 0.7 },
  };

  try {
    // 4. Send it — the multiplexer picks a model via weighted routing
    const response = await multiplexer.processRequest(input);

    // response is a plain ConverseCommandOutput — no wrapper types
    const assistantText = response.output?.message?.content?.[0]?.text;
    console.log('Assistant:', assistantText);
  } catch (error: any) {
    console.error('Request failed:', error.message);
  } finally {
    // 5. Destroy when done — cleans up timers and circuit breakers
    multiplexer.destroy();
  }
}

main().catch(console.error);
