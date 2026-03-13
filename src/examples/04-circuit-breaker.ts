/**
 * Example 4: Circuit Breaker
 *
 * Demonstrates the per-model circuit breaker lifecycle:
 *   CLOSED → OPEN → HALF_OPEN → CLOSED (or back to OPEN)
 *
 * Default thresholds:
 *   - failureThreshold: 5 failures within failureWindowMs (60s) → OPEN
 *   - recoveryTimeMs: 30s in OPEN → transition to HALF_OPEN
 *   - successThreshold: 2 consecutive successes in HALF_OPEN → CLOSED
 *
 * The multiplexer skips OPEN models during selection; HALF_OPEN models
 * are eligible (probe requests to test recovery).
 */
import 'dotenv/config';
import { createMultiplexer, ModelConfiguration, CircuitBreakerState } from 'bedrock-model-multiplexer';

async function main(): Promise<void> {
  const models: ModelConfiguration[] = [
    { modelId: 'amazon.nova-2-lite-v1:0',   weight: 100, isFallback: false },
    { modelId: 'amazon.nova-pro-v1:0',    weight: 30,  isFallback: true  },
  ];

  const multiplexer = createMultiplexer(models, {
    maxRetries: 3,
    clientConfig: { region: 'us-east-1', maxAttempts: 1 },
  });

  // --- Inspecting circuit breaker state ---
  const breakerStatus = multiplexer.getCircuitBreakerStatus();
  console.log('Initial circuit breaker states:');
  for (const [modelId, status] of Object.entries(breakerStatus)) {
    console.log(`  ${modelId}: ${status.state} (failures: ${status.failureCount})`);
  }

  // --- Understanding state transitions ---
  console.log('\nCircuit breaker state machine:');
  console.log('  CLOSED  → models accept traffic normally');
  console.log('  OPEN    → models are skipped during selection (no requests sent)');
  console.log('  HALF_OPEN → models accept probe requests to test recovery');
  console.log('');
  console.log('  CLOSED → OPEN:     5 failures within 60s window');
  console.log('  OPEN → HALF_OPEN:  30s recovery timer expires');
  console.log('  HALF_OPEN → CLOSED: 2 consecutive successes');
  console.log('  HALF_OPEN → OPEN:   any failure');

  // --- Watch for circuit breaker events ---
  multiplexer.on('model-circuit-open-skipped', (modelId: string) => {
    console.log(`\n⚡ ${modelId} was skipped — circuit breaker is OPEN`);
    console.log('   The model will be re-eligible after the 30s recovery window.');
  });

  // --- Checking individual model state ---
  const modelHealth = multiplexer.getModelHealthStatus('amazon.nova-2-lite-v1:0');
  if (modelHealth) {
    console.log(`\nDetailed health for nova-lite:`);
    console.log(`  Circuit state: ${modelHealth.circuitState}`);
    console.log(`  Error rate: ${(modelHealth.errorRate * 100).toFixed(1)}%`);
    console.log(`  Avg response time: ${modelHealth.avgResponseTimeMs.toFixed(0)}ms`);
  }

  multiplexer.destroy();
}

main().catch(console.error);
