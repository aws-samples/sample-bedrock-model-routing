/**
 * Unit tests for health-check utility
 */

import { HealthCheckManager, HealthCheckEndpoint } from '../utils/health-check';
import { CircuitBreakerManager } from '../utils/circuit-breaker';
import { CircuitBreakerState, ModelStats } from '../types/index';

describe('HealthCheckManager', () => {
  let circuitBreakerManager: CircuitBreakerManager;
  let healthManager: HealthCheckManager;

  beforeEach(() => {
    circuitBreakerManager = new CircuitBreakerManager({ failureThreshold: 3 });
    healthManager = new HealthCheckManager(circuitBreakerManager, 60000, 1000);
  });

  describe('constructor', () => {
    it('should create health manager with default values', () => {
      const manager = new HealthCheckManager(circuitBreakerManager);
      expect(manager).toBeDefined();
    });

    it('should create health manager with custom values', () => {
      const manager = new HealthCheckManager(circuitBreakerManager, 30000, 500);
      expect(manager).toBeDefined();
    });
  });

  describe('recordSuccess', () => {
    it('should record successful request', () => {
      healthManager.recordSuccess('model-1', 100);
      const health = healthManager.getModelHealth('model-1');
      
      expect(health.isHealthy).toBe(true);
      expect(health.lastSuccessAt).toBeDefined();
    });

    it('should update response time metrics', () => {
      healthManager.recordSuccess('model-1', 100);
      healthManager.recordSuccess('model-1', 200);
      healthManager.recordSuccess('model-1', 300);
      
      const health = healthManager.getModelHealth('model-1');
      expect(health.avgResponseTimeMs).toBe(200);
    });
  });

  describe('recordFailure', () => {
    it('should record failed request', () => {
      healthManager.recordFailure('model-1', 100);
      const health = healthManager.getModelHealth('model-1');
      
      expect(health.lastFailureAt).toBeDefined();
    });

    it('should update error rate', () => {
      healthManager.recordSuccess('model-1', 100);
      healthManager.recordFailure('model-1', 100);
      
      const health = healthManager.getModelHealth('model-1');
      expect(health.errorRate).toBe(0.5);
    });
  });

  describe('getModelHealth', () => {
    it('should return health for unknown model', () => {
      const health = healthManager.getModelHealth('unknown');
      
      expect(health.modelId).toBe('unknown');
      expect(health.isHealthy).toBe(true);
      expect(health.errorRate).toBe(0);
    });

    it('should include circuit breaker state', () => {
      const health = healthManager.getModelHealth('model-1');
      expect(health.circuitState).toBe(CircuitBreakerState.CLOSED);
    });

    it('should use model stats for average latency when no metrics', () => {
      const modelStats: ModelStats = {
        modelId: 'model-1',
        successCount: 10,
        rateLimitCount: 0,
        failFastCount: 0,
        refusalCount: 0,
        averageLatency: 150,
        isFallback: false
      };
      
      const health = healthManager.getModelHealth('model-1', modelStats);
      expect(health.avgResponseTimeMs).toBe(150);
    });

    it('should mark unhealthy when circuit is open', () => {
      // Open the circuit
      circuitBreakerManager.recordFailure('model-1');
      circuitBreakerManager.recordFailure('model-1');
      circuitBreakerManager.recordFailure('model-1');
      
      const health = healthManager.getModelHealth('model-1');
      expect(health.isHealthy).toBe(false);
      expect(health.circuitState).toBe(CircuitBreakerState.OPEN);
    });

    it('should mark unhealthy when error rate is high', () => {
      healthManager.recordFailure('model-1', 100);
      healthManager.recordFailure('model-1', 100);
      healthManager.recordSuccess('model-1', 100);
      
      const health = healthManager.getModelHealth('model-1');
      // Error rate is 0.67, which is > 0.5
      expect(health.isHealthy).toBe(false);
    });
  });

  describe('getSystemHealth', () => {
    it('should return system health with no models', () => {
      const health = healthManager.getSystemHealth();
      
      expect(health.timestamp).toBeDefined();
      expect(health.totalModels).toBe(0);
      expect(health.isHealthy).toBe(false); // No healthy models
    });

    it('should aggregate model health', () => {
      healthManager.registerModel('model-1');
      healthManager.registerModel('model-2');
      
      healthManager.recordSuccess('model-1', 100);
      healthManager.recordSuccess('model-2', 200);
      
      const health = healthManager.getSystemHealth();
      
      expect(health.totalModels).toBe(2);
      expect(health.healthyModels).toBe(2);
      expect(health.unhealthyModels).toBe(0);
      expect(health.isHealthy).toBe(true);
    });

    it('should track degraded models', () => {
      healthManager.registerModel('model-1');
      
      // Open circuit then advance to half-open (simulate recovery)
      circuitBreakerManager.recordFailure('model-1');
      circuitBreakerManager.recordFailure('model-1');
      circuitBreakerManager.recordFailure('model-1');
      
      const health = healthManager.getSystemHealth();
      expect(health.unhealthyModels).toBeGreaterThan(0);
    });

    it('should calculate overall metrics', () => {
      healthManager.recordSuccess('model-1', 100);
      healthManager.recordSuccess('model-1', 200);
      healthManager.recordFailure('model-1', 100);
      
      const modelStats = {
        'model-1': {
          modelId: 'model-1',
          successCount: 2,
          rateLimitCount: 0,
          failFastCount: 1,
          refusalCount: 0,
          averageLatency: 133,
          isFallback: false
        }
      };
      
      const health = healthManager.getSystemHealth(modelStats);
      
      expect(health.metrics.totalRequests).toBe(3);
      expect(health.metrics.successRate).toBeCloseTo(0.67, 1);
    });

    it('should be unhealthy when majority of models are unhealthy', () => {
      healthManager.registerModel('model-1');
      healthManager.registerModel('model-2');
      healthManager.registerModel('model-3');
      
      // Open circuit breakers for 2 out of 3 models
      circuitBreakerManager.recordFailure('model-1');
      circuitBreakerManager.recordFailure('model-1');
      circuitBreakerManager.recordFailure('model-1');
      circuitBreakerManager.recordFailure('model-2');
      circuitBreakerManager.recordFailure('model-2');
      circuitBreakerManager.recordFailure('model-2');
      
      const health = healthManager.getSystemHealth();
      
      // 2 out of 3 models have open circuit breakers
      expect(health.isHealthy).toBe(false);
    });

    it('should be unhealthy with 3 models and 1 unhealthy (odd count floor division)', () => {
      // This tests the Math.floor fix: with 3 models, floor(3/2)=1,
      // so 1 unhealthy is NOT less than 1 → system is unhealthy.
      // Before the fix, JS floating-point division gave 1.5, and 1 < 1.5 → healthy (wrong).
      healthManager.registerModel('model-1');
      healthManager.registerModel('model-2');
      healthManager.registerModel('model-3');
      
      healthManager.recordSuccess('model-1', 100);
      healthManager.recordSuccess('model-2', 100);
      
      // Open circuit breaker for model-3
      circuitBreakerManager.recordFailure('model-3');
      circuitBreakerManager.recordFailure('model-3');
      circuitBreakerManager.recordFailure('model-3');
      
      const health = healthManager.getSystemHealth();
      
      // floor(3/2) = 1, unhealthyCount = 1, 1 < 1 = false → unhealthy
      expect(health.unhealthyModels).toBe(1);
      expect(health.isHealthy).toBe(false);
    });

    it('should be unhealthy with 5 models and 2 unhealthy (odd count floor division)', () => {
      // floor(5/2) = 2, unhealthyCount = 2, 2 < 2 = false → unhealthy
      healthManager.registerModel('model-1');
      healthManager.registerModel('model-2');
      healthManager.registerModel('model-3');
      healthManager.registerModel('model-4');
      healthManager.registerModel('model-5');
      
      healthManager.recordSuccess('model-1', 100);
      healthManager.recordSuccess('model-2', 100);
      healthManager.recordSuccess('model-3', 100);
      
      // Open circuit breakers for model-4 and model-5
      circuitBreakerManager.recordFailure('model-4');
      circuitBreakerManager.recordFailure('model-4');
      circuitBreakerManager.recordFailure('model-4');
      circuitBreakerManager.recordFailure('model-5');
      circuitBreakerManager.recordFailure('model-5');
      circuitBreakerManager.recordFailure('model-5');
      
      const health = healthManager.getSystemHealth();
      
      expect(health.unhealthyModels).toBe(2);
      expect(health.isHealthy).toBe(false);
    });

    it('should be healthy with 1 model that is healthy (single-model edge case)', () => {
      // max(1, floor(1/2)) = max(1, 0) = 1, unhealthyCount = 0, 0 < 1 = true → healthy
      // Without Math.max, floor(1/2) = 0 would give 0 < 0 = false → broken for single-model
      healthManager.registerModel('model-1');
      healthManager.recordSuccess('model-1', 100);
      
      const health = healthManager.getSystemHealth();
      
      expect(health.totalModels).toBe(1);
      expect(health.healthyModels).toBe(1);
      expect(health.unhealthyModels).toBe(0);
      expect(health.isHealthy).toBe(true);
    });

    it('should be healthy with 4 models and 1 unhealthy (even count — no change)', () => {
      // floor(4/2) = 2, unhealthyCount = 1, 1 < 2 = true → healthy
      healthManager.registerModel('model-1');
      healthManager.registerModel('model-2');
      healthManager.registerModel('model-3');
      healthManager.registerModel('model-4');
      
      healthManager.recordSuccess('model-1', 100);
      healthManager.recordSuccess('model-2', 100);
      healthManager.recordSuccess('model-3', 100);
      
      // Open circuit breaker for model-4
      circuitBreakerManager.recordFailure('model-4');
      circuitBreakerManager.recordFailure('model-4');
      circuitBreakerManager.recordFailure('model-4');
      
      const health = healthManager.getSystemHealth();
      
      expect(health.unhealthyModels).toBe(1);
      expect(health.isHealthy).toBe(true);
    });
  });

  describe('resetModelMetrics', () => {
    it('should reset metrics for specific model', () => {
      healthManager.recordSuccess('model-1', 100);
      healthManager.recordSuccess('model-2', 200);
      
      healthManager.resetModelMetrics('model-1');
      
      const health1 = healthManager.getModelHealth('model-1');
      const health2 = healthManager.getModelHealth('model-2');
      
      expect(health1.requestsPerMinute).toBe(0);
      expect(health2.requestsPerMinute).toBe(1);
    });
  });

  describe('resetAllMetrics', () => {
    it('should reset all metrics', () => {
      healthManager.recordSuccess('model-1', 100);
      healthManager.recordSuccess('model-2', 200);
      
      healthManager.resetAllMetrics();
      
      const health1 = healthManager.getModelHealth('model-1');
      const health2 = healthManager.getModelHealth('model-2');
      
      expect(health1.requestsPerMinute).toBe(0);
      expect(health2.requestsPerMinute).toBe(0);
    });
  });

  describe('registerModel', () => {
    it('should register a model', () => {
      healthManager.registerModel('new-model');
      
      const health = healthManager.getModelHealth('new-model');
      expect(health.modelId).toBe('new-model');
    });

    it('should not duplicate registration', () => {
      healthManager.registerModel('model-1');
      healthManager.recordSuccess('model-1', 100);
      healthManager.registerModel('model-1');
      
      const health = healthManager.getModelHealth('model-1');
      expect(health.requestsPerMinute).toBe(1);
    });
  });

  describe('unregisterModel', () => {
    it('should unregister a model', () => {
      healthManager.registerModel('model-1');
      healthManager.recordSuccess('model-1', 100);
      
      healthManager.unregisterModel('model-1');
      
      const health = healthManager.getModelHealth('model-1');
      expect(health.requestsPerMinute).toBe(0);
    });
  });

  describe('isSystemAcceptingRequests', () => {
    it('should return true when system is healthy', () => {
      healthManager.registerModel('model-1');
      healthManager.registerModel('model-2');
      healthManager.recordSuccess('model-1', 100);
      healthManager.recordSuccess('model-2', 100);
      
      expect(healthManager.isSystemAcceptingRequests()).toBe(true);
    });

    it('should return false when no healthy models', () => {
      expect(healthManager.isSystemAcceptingRequests()).toBe(false);
    });

    it('should return false when all models have open circuit breakers', () => {
      healthManager.registerModel('model-1');
      
      // Open the circuit breaker
      circuitBreakerManager.recordFailure('model-1');
      circuitBreakerManager.recordFailure('model-1');
      circuitBreakerManager.recordFailure('model-1');
      
      expect(healthManager.isSystemAcceptingRequests()).toBe(false);
    });
  });
});

describe('HealthCheckEndpoint', () => {
  let circuitBreakerManager: CircuitBreakerManager;
  let healthManager: HealthCheckManager;
  let endpoint: HealthCheckEndpoint;

  beforeEach(() => {
    circuitBreakerManager = new CircuitBreakerManager();
    healthManager = new HealthCheckManager(circuitBreakerManager);
    endpoint = new HealthCheckEndpoint(healthManager);
  });

  describe('getSimpleHealth', () => {
    it('should return unhealthy when no models', () => {
      const result = endpoint.getSimpleHealth();
      
      expect(result.status).toBe('unhealthy');
      expect(result.code).toBe(503);
    });

    it('should return healthy when system is healthy', () => {
      healthManager.registerModel('model-1');
      healthManager.registerModel('model-2');
      healthManager.recordSuccess('model-1', 100);
      healthManager.recordSuccess('model-2', 100);
      
      const result = endpoint.getSimpleHealth();
      
      expect(result.status).toBe('healthy');
      expect(result.code).toBe(200);
    });

    it('should return unhealthy when all models have open circuit breakers', () => {
      healthManager.registerModel('model-1');
      
      // Open the circuit breaker (default threshold is 5)
      for (let i = 0; i < 5; i++) {
        circuitBreakerManager.recordFailure('model-1');
      }
      
      const result = endpoint.getSimpleHealth();
      
      expect(result.status).toBe('unhealthy');
      expect(result.code).toBe(503);
    });
  });

  describe('getDetailedHealth', () => {
    it('should return system health status', () => {
      healthManager.registerModel('model-1');
      healthManager.recordSuccess('model-1', 100);
      
      const result = endpoint.getDetailedHealth();
      
      expect(result.timestamp).toBeDefined();
      expect(result.totalModels).toBe(1);
      expect(result.models['model-1']).toBeDefined();
    });
  });

  describe('getModelHealth', () => {
    it('should return model health status', () => {
      healthManager.registerModel('model-1');
      healthManager.recordSuccess('model-1', 100);
      
      const modelStats: ModelStats = {
        modelId: 'model-1',
        successCount: 1,
        rateLimitCount: 0,
        failFastCount: 0,
        refusalCount: 0,
        averageLatency: 100,
        isFallback: false
      };
      
      const result = endpoint.getModelHealth('model-1', modelStats);
      
      expect(result.modelId).toBe('model-1');
      expect(result.isHealthy).toBe(true);
    });
  });
});
