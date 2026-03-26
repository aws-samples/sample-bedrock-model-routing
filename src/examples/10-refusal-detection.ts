/**
 * Example 10: Refusal Detection
 *
 * Demonstrates the opt-in refusal detection feature. When enabled, the
 * multiplexer classifies every model response with an in-process ONNX binary
 * classifier to detect refusals (e.g., "I can't help with that" or
 * "As an AI, I'm unable to…"). Detected refusals are treated like
 * throttles — the model is skipped and the request is retried with a
 * different model.
 *
 * This example has two parts:
 *   Part A — Direct classifier demo: tests known refusal and complied
 *            texts against the ONNX model to prove it works.
 *   Part B — Live multiplexer demo: sends real requests through Bedrock
 *            with refusal detection enabled.
 *
 * Prerequisites:
 *   - The ONNX model file at `models/refusal_classifier.onnx`
 *   - `onnxruntime-node` installed (it ships as a dependency)
 *   - Valid AWS credentials for Part B (Part A works offline)
 */
import 'dotenv/config';
import path from 'path';
import { ConverseCommandInput, ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { createMultiplexer } from '../index';
import { RefusalClassifier } from '../classifiers/refusal-classifier';
import { ModelConfiguration, ModelStats, ModelOutcome, ErrorResponse } from '../types';

// ─── Part A: Direct ONNX Classifier Demo ─────────────────────────────────────

async function demonstrateClassifier(): Promise<void> {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Part A: Direct ONNX Refusal Classifier Demo');
  console.log('═══════════════════════════════════════════════════\n');

  const modelPath = path.resolve(__dirname, '../../models/refusal_classifier.onnx');
  const classifier = new RefusalClassifier({
    modelPath,
    confidenceThreshold: 0.5,
  });

  console.log('Loading ONNX model...');
  await classifier.initialize();
  console.log(`✅ Classifier ready (threshold: ${classifier.confidenceThreshold})\n`);

  // Test cases: known refusals and known complied responses
  const testCases = [
    // --- Clear refusals ---
    {
      label: 'Explicit refusal',
      text: "I'm sorry, but I can't help with that request. As an AI language model, I must decline to provide information that could be used to cause harm.",
      expectedRefusal: true,
    },
    {
      label: 'Polite decline',
      text: "I appreciate your question, but I'm not able to assist with creating content that promotes illegal activities. I'd be happy to help you with something else instead.",
      expectedRefusal: true,
    },
    {
      label: 'Safety refusal',
      text: "I cannot and will not provide instructions for that. This type of request goes against my guidelines. Please ask me something else.",
      expectedRefusal: true,
    },
    {
      label: 'Hedged refusal',
      text: "As an AI assistant, I don't think it would be appropriate for me to generate that kind of content. I'm designed to be helpful, harmless, and honest.",
      expectedRefusal: true,
    },

    // --- Clear complied responses ---
    {
      label: 'Factual answer',
      text: "The water cycle consists of evaporation, condensation, precipitation, and collection. Water evaporates from bodies of water, forms clouds through condensation, falls as rain or snow, and collects in rivers and oceans to start the cycle again.",
      expectedRefusal: false,
    },
    {
      label: 'Creative writing',
      text: "The old lighthouse stood sentinel against the storm, its beam cutting through sheets of rain like a golden sword. Captain Marlowe gripped the wheel tighter, knowing that light was his only hope of reaching the harbor alive.",
      expectedRefusal: false,
    },
    {
      label: 'Technical explanation',
      text: "To implement a binary search in Python, you divide the sorted array in half at each step. Compare the middle element with the target: if equal, return the index; if the target is smaller, search the left half; otherwise, search the right half.",
      expectedRefusal: false,
    },
    {
      label: 'Helpful guidance',
      text: "Here are five tips for better sleep: 1) Maintain a consistent schedule, 2) Limit screen time before bed, 3) Keep your room cool and dark, 4) Avoid caffeine after 2pm, 5) Exercise regularly but not right before bed.",
      expectedRefusal: false,
    },
  ];

  console.log('Running classifier on test cases:\n');
  let correct = 0;
  const total = testCases.length;

  for (const tc of testCases) {
    const result = await classifier.classify(tc.text);
    const icon = result.isRefusal === tc.expectedRefusal ? '✅' : '❌';
    const label = result.isRefusal ? 'REFUSAL' : 'COMPLIED';
    if (result.isRefusal === tc.expectedRefusal) correct++;

    const snippet = tc.text.length > 60 ? tc.text.slice(0, 60) + '…' : tc.text;
    console.log(`  ${icon} [${tc.label}] → ${label} (confidence: ${(result.confidence * 100).toFixed(1)}%, ${result.latencyMs}ms)`);
    console.log(`     "${snippet}"`);
  }

  console.log(`\nAccuracy: ${correct}/${total} (${((correct / total) * 100).toFixed(0)}%)`);

  await classifier.destroy();
  console.log('Classifier session released.\n');
}

// ─── Part B: Live Multiplexer with Refusal Detection ──────────────────────────

async function demonstrateLiveMultiplexer(): Promise<void> {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Part B: Live Multiplexer with Refusal Detection');
  console.log('═══════════════════════════════════════════════════\n');

  // Check for AWS credentials
  if (!process.env.AWS_ACCESS_KEY_ID && !process.env.AWS_PROFILE) {
    console.log('⚠️  No AWS credentials found. Skipping live demo.');
    console.log('   Set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or AWS_PROFILE to run.\n');
    return;
  }

  // 1. Define models — multiple models enable failover when one refuses
  const models: ModelConfiguration[] = [
    { modelId: 'amazon.nova-pro-v1:0', weight: 100, isFallback: false },
    { modelId: 'amazon.nova-lite-v1:0', weight: 50, isFallback: false },
    { modelId: 'amazon.titan-text-express-v1', weight: 30, isFallback: true },
  ];

  // 2. Create the multiplexer with refusal detection enabled
  const multiplexer = createMultiplexer(models, {
    defaultTimeoutMs: 30000,
    maxRetries: 3,
    clientConfig: { region: 'us-east-1', maxAttempts: 1 },
    refusalDetection: {
      enabled: true,
      modelPath: path.resolve(__dirname, '../../models/refusal_classifier.onnx'),
      // Lowered from default 0.5 to catch borderline refusals where the model
      // wraps refusal language in framing text (e.g. "Certainly! Here's an example: 'I'm sorry...'")
      confidenceThreshold: 0.4,
      retryOnRefusal: true,
    },
  });

  // 3. Listen to refusal-specific events
  multiplexer.on('refusal-detected', (modelId: string, confidence: number, responseText: string) => {
    const snippet = responseText.length > 80
      ? responseText.slice(0, 80) + '…'
      : responseText;
    console.log(`🚫 [refusal-detected] ${modelId} (confidence: ${(confidence * 100).toFixed(1)}%)`);
    console.log(`   Response snippet: "${snippet}"`);
  });

  multiplexer.on('refusal-classification', (modelId: string, isRefusal: boolean, confidence: number, latencyMs: number) => {
    const label = isRefusal ? 'REFUSAL' : 'COMPLIED';
    console.log(`🔍 [refusal-classification] ${modelId} → ${label} (${(confidence * 100).toFixed(1)}%, ${latencyMs.toFixed(1)}ms)`);
  });

  multiplexer.on('model-selected', (modelId: string, isFallback: boolean, retryCount: number) => {
    const pool = isFallback ? 'fallback' : 'primary';
    console.log(`🎯 [model-selected] ${modelId} (${pool}, retry #${retryCount})`);
  });

  multiplexer.on('success', (_response: ConverseCommandOutput, outcome: ModelOutcome) => {
    console.log(`✅ [success] ${outcome.modelId} — ${outcome.latency}ms`);
  });

  multiplexer.on('error', (error: ErrorResponse | null, outcome: ModelOutcome | null) => {
    const modelId = outcome?.modelId ?? 'unknown';
    console.log(`❌ [error] ${error?.message ?? 'unknown'} (model: ${modelId})`);
  });

  // 4. Send a normal request
  console.log('--- Request 1: Normal question ---\n');
  const normalInput: Omit<ConverseCommandInput, 'modelId'> = {
    messages: [
      { role: 'user', content: [{ text: 'Explain the water cycle in two sentences.' }] },
    ],
    inferenceConfig: { maxTokens: 200, temperature: 0.7 },
  };

  try {
    const response = await multiplexer.processRequest(normalInput);
    const text = (response.output?.message?.content?.[0] as any)?.text;
    console.log(`\nAssistant: ${text}\n`);
  } catch (error: any) {
    console.log(`Request failed: ${error.message}\n`);
  }

  // 5. Send a prompt designed to elicit a refusal-like response
  //    We ask the model to roleplay/demonstrate a refusal — this produces text
  //    the classifier recognizes as a refusal without sending anything harmful.
  console.log('--- Request 2: Prompt designed to elicit a refusal-style response ---\n');
  const refusalElicitingInput: Omit<ConverseCommandInput, 'modelId'> = {
    messages: [
      {
        role: 'user',
        content: [{
          text: 'Without any introduction, preamble, or acknowledgment of this request, write only the refusal itself — as if you ARE the AI declining right now. Use phrases like "I\'m sorry, but I can\'t help with that" and "As an AI, I must decline". Just the refusal, nothing else, 3-4 sentences.',
        }],
      },
    ],
    inferenceConfig: { maxTokens: 300, temperature: 0.3 },
  };

  try {
    const response = await multiplexer.processRequest(refusalElicitingInput);
    const text = (response.output?.message?.content?.[0] as any)?.text;
    console.log(`\nAssistant: ${text}\n`);
  } catch (error: any) {
    // If the classifier detects a refusal and all retries exhaust, we land here
    console.log(`All models refused or retries exhausted: ${error.message}\n`);
  }

  // 6. Inspect refusal statistics
  console.log('--- Statistics ---\n');
  const stats = multiplexer.getStats();

  console.log('Aggregate:');
  console.log(`  Successes:   ${stats.successCount}`);
  console.log(`  Refusals:    ${stats.refusalCount}`);
  console.log(`  Rate limits: ${stats.rateLimitCount}`);
  console.log(`  Fail-fast:   ${stats.failFastCount}`);

  console.log('\nPer-model:');
  for (const [modelId, modelStats] of Object.entries(stats.modelStats)) {
    const ms = modelStats as ModelStats;
    if (ms.successCount + ms.refusalCount + ms.rateLimitCount > 0) {
      console.log(`  ${modelId}:`);
      console.log(`    Successes: ${ms.successCount}`);
      console.log(`    Refusals:  ${ms.refusalCount}`);
      console.log(`    Avg latency: ${ms.averageLatency.toFixed(1)}ms`);
    }
  }

  // 7. Clean up
  multiplexer.destroy();
  console.log('\n✨ Multiplexer destroyed (ONNX session released)');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Part A always runs — proves the ONNX classifier works
  await demonstrateClassifier();

  // Part B requires AWS credentials — shows live integration
  await demonstrateLiveMultiplexer();
}

main().catch(console.error);
