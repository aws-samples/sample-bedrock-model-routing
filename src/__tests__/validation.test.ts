/**
 * Unit tests for validation utility
 */

import {
  ModelConfigValidator,
  MultiplexerConfigValidator,
  CircuitBreakerConfigValidator,
  formatValidationErrors,
  assertValid
} from '../utils/validation';

describe('ModelConfigValidator', () => {
  const validConfig = {
    modelId: 'amazon.nova-2-lite-v1:0',
    weight: 100,
    isFallback: false
  };

  describe('validate', () => {
    it('should accept valid config', () => {
      const result = ModelConfigValidator.validate(validConfig);
      expect(result.isValid).toBe(true);
    });

    it('should reject null config', () => {
      const result = ModelConfigValidator.validate(null);
      expect(result.isValid).toBe(false);
    });

    // --- modelId: basic type guard only (SDK validates format) ---

    it('should reject missing modelId', () => {
      const result = ModelConfigValidator.validate({ weight: 100, isFallback: false });
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.field === 'modelId')).toBe(true);
    });

    it('should reject non-string modelId', () => {
      const result = ModelConfigValidator.validate({ ...validConfig, modelId: 123 });
      expect(result.isValid).toBe(false);
    });

    it('should accept any non-empty string modelId (SDK validates format)', () => {
      const ids = [
        'amazon.nova-2-lite-v1:0',
        'amazon.titan-text-express-v1',
        'amazon.nova-pro-v1:0',
        'model_123',
        'arn:aws:bedrock:us-east-1:123456789012:provisioned-model/my-model',
        'model@special/chars'   // SDK will reject if invalid; not our concern
      ];
      for (const modelId of ids) {
        const result = ModelConfigValidator.validate({ ...validConfig, modelId });
        expect(result.isValid).toBe(true);
      }
    });

    // --- weight: multiplexer-owned routing concept ---

    it('should reject missing weight', () => {
      const result = ModelConfigValidator.validate({ modelId: 'test', isFallback: false });
      expect(result.isValid).toBe(false);
    });

    it('should reject non-number weight', () => {
      const result = ModelConfigValidator.validate({ ...validConfig, weight: 'high' });
      expect(result.isValid).toBe(false);
    });

    it('should reject negative weight', () => {
      const result = ModelConfigValidator.validate({ ...validConfig, weight: -10 });
      expect(result.isValid).toBe(false);
    });

    it('should reject weight above 10000', () => {
      const result = ModelConfigValidator.validate({ ...validConfig, weight: 20000 });
      expect(result.isValid).toBe(false);
    });

    it('should accept zero weight', () => {
      const result = ModelConfigValidator.validate({ ...validConfig, weight: 0 });
      expect(result.isValid).toBe(true);
    });

    // --- isFallback: multiplexer-owned routing concept ---

    it('should reject missing isFallback', () => {
      const result = ModelConfigValidator.validate({ modelId: 'test', weight: 100 });
      expect(result.isValid).toBe(false);
    });

    it('should reject non-boolean isFallback', () => {
      const result = ModelConfigValidator.validate({ ...validConfig, isFallback: 'yes' });
      expect(result.isValid).toBe(false);
    });

    // region, endpoint, modelConfig are no longer on ModelConfiguration —
    // they live in MultiplexerConfig.clientConfig (opaque passthrough to SDK)
  });
});

describe('MultiplexerConfigValidator', () => {
  const validConfig = {
    models: [
      { modelId: 'model-1', weight: 100, isFallback: false }
    ],
    defaultTimeoutMs: 30000,
    maxRetries: 3
  };

  describe('validate', () => {
    it('should accept valid config', () => {
      const result = MultiplexerConfigValidator.validate(validConfig);
      expect(result.isValid).toBe(true);
    });

    it('should reject null config', () => {
      const result = MultiplexerConfigValidator.validate(null);
      expect(result.isValid).toBe(false);
    });

    it('should reject missing models', () => {
      const result = MultiplexerConfigValidator.validate({
        ...validConfig,
        models: undefined
      });
      expect(result.isValid).toBe(false);
    });

    it('should reject non-array models', () => {
      const result = MultiplexerConfigValidator.validate({
        ...validConfig,
        models: 'not-array'
      });
      expect(result.isValid).toBe(false);
    });

    it('should reject empty models array', () => {
      const result = MultiplexerConfigValidator.validate({
        ...validConfig,
        models: []
      });
      expect(result.isValid).toBe(false);
    });

    it('should validate each model in array', () => {
      const result = MultiplexerConfigValidator.validate({
        ...validConfig,
        models: [
          { modelId: 'valid', weight: 100, isFallback: false },
          { modelId: '', weight: -1, isFallback: 'invalid' }
        ]
      });
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.field.includes('models[1]'))).toBe(true);
    });

    it('should reject duplicate modelIds', () => {
      const result = MultiplexerConfigValidator.validate({
        ...validConfig,
        models: [
          { modelId: 'duplicate', weight: 100, isFallback: false },
          { modelId: 'duplicate', weight: 50, isFallback: true }
        ]
      });
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.message.includes('Duplicate'))).toBe(true);
    });

    it('should require at least one primary model', () => {
      const result = MultiplexerConfigValidator.validate({
        ...validConfig,
        models: [
          { modelId: 'fallback-1', weight: 100, isFallback: true },
          { modelId: 'fallback-2', weight: 50, isFallback: true }
        ]
      });
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.message.includes('primary'))).toBe(true);
    });

    it('should reject missing defaultTimeoutMs', () => {
      const result = MultiplexerConfigValidator.validate({
        ...validConfig,
        defaultTimeoutMs: undefined
      });
      expect(result.isValid).toBe(false);
    });

    it('should reject non-integer defaultTimeoutMs', () => {
      const result = MultiplexerConfigValidator.validate({
        ...validConfig,
        defaultTimeoutMs: 30000.5
      });
      expect(result.isValid).toBe(false);
    });

    it('should reject defaultTimeoutMs below 1000', () => {
      const result = MultiplexerConfigValidator.validate({
        ...validConfig,
        defaultTimeoutMs: 500
      });
      expect(result.isValid).toBe(false);
    });

    it('should reject defaultTimeoutMs above 300000', () => {
      const result = MultiplexerConfigValidator.validate({
        ...validConfig,
        defaultTimeoutMs: 400000
      });
      expect(result.isValid).toBe(false);
    });

    it('should reject missing maxRetries', () => {
      const result = MultiplexerConfigValidator.validate({
        ...validConfig,
        maxRetries: undefined
      });
      expect(result.isValid).toBe(false);
    });

    it('should reject negative maxRetries', () => {
      const result = MultiplexerConfigValidator.validate({
        ...validConfig,
        maxRetries: -1
      });
      expect(result.isValid).toBe(false);
    });

    it('should reject maxRetries above 10', () => {
      const result = MultiplexerConfigValidator.validate({
        ...validConfig,
        maxRetries: 15
      });
      expect(result.isValid).toBe(false);
    });

    it('should accept zero maxRetries', () => {
      const result = MultiplexerConfigValidator.validate({
        ...validConfig,
        maxRetries: 0
      });
      expect(result.isValid).toBe(true);
    });

    it('should accept valid clientConfig object', () => {
      const result = MultiplexerConfigValidator.validate({
        ...validConfig,
        clientConfig: { maxAttempts: 3, region: 'us-west-2' }
      });
      expect(result.isValid).toBe(true);
    });

    it('should accept config without clientConfig (optional)', () => {
      const result = MultiplexerConfigValidator.validate(validConfig);
      expect(result.isValid).toBe(true);
    });

    it('should reject non-object clientConfig', () => {
      const result = MultiplexerConfigValidator.validate({
        ...validConfig,
        clientConfig: 'not-an-object'
      });
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.field === 'clientConfig')).toBe(true);
    });

    it('should reject array clientConfig', () => {
      const result = MultiplexerConfigValidator.validate({
        ...validConfig,
        clientConfig: [1, 2, 3]
      });
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.field === 'clientConfig')).toBe(true);
    });

    it('should accept empty clientConfig object', () => {
      const result = MultiplexerConfigValidator.validate({
        ...validConfig,
        clientConfig: {}
      });
      expect(result.isValid).toBe(true);
    });
  });
});

describe('CircuitBreakerConfigValidator', () => {
  describe('validate', () => {
    it('should accept valid config', () => {
      const result = CircuitBreakerConfigValidator.validate({
        failureThreshold: 5,
        recoveryTimeMs: 30000,
        successThreshold: 2,
        failureWindowMs: 60000
      });
      expect(result.isValid).toBe(true);
    });

    it('should accept partial config', () => {
      const result = CircuitBreakerConfigValidator.validate({
        failureThreshold: 5
      });
      expect(result.isValid).toBe(true);
    });

    it('should accept empty config', () => {
      const result = CircuitBreakerConfigValidator.validate({});
      expect(result.isValid).toBe(true);
    });

    it('should reject null config', () => {
      const result = CircuitBreakerConfigValidator.validate(null);
      expect(result.isValid).toBe(false);
    });

    it('should reject non-integer failureThreshold', () => {
      const result = CircuitBreakerConfigValidator.validate({ failureThreshold: 5.5 });
      expect(result.isValid).toBe(false);
    });

    it('should reject failureThreshold below 1', () => {
      const result = CircuitBreakerConfigValidator.validate({ failureThreshold: 0 });
      expect(result.isValid).toBe(false);
    });

    it('should reject failureThreshold above 100', () => {
      const result = CircuitBreakerConfigValidator.validate({ failureThreshold: 150 });
      expect(result.isValid).toBe(false);
    });

    it('should reject recoveryTimeMs below 1000', () => {
      const result = CircuitBreakerConfigValidator.validate({ recoveryTimeMs: 500 });
      expect(result.isValid).toBe(false);
    });

    it('should reject recoveryTimeMs above 300000', () => {
      const result = CircuitBreakerConfigValidator.validate({ recoveryTimeMs: 400000 });
      expect(result.isValid).toBe(false);
    });

    it('should reject successThreshold below 1', () => {
      const result = CircuitBreakerConfigValidator.validate({ successThreshold: 0 });
      expect(result.isValid).toBe(false);
    });

    it('should reject successThreshold above 20', () => {
      const result = CircuitBreakerConfigValidator.validate({ successThreshold: 25 });
      expect(result.isValid).toBe(false);
    });

    it('should reject failureWindowMs below 1000', () => {
      const result = CircuitBreakerConfigValidator.validate({ failureWindowMs: 500 });
      expect(result.isValid).toBe(false);
    });

    it('should reject failureWindowMs above 600000', () => {
      const result = CircuitBreakerConfigValidator.validate({ failureWindowMs: 700000 });
      expect(result.isValid).toBe(false);
    });
  });
});

describe('formatValidationErrors', () => {
  it('should return empty string for valid result', () => {
    const result = formatValidationErrors({ isValid: true, errors: [] });
    expect(result).toBe('');
  });

  it('should format single error', () => {
    const result = formatValidationErrors({
      isValid: false,
      errors: [{ field: 'name', message: 'is required' }]
    });
    expect(result).toBe('name: is required');
  });

  it('should format multiple errors', () => {
    const result = formatValidationErrors({
      isValid: false,
      errors: [
        { field: 'name', message: 'is required' },
        { field: 'age', message: 'must be positive' }
      ]
    });
    expect(result).toBe('name: is required; age: must be positive');
  });

  it('should include expected value', () => {
    const result = formatValidationErrors({
      isValid: false,
      errors: [{ field: 'age', message: 'is invalid', expected: 'number' }]
    });
    expect(result).toContain('expected: number');
  });

  it('should include actual value', () => {
    const result = formatValidationErrors({
      isValid: false,
      errors: [{ field: 'age', message: 'is invalid', actual: 'string' }]
    });
    expect(result).toContain('got: string');
  });
});

describe('assertValid', () => {
  it('should not throw for valid result', () => {
    expect(() => assertValid({ isValid: true, errors: [] })).not.toThrow();
  });

  it('should throw for invalid result', () => {
    expect(() => assertValid({
      isValid: false,
      errors: [{ field: 'test', message: 'error' }]
    })).toThrow('Validation failed');
  });

  it('should include error details in exception', () => {
    expect(() => assertValid({
      isValid: false,
      errors: [{ field: 'name', message: 'is required' }]
    })).toThrow('name: is required');
  });
});
