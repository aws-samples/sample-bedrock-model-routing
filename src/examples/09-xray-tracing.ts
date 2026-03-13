/**
 * Example 9: AWS X-Ray Tracing
 *
 * Demonstrates the optional X-Ray tracing integration. When enabled, the
 * multiplexer creates trace segments and subsegments for:
 *   - processRequest (main segment)
 *   - selectModel (subsegment, when captureModelSelection is true)
 *
 * Annotations include: request_id, model_count, selected_model_id, outcome, latency_ms
 * Metadata includes: error details, retry information, model selection data
 *
 * Tracing requires @aws-lambda-powertools/tracer as a peer dependency.
 * In non-Lambda environments, tracing operates in no-op mode.
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

  // Enable tracing via the config object
  const multiplexer = createMultiplexer(models, {
    maxRetries: 3,
    defaultTimeoutMs: 30000,
    clientConfig: { region: 'us-east-1', maxAttempts: 1 },
    tracing: {
      enabled: true,
      serviceName: 'my-bedrock-service',
      // Capture request/response bodies in traces — disable for sensitive data
      captureBodies: false,
      // Capture detailed model selection subsegments
      captureModelSelection: true,
    },
  });

  // Tracing-specific events — useful for correlating with X-Ray trace IDs
  multiplexer.on('model-selected', (modelId: string, isFallback: boolean, retryCount: number) => {
    console.log(`🎯 Traced: model selected = ${modelId} (retry #${retryCount})`);
  });

  multiplexer.on('model-invocation-start', (modelId: string, requestId: string) => {
    console.log(`🚀 Traced: invocation started [${requestId}] → ${modelId}`);
  });

  multiplexer.on('model-invocation-complete', (modelId: string, requestId: string, latency: number) => {
    console.log(`⏱️  Traced: invocation complete [${requestId}] → ${modelId} (${latency}ms)`);
  });

  // --- Send requests that will appear in X-Ray ---
  const inputs: Array<{ label: string; input: Omit<ConverseCommandInput, 'modelId'> }> = [
    {
      label: 'Short request',
      input: {
        messages: [{ role: 'user', content: [{ text: 'What is 2+2?' }] }],
        inferenceConfig: { maxTokens: 50 },
      },
    },
    {
      label: 'Long request',
      input: {
        messages: [{ role: 'user', content: [{ text: 'Write a comprehensive guide on machine learning.' }] }],
        inferenceConfig: { maxTokens: 4000, temperature: 0.7 },
      },
    },
  ];

  for (const { label, input } of inputs) {
    console.log(`\n--- ${label} ---`);
    try {
      await multiplexer.processRequest(input);
      console.log('✅ Success — trace segment closed with annotations');
    } catch (error: any) {
      console.log(`❌ Error — trace segment includes error metadata: ${error.message}`);
    }
  }

  // --- What appears in X-Ray ---
  console.log('\nX-Ray trace structure:');
  console.log('  BedrockMultiplexer.processRequest (segment)');
  console.log('    ├─ Annotations: request_id, model_count, outcome, latency_ms');
  console.log('    ├─ BedrockMultiplexer.selectModel (subsegment)');
  console.log('    │   └─ Annotations: selected_model_id, is_fallback');
  console.log('    └─ Metadata: error details, retry count');

  multiplexer.destroy();
}

main().catch(console.error);
