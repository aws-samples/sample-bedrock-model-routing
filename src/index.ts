// Main exports for the Amazon Bedrock Model Multiplexer

// Types and interfaces first
export type {
  ErrorResponse,
  ModelConfiguration,
  ModelOutcome,
  ModelStats,
  MultiplexerConfig,
  MultiplexerEvents,
  MultiplexerStats,
  SelectModelRequest,
  SelectModelResponse,
  LatencyMetrics,
  MultiplexerTimer,
  CircuitBreakerConfig,
  CircuitBreakerStatus,
  ModelHealthStatus,
  SystemHealthStatus,
  ValidationError,
  ValidationResult,
  EnhancedErrorResponse
} from './types/index.js';

// Export enums
export { 
  OutcomeType,
  CircuitBreakerState,
  ErrorType
} from './types/index.js';

// Core classes
export { BedrockMultiplexer } from './core/multiplexer.js';
export { BedrockModel } from './models/bedrock-model.js';
export { RequestHandler } from './core/request-handler.js';
export { MultiplexerError } from './core/errors.js';

// Utilities
export { Timer } from './utils/timer.js';
export { 
  weightedRandomSelect, 
  createWeightedItem 
} from './utils/weighted-selection.js';
export { 
  classifyError, 
  classifyErrorType,
  isThrottlingError, 
  isRetryableError,
  getRetryDelay,
  toErrorResponse,
  createEnhancedError,
  getRecoverySuggestions,
  getErrorMessage 
} from './utils/error-classifier.js';
export { 
  MultiplexerTracer, 
  createTracer,
  type TracerInterface,
  type TracingConfig
} from './utils/tracing.js';

// Circuit breaker
export {
  CircuitBreaker,
  CircuitBreakerManager,
  DEFAULT_CIRCUIT_BREAKER_CONFIG
} from './utils/circuit-breaker.js';

// Validation utilities
export {
  ModelConfigValidator,
  MultiplexerConfigValidator,
  CircuitBreakerConfigValidator,
  formatValidationErrors,
  assertValid
} from './utils/validation.js';

// Health check utilities
export {
  HealthCheckManager,
  HealthCheckEndpoint
} from './utils/health-check.js';

// Import types for function signatures
import type { 
  ModelConfiguration, 
  MultiplexerConfig 
} from './types/index.js';
import { BedrockMultiplexer } from './core/multiplexer.js';

/**
 * Create an Amazon Bedrock Model Multiplexer with default configuration
 * @param models Array of model configurations
 * @param options Optional configuration overrides
 * @returns Configured BedrockMultiplexer instance
 */
export function createMultiplexer(
  models: ModelConfiguration[],
  options: Partial<MultiplexerConfig> = {}
): BedrockMultiplexer {
  const defaultConfig: MultiplexerConfig = {
    models,
    defaultTimeoutMs: 30000,
    maxRetries: 3,
    ...options
  };

  return new BedrockMultiplexer(defaultConfig);
}

/**
 * Version information
 */
export const VERSION = '1.0.0';
