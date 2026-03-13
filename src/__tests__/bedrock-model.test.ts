/**
 * Unit tests for BedrockModel
 */

import { BedrockModel } from '../models/bedrock-model';
import { ModelConfiguration, OutcomeType, CircuitBreakerState } from '../types/index';

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

const { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand } = require('@aws-sdk/client-bedrock-runtime');

/** Helper to build a valid MultiplexerInput (Omit<ConverseCommandInput, 'modelId'>) */
function makeInput(text: string = 'Hello') {
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

describe('BedrockModel', () => {
  let mockClient: any;
  let config: ModelConfiguration;

  beforeEach(() => {
    jest.clearAllMocks();
    
    mockClient = {
      send: jest.fn()
    };
    
    BedrockRuntimeClient.mockImplementation(() => mockClient);
    
    config = {
      modelId: 'amazon.nova-2-lite-v1:0',
      weight: 100,
      isFallback: false,
    };
  });

  describe('constructor', () => {
    it('should create model with config', () => {
      const model = new BedrockModel(config);
      expect(model.modelId).toBe('amazon.nova-2-lite-v1:0');
      expect(model.weight).toBe(100);
      expect(model.isFallback).toBe(false);
    });

    it('should create model with custom client', () => {
      const customClient = {
        send: jest.fn()
      };
      
      const model = new BedrockModel(config, customClient as any);
      expect(model.getClient()).toBe(customClient);
    });

    it('should pass region via clientConfig to BedrockRuntimeClient', () => {
      new BedrockModel(config, undefined, 30000, undefined, { region: 'us-west-2' });
      
      expect(BedrockRuntimeClient).toHaveBeenCalledWith(
        expect.objectContaining({ region: 'us-west-2' })
      );
    });

    it('should pass endpoint via clientConfig to BedrockRuntimeClient', () => {
      new BedrockModel(config, undefined, 30000, undefined, { endpoint: 'https://custom.endpoint.com' });
      
      expect(BedrockRuntimeClient).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: 'https://custom.endpoint.com' })
      );
    });

    it('should not add middleware to client (Issue #14: dead middleware removed)', () => {
      new BedrockModel(config);
      
      // No middlewareStack interaction — middleware was dead code and has been removed
      expect(mockClient.send).not.toHaveBeenCalled();
    });

    it('should not inject maxAttempts by default (pure passthrough)', () => {
      new BedrockModel(config);
      
      // Empty clientConfig — the SDK resolves maxAttempts from env/shared config
      expect(BedrockRuntimeClient).toHaveBeenCalledWith({});
    });

    it('should pass clientConfig overrides to BedrockRuntimeClient', () => {
      new BedrockModel(config, undefined, 30000, undefined, { maxAttempts: 3, logger: console });
      
      expect(BedrockRuntimeClient).toHaveBeenCalledWith(
        expect.objectContaining({ maxAttempts: 3, logger: console })
      );
    });

    it('should pass multiple clientConfig properties to BedrockRuntimeClient', () => {
      new BedrockModel(config, undefined, 30000, undefined, {
        region: 'eu-west-1',
        endpoint: 'https://custom.endpoint.com',
        maxAttempts: 1
      });
      
      expect(BedrockRuntimeClient).toHaveBeenCalledWith(
        expect.objectContaining({ region: 'eu-west-1', endpoint: 'https://custom.endpoint.com', maxAttempts: 1 })
      );
    });

    it('should not create a new client when custom client is provided', () => {
      const customClient = {
        send: jest.fn()
      };
      
      // When a custom client is provided, clientConfig is ignored
      new BedrockModel(config, customClient as any, 30000, undefined, { maxAttempts: 5 });
      
      // custom client is used as-is
      expect(customClient).toBe(customClient);
    });
  });

  describe('modelId getter', () => {
    it('should return model ID', () => {
      const model = new BedrockModel(config);
      expect(model.modelId).toBe('amazon.nova-2-lite-v1:0');
    });
  });

  describe('configuration getter', () => {
    it('should return copy of config', () => {
      const model = new BedrockModel(config);
      const returnedConfig = model.configuration;
      
      expect(returnedConfig).toEqual(config);
      expect(returnedConfig).not.toBe(config); // Should be a copy
    });
  });

  describe('isFallback getter', () => {
    it('should return false for primary model', () => {
      const model = new BedrockModel(config);
      expect(model.isFallback).toBe(false);
    });

    it('should return true for fallback model', () => {
      const fallbackConfig = { ...config, isFallback: true };
      const model = new BedrockModel(fallbackConfig);
      expect(model.isFallback).toBe(true);
    });
  });

  describe('weight getter', () => {
    it('should return weight', () => {
      const model = new BedrockModel(config);
      expect(model.weight).toBe(100);
    });
  });

  describe('getCircuitBreaker', () => {
    it('should return circuit breaker', () => {
      const model = new BedrockModel(config);
      const cb = model.getCircuitBreaker();
      
      expect(cb).toBeDefined();
      expect(cb.getState()).toBe(CircuitBreakerState.CLOSED);
    });

    it('should create its own breaker when none injected', () => {
      const model = new BedrockModel(config);
      const cb = model.getCircuitBreaker();
      expect(cb).toBeDefined();
      expect(cb.getState()).toBe(CircuitBreakerState.CLOSED);
    });

    it('should use injected circuit breaker when provided', () => {
      const { CircuitBreaker } = require('../utils/circuit-breaker');
      const injectedBreaker = new CircuitBreaker('amazon.nova-2-lite-v1:0', {});
      
      const model = new BedrockModel(config, undefined, 30000, injectedBreaker);
      
      // The model's breaker should be the exact same instance
      expect(model.getCircuitBreaker()).toBe(injectedBreaker);
    });

    it('should record failures to the injected breaker', async () => {
      const { CircuitBreaker } = require('../utils/circuit-breaker');
      const injectedBreaker = new CircuitBreaker('amazon.nova-2-lite-v1:0', {});
      
      const error = new Error('Server error');
      error.name = 'InternalServerException';
      mockClient.send.mockRejectedValue(error);
      
      const model = new BedrockModel(config, undefined, 30000, injectedBreaker);
      
      try {
        await model.invoke(makeInput('test'));
      } catch {
        // Expected
      }
      
      // Failure should be recorded on the injected breaker
      expect(injectedBreaker.getStatus().failureCount).toBe(1);
    });

    it('should record successes to the injected breaker', async () => {
      const { CircuitBreaker } = require('../utils/circuit-breaker');
      const injectedBreaker = new CircuitBreaker('amazon.nova-2-lite-v1:0', {});
      
      mockClient.send.mockResolvedValue(makeOutput('Hello!'));
      
      const model = new BedrockModel(config, undefined, 30000, injectedBreaker);
      await model.invoke(makeInput('test'));
      
      // Success should be recorded on the injected breaker (state stays CLOSED)
      expect(injectedBreaker.getState()).toBe(CircuitBreakerState.CLOSED);
    });
  });

  describe('invoke', () => {
    it('should invoke model and return response', async () => {
      const mockResponse = makeOutput('Hello!');
      mockClient.send.mockResolvedValue(mockResponse);
      
      const model = new BedrockModel(config);
      const result = await model.invoke(makeInput('Hello'));
      
      expect(result.response).toEqual(mockResponse);
      expect(result.outcome.type).toBe(OutcomeType.SUCCESS);
      expect(result.outcome.modelId).toBe('amazon.nova-2-lite-v1:0');
      expect(result.outcome.latency).toBeGreaterThanOrEqual(0);
    });

    it('should throw circuit open error when circuit is open', async () => {
      const model = new BedrockModel(config);
      model.getCircuitBreaker().forceOpen();
      
      await expect(model.invoke(makeInput('test')))
        .rejects.toThrow(/circuit/i);
    });

    it('should handle rate limit error', async () => {
      const error = new Error('Rate limited');
      error.name = 'ThrottlingException';
      mockClient.send.mockRejectedValue(error);
      
      const model = new BedrockModel(config);
      
      await expect(model.invoke(makeInput('test')))
        .rejects.toMatchObject({
          name: 'RateLimitError'
        });
    });

    it('should record circuit breaker failure on rate limit', async () => {
      const error = new Error('Rate limited');
      error.name = 'ThrottlingException';
      mockClient.send.mockRejectedValue(error);
      
      const model = new BedrockModel(config);
      
      try {
        await model.invoke(makeInput('test'));
      } catch {
        // Expected RateLimitError
      }
      
      // Rate limit should count as a circuit breaker failure
      const status = model.getCircuitBreaker().getStatus();
      expect(status.failureCount).toBe(1);
    });

    it('should handle fail-fast error', async () => {
      const error = new Error('Validation failed');
      error.name = 'ValidationException';
      mockClient.send.mockRejectedValue(error);
      
      const model = new BedrockModel(config);
      
      await expect(model.invoke(makeInput('test')))
        .rejects.toMatchObject({
          name: 'FailFastError'
        });
    });

    it('should record failure in circuit breaker', async () => {
      const error = new Error('Server error');
      error.name = 'InternalServerException';
      mockClient.send.mockRejectedValue(error);
      
      const model = new BedrockModel(config);
      
      try {
        await model.invoke(makeInput('test'));
      } catch {
        // Expected
      }
      
      const status = model.getCircuitBreaker().getStatus();
      expect(status.failureCount).toBe(1);
    });

    it('should record success in circuit breaker', async () => {
      mockClient.send.mockResolvedValue(makeOutput('Hello!'));
      
      const model = new BedrockModel(config);
      await model.invoke(makeInput('test'));
      
      const status = model.getCircuitBreaker().getStatus();
      expect(status.state).toBe(CircuitBreakerState.CLOSED);
    });

    it('should handle abort signal', async () => {
      const abortController = new AbortController();
      abortController.abort();
      
      const model = new BedrockModel(config);
      
      await expect(model.invoke(makeInput('test'), abortController.signal))
        .rejects.toThrow(/cancel/i);
    });

    it('should handle timeout', async () => {
      // Simulate a slow response
      mockClient.send.mockImplementation(() => 
        new Promise(resolve => setTimeout(resolve, 5000))
      );
      
      const model = new BedrockModel(config, undefined, 100);
      
      await expect(model.invoke(makeInput('test')))
        .rejects.toThrow(/timed out/i);
    }, 10000);

    it('should stamp modelId onto the ConverseCommand', async () => {
      mockClient.send.mockResolvedValue(makeOutput('Hi'));
      
      const model = new BedrockModel(config);
      await model.invoke(makeInput('test'));
      
      // ConverseCommand should be called with modelId and messages
      expect(ConverseCommand).toHaveBeenCalled();
      const callArgs = ConverseCommand.mock.calls[0][0];
      expect(callArgs.modelId).toBe('amazon.nova-2-lite-v1:0');
      expect(callArgs.messages).toBeDefined();
    });
  });

  describe('invokeStream', () => {
    it('should throw when circuit is open', async () => {
      const model = new BedrockModel(config);
      model.getCircuitBreaker().forceOpen();
      
      await expect(model.invokeStream(makeInput('test')))
        .rejects.toThrow(/circuit/i);
    });

    it('should return raw SDK ConverseStreamCommandOutput (passthrough)', async () => {
      // Create mock async iterator for stream
      const mockStream = (async function* () {
        yield { contentBlockDelta: { delta: { text: 'Hello' } } };
        yield { contentBlockDelta: { delta: { text: ' World' } } };
        yield { messageStop: { stopReason: 'end_turn' } };
      })();
      
      const mockResponse = {
        stream: mockStream,
        $metadata: { httpStatusCode: 200 }
      };
      
      mockClient.send.mockResolvedValue(mockResponse);
      
      const model = new BedrockModel(config);
      const response = await model.invokeStream(makeInput('test'));
      
      // Should return the raw SDK response — no wrapper types
      expect(response).toBe(mockResponse);
      expect(response.stream).toBeDefined();
      expect(response.$metadata).toBeDefined();
    });

    it('should allow consumers to iterate raw SDK stream events', async () => {
      const mockStream = (async function* () {
        yield { contentBlockDelta: { delta: { text: 'Hello' } } };
        yield { contentBlockDelta: { delta: { text: ' World' } } };
        yield { 
          metadata: { usage: { inputTokens: 10, outputTokens: 5 } }
        };
        yield { messageStop: { stopReason: 'end_turn' } };
      })();
      
      mockClient.send.mockResolvedValue({
        stream: mockStream,
        $metadata: {}
      });
      
      const model = new BedrockModel(config);
      const response = await model.invokeStream(makeInput('test'));
      
      // Consumer iterates SDK stream events directly
      const events: any[] = [];
      for await (const event of response.stream!) {
        events.push(event);
      }
      
      expect(events.length).toBe(4);
      expect(events[0].contentBlockDelta.delta.text).toBe('Hello');
      expect(events[3].messageStop.stopReason).toBe('end_turn');
    });

    it('should record success in circuit breaker on successful stream', async () => {
      mockClient.send.mockResolvedValue({
        stream: (async function* () {})(),
        $metadata: {}
      });
      
      const model = new BedrockModel(config);
      await model.invokeStream(makeInput('test'));
      
      expect(model.getCircuitBreaker().getState()).toBe(CircuitBreakerState.CLOSED);
    });

    it('should record failure in circuit breaker on stream error', async () => {
      const error = new Error('Stream failed');
      mockClient.send.mockRejectedValue(error);
      
      const model = new BedrockModel(config);
      
      await expect(model.invokeStream(makeInput('test')))
        .rejects.toThrow('Stream failed');
      
      expect(model.getCircuitBreaker().getStatus().failureCount).toBe(1);
    });
  });

  describe('destroy', () => {
    it('should reset circuit breaker', () => {
      const model = new BedrockModel(config);
      model.getCircuitBreaker().forceOpen();
      
      model.destroy();
      
      expect(model.getCircuitBreaker().getState()).toBe(CircuitBreakerState.CLOSED);
    });
  });
});
