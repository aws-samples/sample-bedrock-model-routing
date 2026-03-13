/**
 * Example 5: Health Checks
 *
 * Demonstrates the health check API — a purely observational layer that
 * reads circuit breaker state and request metrics. Useful for load balancer
 * probes, dashboards, and timeout calibration.
 *
 * The health API never influences routing or failover decisions — the
 * circuit breaker is the active resilience mechanism.
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

  // --- Simple health check (for ALB/NLB probes) ---
  const simple = multiplexer.getSimpleHealthCheck();
  console.log('Simple health check:', simple);
  // { status: 'healthy', code: 200 }   or   { status: 'unhealthy', code: 503 }

  // Express integration:
  //   app.get('/health', (req, res) => {
  //     const { status, code } = multiplexer.getSimpleHealthCheck();
  //     res.status(code).json({ status });
  //   });

  // --- Convenience boolean ---
  console.log('Is healthy:', multiplexer.isHealthy());

  // --- Detailed system health ---
  const health = multiplexer.getHealthStatus();

  console.log('\nSystem-wide summary:');
  console.log('  Total models:', health.totalModels);
  console.log('  Healthy:', health.healthyModels);
  console.log('  Degraded (HALF_OPEN):', health.degradedModels);
  console.log('  Unhealthy (OPEN):', health.unhealthyModels);

  console.log('\nSystem-wide metrics:');
  console.log('  Avg latency:', health.metrics.averageLatencyMs.toFixed(1), 'ms');
  console.log('  P99 latency:', health.metrics.p99LatencyMs.toFixed(1), 'ms');
  console.log('  Success rate:', (health.metrics.successRate * 100).toFixed(1) + '%');

  // --- Per-model health ---
  console.log('\nPer-model health:');
  for (const [modelId, model] of Object.entries(health.models)) {
    console.log(`  ${modelId}:`);
    console.log(`    Circuit: ${model.circuitState}`);
    console.log(`    Healthy: ${model.isHealthy}`);
    console.log(`    Error rate: ${(model.errorRate * 100).toFixed(1)}%`);
    console.log(`    Avg response: ${model.avgResponseTimeMs.toFixed(0)}ms`);
    console.log(`    Requests/min: ${model.requestsPerMinute}`);
  }

  // --- Single model health ---
  const novaHealth = multiplexer.getModelHealthStatus('amazon.nova-2-lite-v1:0');
  if (novaHealth) {
    console.log(`\nNova Lite circuit state: ${novaHealth.circuitState}`);
    console.log(`Nova Lite last success: ${novaHealth.lastSuccessAt ?? 'never'}`);
    console.log(`Nova Lite last failure: ${novaHealth.lastFailureAt ?? 'never'}`);
  }

  // --- Health formula explained ---
  // A model is healthy when:
  //   circuitState !== OPEN  AND  errorRate < 0.5
  //
  // The system is healthy when:
  //   unhealthyCount < max(1, floor(totalModels / 2))  AND  healthyCount > 0
  //
  // For a single-model deployment: max(1, floor(1/2)) = max(1, 0) = 1
  //   so "0 < 1" is true as long as that one model is healthy.

  multiplexer.destroy();
}

main().catch(console.error);
