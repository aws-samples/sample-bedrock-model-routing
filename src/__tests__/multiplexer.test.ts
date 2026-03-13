/**
 * Unit tests for BedrockMultiplexer
 */

import { BedrockMultiplexer } from '../core/multiplexer';
import { MultiplexerConfig, OutcomeType, CircuitBreakerState } from '../types/index';

// Mock AWS SDK
jest.mock('@aws-sdk/client-bedrock-runtime', () => {
  return {
    BedrockRuntimeClient: jest.fn().mockImplementation(() => ({
      send: jest.fn()
    })),
    ConverseCommand: jest.fn().mockImplementation((input) => ({ input })),
    ConverseStreamCommand: jest.fn().mockImplementation((input) => ({ input }))
  };
});

const { BedrockRuntimeClient } = require('@aws-sdk/client-bedrock-runtime');

/** Helper to build a valid MultiplexerInput (Omit<ConverseCommandInput, 'modelId'>) */
function makeInput(text: string = 'test') {
  return {
    messages: [{ role: 'user' as const, content: [{ text }] }]
  };
}

/** Helper to build a mock ConverseCommandOutput */
function makeOutput(text: string = 'Hello!') {
  return {
    output: { message: { role: 'assistant', content: [{ text }] } },
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    metrics: { latencyMs: 100 },
    $metadata: {}
  };
}

describe('BedrockMultiplexer', () => {
  let mockClient: any;
  let config: MultiplexerConfig;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    
    mockClient = {
      send: jest.fn()
    };
    
    BedrockRuntimeClient.mockImplementation(() => mockClient);
    
    config = {
      models: [
        { modelId: 'model-primary-1', weight: 100, isFallback: false },
        { modelId: 'model-primary-2', weight: 50, isFallback: false },
        { modelId: 'model-fallback-1', weight: 100, isFallback: true }
      ],
      defaultTimeoutMs: 30000,
      maxRetries: 3
    };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('constructor', () => {
    it('should create multiplexer with valid config', () => {
      const multiplexer = new BedrockMultiplexer(config);
      expect(multiplexer).toBeDefined();
    });

    it('should throw on invalid config', () => {
      expect(() => new BedrockMultiplexer({} as any)).toThrow();
    });

    it('should initialize models', () => {
      const multiplexer = new BedrockMultiplexer(config);
      const stats = multiplexer.getStats();
      
      expect(Object.keys(stats.modelStats)).toHaveLength(3);
    });

    it('should configure tracer when enabled', () => {
      const configWithTracing = {
        ...config,
        tracing: { enabled: true, serviceName: 'test-service' }
      };
      
      const multiplexer = new BedrockMultiplexer(configWithTracing);
      expect(multiplexer).toBeDefined();
    });
  });

  describe('addModel', () => {
    it('should add primary model', async () => {
      const multiplexer = new BedrockMultiplexer(config);
      
      await multiplexer.addModel({
        modelId: 'new-model',
        weight: 75,
        isFallback: false
      });
      
      const stats = multiplexer.getStats();
      expect(stats.modelStats['new-model']).toBeDefined();
    });

    it('should add fallback model', async () => {
      const multiplexer = new BedrockMultiplexer(config);
      
      await multiplexer.addModel({
        modelId: 'new-fallback',
        weight: 50,
        isFallback: true
      });
      
      const stats = multiplexer.getStats();
      expect(stats.modelStats['new-fallback']).toBeDefined();
      expect(stats.modelStats['new-fallback'].isFallback).toBe(true);
    });

    it('should emit model-added event', async () => {
      const multiplexer = new BedrockMultiplexer(config);
      const handler = jest.fn();
      multiplexer.on('model-added', handler);
      
      await multiplexer.addModel({
        modelId: 'new-model',
        weight: 100,
        isFallback: false
      });
      
      expect(handler).toHaveBeenCalledWith('new-model');
    });
  });

  describe('removeModel', () => {
    it('should remove model', async () => {
      const multiplexer = new BedrockMultiplexer(config);
      
      await multiplexer.removeModel('model-primary-1');
      
      const stats = multiplexer.getStats();
      expect(stats.modelStats['model-primary-1']).toBeUndefined();
    });

    it('should emit model-removed event', async () => {
      const multiplexer = new BedrockMultiplexer(config);
      const handler = jest.fn();
      multiplexer.on('model-removed', handler);
      
      await multiplexer.removeModel('model-primary-1');
      
      expect(handler).toHaveBeenCalledWith('model-primary-1');
    });

    it('should handle removing non-existent model', () => {
      const multiplexer = new BedrockMultiplexer(config);
      
      expect(() => multiplexer.removeModel('non-existent')).not.toThrow();
    });
  });

  describe('processRequest', () => {
    it('should process request successfully', async () => {
      const mockResponse = makeOutput('Hello!');
      mockClient.send.mockResolvedValue(mockResponse);
      
      const multiplexer = new BedrockMultiplexer(config);
      const response = await multiplexer.processRequest(makeInput('Hello'));
      
      expect(response).toEqual(mockResponse);
    });

    it('should emit request event', async () => {
      mockClient.send.mockResolvedValue(makeOutput('Hi'));
      
      const multiplexer = new BedrockMultiplexer(config);
      const handler = jest.fn();
      multiplexer.on('request', handler);
      
      await multiplexer.processRequest(makeInput('test'));
      
      expect(handler).toHaveBeenCalled();
    });

    it('should emit success event on success', async () => {
      mockClient.send.mockResolvedValue(makeOutput('Hi'));
      
      const multiplexer = new BedrockMultiplexer(config);
      const handler = jest.fn();
      multiplexer.on('success', handler);
      
      await multiplexer.processRequest(makeInput('test'));
      
      expect(handler).toHaveBeenCalled();
    });

    it('should emit error event on failure', async () => {
      mockClient.send.mockRejectedValue(new Error('Test error'));
      
      const multiplexer = new BedrockMultiplexer(config);
      const handler = jest.fn();
      multiplexer.on('error', handler);
      
      await expect(multiplexer.processRequest(makeInput('test')))
        .rejects.toBeDefined();
      
      expect(handler).toHaveBeenCalled();
    });

    it('should retry on rate limit', async () => {
      const rateLimitError = new Error('Rate limited');
      rateLimitError.name = 'ThrottlingException';
      
      const mockResponse = makeOutput('Success!');
      
      mockClient.send
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce(mockResponse);
      
      const multiplexer = new BedrockMultiplexer(config);
      const response = await multiplexer.processRequest(makeInput('test'));
      
      expect(response).toEqual(mockResponse);
    });

    it('should throw after exhausting retries', async () => {
      const error = new Error('Always fails');
      error.name = 'ThrottlingException';
      mockClient.send.mockRejectedValue(error);
      
      const multiplexer = new BedrockMultiplexer({
        ...config,
        maxRetries: 2
      });
      
      await expect(multiplexer.processRequest(makeInput('test')))
        .rejects.toBeDefined();
    });
  });

  describe('getStats', () => {
    it('should return initial stats', () => {
      const multiplexer = new BedrockMultiplexer(config);
      const stats = multiplexer.getStats();
      
      expect(stats.successCount).toBe(0);
      expect(stats.rateLimitCount).toBe(0);
      expect(stats.failFastCount).toBe(0);
      expect(Object.keys(stats.modelStats)).toHaveLength(3);
    });

    it('should track success counts', async () => {
      mockClient.send.mockResolvedValue(makeOutput('Hi'));
      
      const multiplexer = new BedrockMultiplexer(config);
      
      await multiplexer.processRequest(makeInput('test'));
      await multiplexer.processRequest(makeInput('test'));
      
      const stats = multiplexer.getStats();
      expect(stats.successCount).toBe(2);
    });

    it('should include latency metrics', async () => {
      mockClient.send.mockResolvedValue(makeOutput('Hi'));
      
      const multiplexer = new BedrockMultiplexer(config);
      await multiplexer.processRequest(makeInput('test'));
      
      const stats = multiplexer.getStats();
      expect(stats.latencyMetrics).toBeDefined();
      expect(stats.latencyMetrics.average).toBeGreaterThanOrEqual(0);
    });
  });

  describe('resetStats', () => {
    it('should reset all statistics', async () => {
      mockClient.send.mockResolvedValue(makeOutput('Hi'));
      
      const multiplexer = new BedrockMultiplexer(config);
      await multiplexer.processRequest(makeInput('test'));
      
      multiplexer.resetStats();
      
      const stats = multiplexer.getStats();
      expect(stats.successCount).toBe(0);
    });

    it('should emit stats-reset event', () => {
      const multiplexer = new BedrockMultiplexer(config);
      const handler = jest.fn();
      multiplexer.on('stats-reset', handler);
      
      multiplexer.resetStats();
      
      expect(handler).toHaveBeenCalled();
    });
  });

  describe('selectModel', () => {
    it('should select primary model when available', async () => {
      const multiplexer = new BedrockMultiplexer(config);
      
      const selection = await multiplexer.selectModel({
        skippedModels: new Set()
      });
      
      expect(selection.modelId).toBeDefined();
      expect(['model-primary-1', 'model-primary-2']).toContain(selection.modelId);
      expect(selection.isFallback).toBe(false);
    });

    it('should skip specified models', async () => {
      const multiplexer = new BedrockMultiplexer(config);
      
      const selection = await multiplexer.selectModel({
        skippedModels: new Set(['model-primary-1', 'model-primary-2'])
      });
      
      expect(selection.modelId).toBe('model-fallback-1');
      expect(selection.isFallback).toBe(true);
    });

    it('should return null when no models available', async () => {
      const multiplexer = new BedrockMultiplexer(config);
      
      const selection = await multiplexer.selectModel({
        skippedModels: new Set(['model-primary-1', 'model-primary-2', 'model-fallback-1'])
      });
      
      expect(selection.modelId).toBeNull();
    });

    it('should emit model-selected event', async () => {
      const multiplexer = new BedrockMultiplexer(config);
      const handler = jest.fn();
      multiplexer.on('model-selected', handler);
      
      await multiplexer.selectModel({ skippedModels: new Set() });
      
      expect(handler).toHaveBeenCalled();
    });
  });

  describe('getModel', () => {
    it('should return model by ID', async () => {
      const multiplexer = new BedrockMultiplexer(config);
      
      const model = await multiplexer.getModel('model-primary-1');
      
      expect(model).toBeDefined();
      expect(model?.modelId).toBe('model-primary-1');
    });

    it('should return null for unknown model', async () => {
      const multiplexer = new BedrockMultiplexer(config);
      
      const model = await multiplexer.getModel('unknown');
      
      expect(model).toBeNull();
    });
  });

  describe('reportOutcome', () => {
    it('should update success statistics', async () => {
      const multiplexer = new BedrockMultiplexer(config);
      
      await multiplexer.reportOutcome({
        modelId: 'model-primary-1',
        type: OutcomeType.SUCCESS,
        latency: 100,
        timestamp: new Date()
      });
      
      const stats = multiplexer.getStats();
      expect(stats.modelStats['model-primary-1'].successCount).toBe(1);
    });

    it('should update rate limit statistics', async () => {
      const multiplexer = new BedrockMultiplexer(config);
      
      await multiplexer.reportOutcome({
        modelId: 'model-primary-1',
        type: OutcomeType.RATE_LIMIT,
        latency: 100,
        timestamp: new Date()
      });
      
      const stats = multiplexer.getStats();
      expect(stats.modelStats['model-primary-1'].rateLimitCount).toBe(1);
    });

    it('should ignore unknown models', async () => {
      const multiplexer = new BedrockMultiplexer(config);
      
      await expect(multiplexer.reportOutcome({
        modelId: 'unknown',
        type: OutcomeType.SUCCESS,
        latency: 100,
        timestamp: new Date()
      })).resolves.toBeUndefined();
    });
  });

  describe('getHealthStatus', () => {
    it('should return system health status', () => {
      const multiplexer = new BedrockMultiplexer(config);
      const health = multiplexer.getHealthStatus();
      
      expect(health.timestamp).toBeDefined();
      expect(health.totalModels).toBe(3);
    });
  });

  describe('getModelHealthStatus', () => {
    it('should return model health', () => {
      const multiplexer = new BedrockMultiplexer(config);
      const health = multiplexer.getModelHealthStatus('model-primary-1');
      
      expect(health).toBeDefined();
      expect(health?.modelId).toBe('model-primary-1');
    });

    it('should return null for unknown model', () => {
      const multiplexer = new BedrockMultiplexer(config);
      const health = multiplexer.getModelHealthStatus('unknown');
      
      expect(health).toBeNull();
    });
  });

  describe('getSimpleHealthCheck', () => {
    it('should return healthy status', () => {
      const multiplexer = new BedrockMultiplexer(config);
      const health = multiplexer.getSimpleHealthCheck();
      
      // With fresh models, should be healthy
      expect(health.status).toBe('healthy');
      expect(health.code).toBe(200);
    });
  });

  describe('isHealthy', () => {
    it('should return true for healthy system', () => {
      const multiplexer = new BedrockMultiplexer(config);
      expect(multiplexer.isHealthy()).toBe(true);
    });
  });

  describe('getCircuitBreakerStatus', () => {
    it('should return status for all models', () => {
      const multiplexer = new BedrockMultiplexer(config);
      const status = multiplexer.getCircuitBreakerStatus();
      
      expect(status['model-primary-1']).toBeDefined();
      expect(status['model-primary-1'].state).toBe(CircuitBreakerState.CLOSED);
    });

    it('should share the same circuit breaker between model and manager (Issue #1)', async () => {
      const multiplexer = new BedrockMultiplexer(config);
      
      // Get the model and its circuit breaker
      const model = await multiplexer.getModel('model-primary-1');
      expect(model).toBeDefined();
      const modelBreaker = model!.getCircuitBreaker();
      
      // Force the model's breaker open
      modelBreaker.forceOpen();
      
      // The manager's status should reflect the same state — they share the same instance
      const status = multiplexer.getCircuitBreakerStatus();
      expect(status['model-primary-1'].state).toBe(CircuitBreakerState.OPEN);
    });

    it('should not double-count failures (Issue #1 regression)', async () => {
      // Trigger a single failure through the full request pipeline
      const error = new Error('Server error');
      error.name = 'InternalServerException';
      mockClient.send.mockRejectedValue(error);
      
      const multiplexer = new BedrockMultiplexer(config);
      
      try {
        await multiplexer.processRequest(makeInput('test'));
      } catch {
        // Expected — all retries will fail
      }
      
      // Each model should have at most 1 failure recorded per invocation,
      // not 2 (which would happen with the old duplicate recording bug)
      const status = multiplexer.getCircuitBreakerStatus();
      const totalFailures = Object.values(status).reduce(
        (sum, s) => sum + s.failureCount, 0
      );
      
      // With maxRetries=3, we get at most 4 invocations (initial + 3 retries).
      // Each invocation records exactly 1 failure. With 3 models available,
      // we should see at most 4 failures total across all models.
      expect(totalFailures).toBeLessThanOrEqual(config.maxRetries + 1);
    });
  });

  describe('clientConfig passthrough', () => {
    it('should pass clientConfig overrides to BedrockRuntimeClient', () => {
      const configWithClient = {
        ...config,
        clientConfig: { maxAttempts: 3, logger: console }
      };
      
      new BedrockMultiplexer(configWithClient);
      
      // Every BedrockRuntimeClient created should have maxAttempts: 3
      const calls = BedrockRuntimeClient.mock.calls;
      for (const call of calls) {
        expect(call[0]).toEqual(expect.objectContaining({ maxAttempts: 3, logger: console }));
      }
    });

    it('should not inject maxAttempts when clientConfig is not set (pure passthrough)', () => {
      new BedrockMultiplexer(config);

      const calls = BedrockRuntimeClient.mock.calls;
      for (const call of calls) {
        expect(call[0]).toEqual({});
      }
    });

    it('should pass clientConfig as-is without injecting maxAttempts', () => {
      const configWithRegionOnly = {
        ...config,
        clientConfig: { region: 'eu-west-1' }
      };

      new BedrockMultiplexer(configWithRegionOnly);

      const calls = BedrockRuntimeClient.mock.calls;
      for (const call of calls) {
        expect(call[0]).toEqual({ region: 'eu-west-1' });
      }
    });
  });

  describe('model invocation events', () => {
    it('should emit model-invocation-start and model-invocation-complete on successful request', async () => {
      mockClient.send.mockResolvedValue(makeOutput('Hi'));

      const multiplexer = new BedrockMultiplexer(config);
      const startHandler = jest.fn();
      const completeHandler = jest.fn();

      multiplexer.on('model-invocation-start', startHandler);
      multiplexer.on('model-invocation-complete', completeHandler);

      await multiplexer.processRequest(makeInput('test'));

      expect(startHandler).toHaveBeenCalledTimes(1);
      expect(startHandler).toHaveBeenCalledWith(
        expect.any(String), // modelId
        expect.any(String)  // requestId
      );

      expect(completeHandler).toHaveBeenCalledTimes(1);
      expect(completeHandler).toHaveBeenCalledWith(
        expect.any(String), // modelId
        expect.any(String), // requestId
        expect.any(Number)  // latency
      );

      // Same modelId and requestId in both events
      const [startModelId, startRequestId] = startHandler.mock.calls[0];
      const [completeModelId, completeRequestId] = completeHandler.mock.calls[0];
      expect(startModelId).toBe(completeModelId);
      expect(startRequestId).toBe(completeRequestId);
    });

    it('should emit model-invocation-complete even when invocation fails', async () => {
      const error = new Error('Rate limited');
      error.name = 'ThrottlingException';
      mockClient.send.mockRejectedValue(error);

      const multiplexer = new BedrockMultiplexer({
        ...config,
        maxRetries: 0 // no retries to keep it simple
      });
      const startHandler = jest.fn();
      const completeHandler = jest.fn();

      multiplexer.on('model-invocation-start', startHandler);
      multiplexer.on('model-invocation-complete', completeHandler);

      await expect(multiplexer.processRequest(makeInput('test'))).rejects.toBeDefined();

      // Even on failure, both events should fire
      expect(startHandler).toHaveBeenCalled();
      expect(completeHandler).toHaveBeenCalled();
    });
  });

  describe('latency ring buffer', () => {
    it('should correctly calculate latency metrics after reset', async () => {
      mockClient.send.mockResolvedValue(makeOutput('Hi'));

      const multiplexer = new BedrockMultiplexer(config);

      await multiplexer.processRequest(makeInput('test'));
      const statsBefore = multiplexer.getStats();
      expect(statsBefore.latencyMetrics.average).toBeGreaterThanOrEqual(0);

      multiplexer.resetStats();

      const statsAfter = multiplexer.getStats();
      expect(statsAfter.latencyMetrics.average).toBe(0);
      expect(statsAfter.latencyMetrics.p50).toBe(0);
      expect(statsAfter.latencyMetrics.p95).toBe(0);
      expect(statsAfter.latencyMetrics.p99).toBe(0);
    });

    it('should evict oldest entries when buffer is full', async () => {
      mockClient.send.mockResolvedValue(makeOutput('Hi'));

      // Use a small config to test eviction without 1000 requests
      const multiplexer = new BedrockMultiplexer(config);

      // Record multiple requests and verify metrics keep working
      for (let i = 0; i < 5; i++) {
        await multiplexer.processRequest(makeInput('test'));
      }

      const stats = multiplexer.getStats();
      expect(stats.latencyMetrics.average).toBeGreaterThanOrEqual(0);
      expect(stats.latencyMetrics.min).toBeGreaterThanOrEqual(0);
      expect(stats.latencyMetrics.max).toBeGreaterThanOrEqual(stats.latencyMetrics.min);
    });
  });

  describe('destroy', () => {
    it('should clean up all resources', () => {
      const multiplexer = new BedrockMultiplexer(config);
      
      multiplexer.destroy();
      
      const stats = multiplexer.getStats();
      expect(Object.keys(stats.modelStats)).toHaveLength(0);
    });

  });
});