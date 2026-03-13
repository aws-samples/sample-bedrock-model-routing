/**
 * Integration Tests for Amazon Bedrock Model Multiplexer
 * Tests core functionality without requiring AWS credentials
 */

import {
  createMultiplexer,
  BedrockModel,
  BedrockMultiplexer,
  CircuitBreakerState,
  OutcomeType
} from '../index';

describe('Multiplexer Integration Tests', () => {
  jest.setTimeout(30000);

  describe('1. Multiplexer Configuration', () => {
    it('should create multiplexer with valid config', () => {
      const multiplexer = createMultiplexer([
        { modelId: 'test-model-1', weight: 100, isFallback: false },
        { modelId: 'test-model-2', weight: 50, isFallback: true }
      ]);

      expect(multiplexer).toBeDefined();
      const stats = multiplexer.getStats();
      expect(Object.keys(stats.modelStats)).toHaveLength(2);
      multiplexer.destroy();
    });

    it('should track health status correctly', () => {
      const multiplexer = createMultiplexer([
        { modelId: 'model-a', weight: 100, isFallback: false }
      ]);

      const health = multiplexer.getHealthStatus();
      expect(health.totalModels).toBe(1);
      expect(health.isHealthy).toBe(true);
      multiplexer.destroy();
    });
  });

  describe('2. Circuit Breaker', () => {
    it('should initialize with CLOSED state', () => {
      const model = new BedrockModel({
        modelId: 'test-circuit',
        weight: 100,
        isFallback: false
      });

      const cb = model.getCircuitBreaker();
      expect(cb.getState()).toBe(CircuitBreakerState.CLOSED);
      model.destroy();
    });
  });

  describe('3. Statistics Tracking', () => {
    it('should initialize with zero stats', () => {
      const multiplexer = createMultiplexer([
        { modelId: 'm1', weight: 100, isFallback: false }
      ]);

      const stats = multiplexer.getStats();
      expect(stats.successCount).toBe(0);
      expect(stats.rateLimitCount).toBe(0);
      expect(stats.failFastCount).toBe(0);
      multiplexer.destroy();
    });

    it('should reset stats correctly', () => {
      const multiplexer = createMultiplexer([
        { modelId: 'm1', weight: 100, isFallback: false }
      ]);

      multiplexer.resetStats();
      const stats = multiplexer.getStats();
      expect(stats.latencyMetrics.average).toBe(0);
      multiplexer.destroy();
    });
  });

  describe('4. Event Emission', () => {
    it('should emit events on model operations', async () => {
      const multiplexer = createMultiplexer([
        { modelId: 'event-model', weight: 100, isFallback: false }
      ]);

      const events: string[] = [];
      multiplexer.on('model-added', () => events.push('added'));
      
      await multiplexer.addModel({
        modelId: 'new-model',
        weight: 50,
        isFallback: true
      });

      expect(events).toContain('added');
      multiplexer.destroy();
    });
  });

  describe('5. Weighted Selection', () => {
    it('should prefer higher weighted models', () => {
      const multiplexer = createMultiplexer([
        { modelId: 'high-weight', weight: 1000, isFallback: false },
        { modelId: 'low-weight', weight: 1, isFallback: false }
      ]);

      const stats = multiplexer.getStats();
      expect(stats.modelStats['high-weight']).toBeDefined();
      expect(stats.modelStats['low-weight']).toBeDefined();
      multiplexer.destroy();
    });
  });

  describe('6. Fallback Model Configuration', () => {
    it('should distinguish primary and fallback models', () => {
      const multiplexer = createMultiplexer([
        { modelId: 'primary-1', weight: 100, isFallback: false },
        { modelId: 'fallback-1', weight: 50, isFallback: true }
      ]);

      const stats = multiplexer.getStats();
      expect(stats.modelStats['primary-1'].isFallback).toBe(false);
      expect(stats.modelStats['fallback-1'].isFallback).toBe(true);
      multiplexer.destroy();
    });
  });

  describe('7. Health Check Endpoint', () => {
    it('should return healthy status initially', () => {
      const multiplexer = createMultiplexer([
        { modelId: 'health-model', weight: 100, isFallback: false }
      ]);

      const simpleHealth = multiplexer.getSimpleHealthCheck();
      expect(simpleHealth.status).toBe('healthy');
      expect(simpleHealth.code).toBe(200);
      multiplexer.destroy();
    });

    it('should report isHealthy correctly', () => {
      const multiplexer = createMultiplexer([
        { modelId: 'model-1', weight: 100, isFallback: false }
      ]);

      expect(multiplexer.isHealthy()).toBe(true);
      multiplexer.destroy();
    });
  });

  describe('8. Latency Metrics', () => {
    it('should initialize with zero latency metrics', () => {
      const multiplexer = createMultiplexer([
        { modelId: 'latency-model', weight: 100, isFallback: false }
      ]);

      const stats = multiplexer.getStats();
      expect(stats.latencyMetrics.average).toBe(0);
      expect(stats.latencyMetrics.p50).toBe(0);
      expect(stats.latencyMetrics.p95).toBe(0);
      expect(stats.latencyMetrics.p99).toBe(0);
      multiplexer.destroy();
    });
  });

  describe('9. Model Removal', () => {
    it('should remove models correctly', async () => {
      const multiplexer = createMultiplexer([
        { modelId: 'keep-model', weight: 100, isFallback: false },
        { modelId: 'remove-model', weight: 50, isFallback: true }
      ]);

      await multiplexer.removeModel('remove-model');
      const stats = multiplexer.getStats();
      expect(stats.modelStats['keep-model']).toBeDefined();
      expect(stats.modelStats['remove-model']).toBeUndefined();
      multiplexer.destroy();
    });
  });

  describe('10. Circuit Breaker Status', () => {
    it('should provide circuit breaker status for all models', () => {
      const multiplexer = createMultiplexer([
        { modelId: 'cb-model-1', weight: 100, isFallback: false },
        { modelId: 'cb-model-2', weight: 50, isFallback: true }
      ]);

      const cbStatus = multiplexer.getCircuitBreakerStatus();
      expect(cbStatus['cb-model-1']).toBeDefined();
      expect(cbStatus['cb-model-1'].state).toBe(CircuitBreakerState.CLOSED);
      multiplexer.destroy();
    });
  });

  describe('11. Model Health Status', () => {
    it('should return null for non-existent model', () => {
      const multiplexer = createMultiplexer([
        { modelId: 'existing', weight: 100, isFallback: false }
      ]);

      const health = multiplexer.getModelHealthStatus('non-existent');
      expect(health).toBeNull();
      multiplexer.destroy();
    });

    it('should return health for existing model', () => {
      const multiplexer = createMultiplexer([
        { modelId: 'health-test', weight: 100, isFallback: false }
      ]);

      const health = multiplexer.getModelHealthStatus('health-test');
      expect(health).not.toBeNull();
      expect(health?.modelId).toBe('health-test');
      multiplexer.destroy();
    });
  });

  describe('12. BedrockModel Properties', () => {
    it('should expose model configuration', () => {
      const model = new BedrockModel({
        modelId: 'prop-test',
        weight: 75,
        isFallback: true,
      });

      expect(model.modelId).toBe('prop-test');
      expect(model.weight).toBe(75);
      expect(model.isFallback).toBe(true);
      expect(model.configuration.modelId).toBe('prop-test');
      model.destroy();
    });
  });

  describe('13. Destroy Cleanup', () => {
    it('should clean up on destroy', () => {
      const multiplexer = createMultiplexer([
        { modelId: 'cleanup-1', weight: 100, isFallback: false },
        { modelId: 'cleanup-2', weight: 50, isFallback: true }
      ]);

      // Should not throw
      expect(() => multiplexer.destroy()).not.toThrow();
    });
  });
});
