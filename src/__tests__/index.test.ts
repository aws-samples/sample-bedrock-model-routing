/**
 * Unit tests for main index exports and factory functions
 */

import {
  createMultiplexer,
  VERSION,
  // Types
  OutcomeType,
  CircuitBreakerState,
  ErrorType,
  // Classes
  Timer,
  CircuitBreaker,
  CircuitBreakerManager,
  HealthCheckManager,
  HealthCheckEndpoint,
  // Functions
  weightedRandomSelect,
  createWeightedItem,
  classifyError,
  classifyErrorType,
  isThrottlingError,
  isRetryableError,
  getRetryDelay,
  toErrorResponse,
  createEnhancedError,
  getRecoverySuggestions,
  getErrorMessage,
  createTracer,
  ModelConfigValidator,
  MultiplexerConfigValidator,
  CircuitBreakerConfigValidator,
  formatValidationErrors,
  assertValid,
  DEFAULT_CIRCUIT_BREAKER_CONFIG
} from '../index';

// Mock AWS SDK
jest.mock('@aws-sdk/client-bedrock-runtime', () => {
  return {
    BedrockRuntimeClient: jest.fn().mockImplementation(() => ({
      send: jest.fn()
    })),
    InvokeModelCommand: jest.fn().mockImplementation((input) => ({ input })),
    ConverseStreamCommand: jest.fn().mockImplementation((input) => ({ input }))
  };
});

describe('Index Exports', () => {
  describe('createMultiplexer', () => {
    it('should create multiplexer with models', () => {
      const multiplexer = createMultiplexer([
        { modelId: 'amazon.nova-lite-v1:0', weight: 100, isFallback: false },
        { modelId: 'amazon.titan-text-express-v1', weight: 50, isFallback: false }
      ]);
      
      expect(multiplexer).toBeDefined();
    });

    it('should apply default options', () => {
      const multiplexer = createMultiplexer([
        { modelId: 'test', weight: 100, isFallback: false }
      ]);
      
      expect(multiplexer).toBeDefined();
    });

    it('should allow option overrides', () => {
      const multiplexer = createMultiplexer(
        [{ modelId: 'test', weight: 100, isFallback: false }],
        { maxRetries: 5, defaultTimeoutMs: 60000 }
      );
      
      expect(multiplexer).toBeDefined();
    });
  });

  describe('VERSION', () => {
    it('should be a valid semver string', () => {
      expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('should be 1.0.0', () => {
      expect(VERSION).toBe('1.0.0');
    });
  });

  describe('Enums', () => {
    it('should export OutcomeType', () => {
      expect(OutcomeType.SUCCESS).toBe(0);
      expect(OutcomeType.RATE_LIMIT).toBe(1);
      expect(OutcomeType.FAIL_FAST).toBe(2);
    });

    it('should export CircuitBreakerState', () => {
      expect(CircuitBreakerState.CLOSED).toBe('CLOSED');
      expect(CircuitBreakerState.OPEN).toBe('OPEN');
      expect(CircuitBreakerState.HALF_OPEN).toBe('HALF_OPEN');
    });

    it('should export ErrorType', () => {
      expect(ErrorType.VALIDATION).toBe('VALIDATION');
      expect(ErrorType.THROTTLING).toBe('THROTTLING');
      expect(ErrorType.TIMEOUT).toBe('TIMEOUT');
    });
  });

  describe('Classes', () => {
    it('should export Timer', () => {
      expect(Timer).toBeDefined();
    });

    it('should export CircuitBreaker', () => {
      expect(CircuitBreaker).toBeDefined();
    });

    it('should export CircuitBreakerManager', () => {
      expect(CircuitBreakerManager).toBeDefined();
    });

    it('should export HealthCheckManager', () => {
      expect(HealthCheckManager).toBeDefined();
    });

    it('should export HealthCheckEndpoint', () => {
      expect(HealthCheckEndpoint).toBeDefined();
    });
  });

  describe('Utility Functions', () => {
    it('should export weighted selection functions', () => {
      expect(weightedRandomSelect).toBeDefined();
      expect(createWeightedItem).toBeDefined();
    });

    it('should export error classifier functions', () => {
      expect(classifyError).toBeDefined();
      expect(classifyErrorType).toBeDefined();
      expect(isThrottlingError).toBeDefined();
      expect(isRetryableError).toBeDefined();
      expect(getRetryDelay).toBeDefined();
      expect(toErrorResponse).toBeDefined();
      expect(createEnhancedError).toBeDefined();
      expect(getRecoverySuggestions).toBeDefined();
      expect(getErrorMessage).toBeDefined();
    });

    it('should export tracing functions', () => {
      expect(createTracer).toBeDefined();
    });

    it('should export validation classes and functions', () => {
      expect(ModelConfigValidator).toBeDefined();
      expect(MultiplexerConfigValidator).toBeDefined();
      expect(CircuitBreakerConfigValidator).toBeDefined();
      expect(formatValidationErrors).toBeDefined();
      expect(assertValid).toBeDefined();
    });
  });

  describe('Constants', () => {
    it('should export DEFAULT_CIRCUIT_BREAKER_CONFIG', () => {
      expect(DEFAULT_CIRCUIT_BREAKER_CONFIG).toBeDefined();
      expect(DEFAULT_CIRCUIT_BREAKER_CONFIG.failureThreshold).toBe(5);
    });
  });
});

describe('Integration Examples', () => {
  describe('Basic Usage Pattern', () => {
    it('should demonstrate basic multiplexer setup', () => {
      const models = [
        { modelId: 'amazon.nova-lite-v1:0', weight: 100, isFallback: false },
        { modelId: 'amazon.titan-text-express-v1', weight: 50, isFallback: true }
      ];

      const multiplexer = createMultiplexer(models, {
        maxRetries: 3,
        defaultTimeoutMs: 30000
      });

      expect(multiplexer).toBeDefined();
      const stats = multiplexer.getStats();
      expect(Object.keys(stats.modelStats)).toHaveLength(2);

      multiplexer.destroy();
    });
  });

  describe('Health Check Pattern', () => {
    it('should demonstrate health check usage', () => {
      // Use at least 2 models — the spec's health formula uses floor(totalModels/2)
      // which is 0 for a single model, making the system always report unhealthy.
      const multiplexer = createMultiplexer([
        { modelId: 'model-1', weight: 100, isFallback: false },
        { modelId: 'model-2', weight: 50, isFallback: true }
      ]);

      // Simple health check (for load balancers)
      const simpleHealth = multiplexer.getSimpleHealthCheck();
      expect(simpleHealth.status).toBe('healthy');
      expect(simpleHealth.code).toBe(200);

      // Detailed health check
      const detailedHealth = multiplexer.getHealthStatus();
      expect(detailedHealth.totalModels).toBe(2);
      expect(detailedHealth.timestamp).toBeDefined();

      // Model-specific health
      const modelHealth = multiplexer.getModelHealthStatus('model-1');
      expect(modelHealth?.modelId).toBe('model-1');

      multiplexer.destroy();
    });
  });

  describe('Circuit Breaker Pattern', () => {
    it('should demonstrate circuit breaker usage', () => {
      const cb = new CircuitBreaker('test-model', {
        failureThreshold: 3,
        recoveryTimeMs: 1000
      });

      // Initially closed
      expect(cb.getState()).toBe(CircuitBreakerState.CLOSED);
      expect(cb.canExecute()).toBe(true);

      // Record failures
      cb.recordFailure();
      cb.recordFailure();
      expect(cb.getState()).toBe(CircuitBreakerState.CLOSED);

      // Third failure opens circuit
      cb.recordFailure();
      expect(cb.getState()).toBe(CircuitBreakerState.OPEN);
      expect(cb.canExecute()).toBe(false);

      // Get circuit open error
      const error = cb.getCircuitOpenError();
      expect(error.errorType).toBe(ErrorType.CIRCUIT_OPEN);
      expect(error.retryable).toBe(true);
    });
  });

  describe('Validation Pattern', () => {
    it('should demonstrate input validation', () => {
      // Validate model config
      const validResult = ModelConfigValidator.validate({
        modelId: 'amazon.nova-2-lite-v1:0',
        weight: 100,
        isFallback: false
      });
      expect(validResult.isValid).toBe(true);

      // Invalid config
      const invalidResult = ModelConfigValidator.validate({
        modelId: '',
        weight: -1,
        isFallback: false
      });
      expect(invalidResult.isValid).toBe(false);
      expect(invalidResult.errors.length).toBeGreaterThan(0);

      // Format errors for display
      const errorMessage = formatValidationErrors(invalidResult);
      expect(errorMessage.length).toBeGreaterThan(0);

      // Assert valid (throws on invalid)
      expect(() => assertValid(validResult)).not.toThrow();
      expect(() => assertValid(invalidResult)).toThrow();
    });
  });

  describe('Error Handling Pattern', () => {
    it('should demonstrate error classification', () => {
      // Throttling error
      const throttleError = new Error('Rate limited');
      throttleError.name = 'ThrottlingException';
      
      expect(isThrottlingError(throttleError.name)).toBe(true);
      expect(classifyError(throttleError)).toBe(OutcomeType.RATE_LIMIT);
      expect(classifyErrorType(throttleError)).toBe(ErrorType.THROTTLING);
      expect(isRetryableError(throttleError)).toBe(true);

      // Validation error
      const validationError = new Error('Invalid input');
      validationError.name = 'ValidationException';
      
      expect(classifyErrorType(validationError)).toBe(ErrorType.VALIDATION);
      expect(isRetryableError(validationError)).toBe(false);

      // Enhanced error
      const enhanced = createEnhancedError(
        throttleError,
        ErrorType.THROTTLING,
        'model-123'
      );
      expect(enhanced.errorType).toBe(ErrorType.THROTTLING);
      expect(enhanced.modelId).toBe('model-123');
      expect(enhanced.recoverySuggestions?.length).toBeGreaterThan(0);

      // Recovery suggestions
      const suggestions = getRecoverySuggestions(ErrorType.THROTTLING);
      expect(suggestions.length).toBeGreaterThan(0);
    });
  });

  describe('Event Handling Pattern', () => {
    it('should demonstrate event listeners', async () => {
      const multiplexer = createMultiplexer([
        { modelId: 'model-1', weight: 100, isFallback: false }
      ]);

      const events: string[] = [];

      // Register event handlers
      multiplexer.on('model-added', (modelId) => {
        events.push(`added:${modelId}`);
      });

      multiplexer.on('model-removed', (modelId) => {
        events.push(`removed:${modelId}`);
      });

      multiplexer.on('stats-reset', () => {
        events.push('stats-reset');
      });

      // Trigger events
      await multiplexer.addModel({
        modelId: 'model-2',
        weight: 50,
        isFallback: true
      });

      await multiplexer.removeModel('model-2');
      multiplexer.resetStats();

      // Verify events
      expect(events).toContain('added:model-2');
      expect(events).toContain('removed:model-2');
      expect(events).toContain('stats-reset');

      multiplexer.destroy();
    });
  });
});
