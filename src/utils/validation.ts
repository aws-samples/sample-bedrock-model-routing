/**
 * Input validation utilities for the Amazon Bedrock Model Multiplexer
 * Provides comprehensive validation for all public APIs
 */

import {
  ModelConfiguration,
  MultiplexerConfig,
  ValidationError,
  ValidationResult,
  CircuitBreakerConfig
} from '../types/index';

/**
 * Validator class for model configurations.
 *
 * Only validates multiplexer-owned concerns (routing weight, fallback flag,
 * basic type guards). SDK-owned concerns (model ID format, region validity,
 * endpoint URL, model parameter ranges) are left to the AWS SDK, which
 * validates them at call/connection time with clear error messages.
 *
 * @see planning/12-validation-layer-overreach.md
 */
export class ModelConfigValidator {
  /**
   * Validate a model configuration
   * @param config The model configuration to validate
   * @returns Validation result
   */
  public static validate(config: unknown): ValidationResult {
    const errors: ValidationError[] = [];

    if (!config || typeof config !== 'object') {
      errors.push({
        field: 'config',
        message: 'Model configuration must be a non-null object',
        expected: 'object',
        actual: typeof config
      });
      return { isValid: false, errors };
    }

    const cfg = config as Record<string, unknown>;

    // Validate modelId — basic type guard only; the SDK validates format/existence
    if (!cfg.modelId) {
      errors.push({
        field: 'modelId',
        message: 'modelId is required'
      });
    } else if (typeof cfg.modelId !== 'string') {
      errors.push({
        field: 'modelId',
        message: 'modelId must be a string',
        expected: 'string',
        actual: typeof cfg.modelId
      });
    }

    // Validate weight — multiplexer-owned routing concept
    if (cfg.weight === undefined || cfg.weight === null) {
      errors.push({
        field: 'weight',
        message: 'weight is required'
      });
    } else if (typeof cfg.weight !== 'number') {
      errors.push({
        field: 'weight',
        message: 'weight must be a number',
        expected: 'number',
        actual: typeof cfg.weight
      });
    } else if (cfg.weight < 0) {
      errors.push({
        field: 'weight',
        message: 'weight must be non-negative',
        expected: '>= 0',
        actual: String(cfg.weight)
      });
    } else if (cfg.weight > 10000) {
      errors.push({
        field: 'weight',
        message: 'weight exceeds maximum allowed value',
        expected: '<= 10000',
        actual: String(cfg.weight)
      });
    }

    // Validate isFallback — multiplexer-owned routing concept
    if (cfg.isFallback === undefined || cfg.isFallback === null) {
      errors.push({
        field: 'isFallback',
        message: 'isFallback is required'
      });
    } else if (typeof cfg.isFallback !== 'boolean') {
      errors.push({
        field: 'isFallback',
        message: 'isFallback must be a boolean',
        expected: 'boolean',
        actual: typeof cfg.isFallback
      });
    }

    return { isValid: errors.length === 0, errors };
  }
}

/**
 * Validator class for multiplexer configurations
 */
export class MultiplexerConfigValidator {
  /**
   * Validate a multiplexer configuration
   * @param config The multiplexer configuration to validate
   * @returns Validation result
   */
  public static validate(config: unknown): ValidationResult {
    const errors: ValidationError[] = [];

    if (!config || typeof config !== 'object') {
      errors.push({
        field: 'config',
        message: 'Multiplexer configuration must be a non-null object',
        expected: 'object',
        actual: typeof config
      });
      return { isValid: false, errors };
    }

    const cfg = config as Record<string, unknown>;

    // Validate models array
    if (!cfg.models) {
      errors.push({
        field: 'models',
        message: 'models array is required'
      });
    } else if (!Array.isArray(cfg.models)) {
      errors.push({
        field: 'models',
        message: 'models must be an array',
        expected: 'array',
        actual: typeof cfg.models
      });
    } else if (cfg.models.length === 0) {
      errors.push({
        field: 'models',
        message: 'models array must contain at least one model'
      });
    } else {
      // Validate each model
      const modelIds = new Set<string>();
      cfg.models.forEach((model: unknown, index: number) => {
        const modelResult = ModelConfigValidator.validate(model);
        modelResult.errors.forEach(error => {
          errors.push({
            ...error,
            field: `models[${index}].${error.field}`
          });
        });

        // Check for duplicate model IDs
        if (model && typeof model === 'object') {
          const modelId = (model as Record<string, unknown>).modelId;
          if (typeof modelId === 'string') {
            if (modelIds.has(modelId)) {
              errors.push({
                field: `models[${index}].modelId`,
                message: 'Duplicate modelId found',
                actual: modelId
              });
            }
            modelIds.add(modelId);
          }
        }
      });

      // Check that at least one primary model exists
      const hasPrimary = cfg.models.some((model: unknown) => {
        if (model && typeof model === 'object') {
          return (model as Record<string, unknown>).isFallback === false;
        }
        return false;
      });
      if (!hasPrimary) {
        errors.push({
          field: 'models',
          message: 'At least one primary (non-fallback) model is required'
        });
      }
    }

    // Validate defaultTimeoutMs
    if (cfg.defaultTimeoutMs === undefined || cfg.defaultTimeoutMs === null) {
      errors.push({
        field: 'defaultTimeoutMs',
        message: 'defaultTimeoutMs is required'
      });
    } else if (typeof cfg.defaultTimeoutMs !== 'number' || !Number.isInteger(cfg.defaultTimeoutMs)) {
      errors.push({
        field: 'defaultTimeoutMs',
        message: 'defaultTimeoutMs must be an integer',
        expected: 'integer',
        actual: String(cfg.defaultTimeoutMs)
      });
    } else if (cfg.defaultTimeoutMs < 1000) {
      errors.push({
        field: 'defaultTimeoutMs',
        message: 'defaultTimeoutMs must be at least 1000ms',
        expected: '>= 1000',
        actual: String(cfg.defaultTimeoutMs)
      });
    } else if (cfg.defaultTimeoutMs > 300000) {
      errors.push({
        field: 'defaultTimeoutMs',
        message: 'defaultTimeoutMs must not exceed 300000ms (5 minutes)',
        expected: '<= 300000',
        actual: String(cfg.defaultTimeoutMs)
      });
    }

    // Validate clientConfig (optional, opaque passthrough — just verify it's an object)
    if (cfg.clientConfig !== undefined && cfg.clientConfig !== null) {
      if (typeof cfg.clientConfig !== 'object' || Array.isArray(cfg.clientConfig)) {
        errors.push({
          field: 'clientConfig',
          message: 'clientConfig must be a plain object (BedrockRuntimeClient config overrides)',
          expected: 'object',
          actual: Array.isArray(cfg.clientConfig) ? 'array' : typeof cfg.clientConfig
        });
      }
    }

    // Validate refusalDetection (optional)
    if (cfg.refusalDetection !== undefined && cfg.refusalDetection !== null) {
      if (typeof cfg.refusalDetection !== 'object' || Array.isArray(cfg.refusalDetection)) {
        errors.push({
          field: 'refusalDetection',
          message: 'refusalDetection must be an object',
          expected: 'object',
          actual: Array.isArray(cfg.refusalDetection) ? 'array' : typeof cfg.refusalDetection
        });
      } else {
        const rd = cfg.refusalDetection as Record<string, unknown>;
        
        if (rd.enabled !== undefined && typeof rd.enabled !== 'boolean') {
          errors.push({
            field: 'refusalDetection.enabled',
            message: 'enabled must be a boolean',
            expected: 'boolean',
            actual: typeof rd.enabled
          });
        }

        if (rd.enabled === true) {
          if (!rd.modelPath || typeof rd.modelPath !== 'string') {
            errors.push({
              field: 'refusalDetection.modelPath',
              message: 'modelPath is required when refusal detection is enabled',
              expected: 'string'
            });
          }
        }

        if (rd.confidenceThreshold !== undefined && rd.confidenceThreshold !== null) {
          if (typeof rd.confidenceThreshold !== 'number') {
            errors.push({
              field: 'refusalDetection.confidenceThreshold',
              message: 'confidenceThreshold must be a number',
              expected: 'number',
              actual: typeof rd.confidenceThreshold
            });
          } else if (rd.confidenceThreshold < 0 || rd.confidenceThreshold > 1) {
            errors.push({
              field: 'refusalDetection.confidenceThreshold',
              message: 'confidenceThreshold must be between 0 and 1',
              expected: '0–1',
              actual: String(rd.confidenceThreshold)
            });
          }
        }

        if (rd.retryOnRefusal !== undefined && typeof rd.retryOnRefusal !== 'boolean') {
          errors.push({
            field: 'refusalDetection.retryOnRefusal',
            message: 'retryOnRefusal must be a boolean',
            expected: 'boolean',
            actual: typeof rd.retryOnRefusal
          });
        }
      }
    }

    // Validate tierEscalation (optional)
    if (cfg.tierEscalation !== undefined && cfg.tierEscalation !== null) {
      if (typeof cfg.tierEscalation !== 'object' || Array.isArray(cfg.tierEscalation)) {
        errors.push({
          field: 'tierEscalation',
          message: 'tierEscalation must be an object',
          expected: 'object',
          actual: Array.isArray(cfg.tierEscalation) ? 'array' : typeof cfg.tierEscalation
        });
      } else {
        const te = cfg.tierEscalation as Record<string, unknown>;

        if (te.enabled !== undefined && typeof te.enabled !== 'boolean') {
          errors.push({
            field: 'tierEscalation.enabled',
            message: 'enabled must be a boolean',
            expected: 'boolean',
            actual: typeof te.enabled
          });
        }

        if (te.enabled === true) {
          const validTiers = ['reserved', 'priority'];
          if (!te.escalationTier || typeof te.escalationTier !== 'string') {
            errors.push({
              field: 'tierEscalation.escalationTier',
              message: 'escalationTier is required when tier escalation is enabled',
              expected: '"reserved" | "priority"'
            });
          } else if (!validTiers.includes(te.escalationTier)) {
            errors.push({
              field: 'tierEscalation.escalationTier',
              message: 'escalationTier must be "reserved" or "priority"',
              expected: '"reserved" | "priority"',
              actual: String(te.escalationTier)
            });
          }
        }
      }
    }

    // Validate maxRetries
    if (cfg.maxRetries === undefined || cfg.maxRetries === null) {
      errors.push({
        field: 'maxRetries',
        message: 'maxRetries is required'
      });
    } else if (typeof cfg.maxRetries !== 'number' || !Number.isInteger(cfg.maxRetries)) {
      errors.push({
        field: 'maxRetries',
        message: 'maxRetries must be an integer',
        expected: 'integer',
        actual: String(cfg.maxRetries)
      });
    } else if (cfg.maxRetries < 0) {
      errors.push({
        field: 'maxRetries',
        message: 'maxRetries must be non-negative',
        expected: '>= 0',
        actual: String(cfg.maxRetries)
      });
    } else if (cfg.maxRetries > 10) {
      errors.push({
        field: 'maxRetries',
        message: 'maxRetries must not exceed 10',
        expected: '<= 10',
        actual: String(cfg.maxRetries)
      });
    }

    return { isValid: errors.length === 0, errors };
  }
}

/**
 * Validator for circuit breaker configuration
 */
export class CircuitBreakerConfigValidator {
  /**
   * Validate a circuit breaker configuration
   * @param config The circuit breaker configuration to validate
   * @returns Validation result
   */
  public static validate(config: unknown): ValidationResult {
    const errors: ValidationError[] = [];

    if (!config || typeof config !== 'object') {
      errors.push({
        field: 'config',
        message: 'Circuit breaker configuration must be a non-null object',
        expected: 'object',
        actual: typeof config
      });
      return { isValid: false, errors };
    }

    const cfg = config as Record<string, unknown>;

    // Validate failureThreshold
    if (cfg.failureThreshold !== undefined && cfg.failureThreshold !== null) {
      if (typeof cfg.failureThreshold !== 'number' || !Number.isInteger(cfg.failureThreshold)) {
        errors.push({
          field: 'failureThreshold',
          message: 'failureThreshold must be an integer',
          expected: 'integer',
          actual: String(cfg.failureThreshold)
        });
      } else if (cfg.failureThreshold < 1) {
        errors.push({
          field: 'failureThreshold',
          message: 'failureThreshold must be at least 1',
          expected: '>= 1',
          actual: String(cfg.failureThreshold)
        });
      } else if (cfg.failureThreshold > 100) {
        errors.push({
          field: 'failureThreshold',
          message: 'failureThreshold must not exceed 100',
          expected: '<= 100',
          actual: String(cfg.failureThreshold)
        });
      }
    }

    // Validate recoveryTimeMs
    if (cfg.recoveryTimeMs !== undefined && cfg.recoveryTimeMs !== null) {
      if (typeof cfg.recoveryTimeMs !== 'number' || !Number.isInteger(cfg.recoveryTimeMs)) {
        errors.push({
          field: 'recoveryTimeMs',
          message: 'recoveryTimeMs must be an integer',
          expected: 'integer',
          actual: String(cfg.recoveryTimeMs)
        });
      } else if (cfg.recoveryTimeMs < 1000) {
        errors.push({
          field: 'recoveryTimeMs',
          message: 'recoveryTimeMs must be at least 1000ms',
          expected: '>= 1000',
          actual: String(cfg.recoveryTimeMs)
        });
      } else if (cfg.recoveryTimeMs > 300000) {
        errors.push({
          field: 'recoveryTimeMs',
          message: 'recoveryTimeMs must not exceed 300000ms (5 minutes)',
          expected: '<= 300000',
          actual: String(cfg.recoveryTimeMs)
        });
      }
    }

    // Validate successThreshold
    if (cfg.successThreshold !== undefined && cfg.successThreshold !== null) {
      if (typeof cfg.successThreshold !== 'number' || !Number.isInteger(cfg.successThreshold)) {
        errors.push({
          field: 'successThreshold',
          message: 'successThreshold must be an integer',
          expected: 'integer',
          actual: String(cfg.successThreshold)
        });
      } else if (cfg.successThreshold < 1) {
        errors.push({
          field: 'successThreshold',
          message: 'successThreshold must be at least 1',
          expected: '>= 1',
          actual: String(cfg.successThreshold)
        });
      } else if (cfg.successThreshold > 20) {
        errors.push({
          field: 'successThreshold',
          message: 'successThreshold must not exceed 20',
          expected: '<= 20',
          actual: String(cfg.successThreshold)
        });
      }
    }

    // Validate failureWindowMs
    if (cfg.failureWindowMs !== undefined && cfg.failureWindowMs !== null) {
      if (typeof cfg.failureWindowMs !== 'number' || !Number.isInteger(cfg.failureWindowMs)) {
        errors.push({
          field: 'failureWindowMs',
          message: 'failureWindowMs must be an integer',
          expected: 'integer',
          actual: String(cfg.failureWindowMs)
        });
      } else if (cfg.failureWindowMs < 1000) {
        errors.push({
          field: 'failureWindowMs',
          message: 'failureWindowMs must be at least 1000ms',
          expected: '>= 1000',
          actual: String(cfg.failureWindowMs)
        });
      } else if (cfg.failureWindowMs > 600000) {
        errors.push({
          field: 'failureWindowMs',
          message: 'failureWindowMs must not exceed 600000ms (10 minutes)',
          expected: '<= 600000',
          actual: String(cfg.failureWindowMs)
        });
      }
    }

    return { isValid: errors.length === 0, errors };
  }
}

/**
 * Create a validation error response
 * @param result Validation result
 * @returns Error message string
 */
export function formatValidationErrors(result: ValidationResult): string {
  if (result.isValid) {
    return '';
  }
  
  const errorMessages = result.errors.map(error => {
    let msg = `${error.field}: ${error.message}`;
    if (error.expected) {
      msg += ` (expected: ${error.expected})`;
    }
    if (error.actual) {
      msg += ` (got: ${error.actual})`;
    }
    return msg;
  });
  
  return errorMessages.join('; ');
}

/**
 * Validate and throw if invalid
 * @param result Validation result
 * @throws Error if validation failed
 */
export function assertValid(result: ValidationResult): void {
  if (!result.isValid) {
    throw new Error(`Validation failed: ${formatValidationErrors(result)}`);
  }
}
