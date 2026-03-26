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
  EnhancedErrorResponse,
  RefusalDetectionConfig
} from './types/index';

// Export enums
export { 
  OutcomeType,
  CircuitBreakerState,
  ErrorType
} from './types/index';

// Core classes
export { BedrockMultiplexer } from './core/multiplexer';
export { BedrockModel } from './models/bedrock-model';
export { RequestHandler } from './core/request-handler';
export { MultiplexerError } from './core/errors';

// Utilities
export { Timer } from './utils/timer';
export { 
  weightedRandomSelect, 
  createWeightedItem 
} from './utils/weighted-selection';
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
} from './utils/error-classifier';
export { 
  MultiplexerTracer, 
  createTracer,
  type TracerInterface,
  type TracingConfig
} from './utils/tracing';

// Circuit breaker
export {
  CircuitBreaker,
  CircuitBreakerManager,
  DEFAULT_CIRCUIT_BREAKER_CONFIG
} from './utils/circuit-breaker';

// Validation utilities
export {
  ModelConfigValidator,
  MultiplexerConfigValidator,
  CircuitBreakerConfigValidator,
  formatValidationErrors,
  assertValid
} from './utils/validation';

// Health check utilities
export {
  HealthCheckManager,
  HealthCheckEndpoint
} from './utils/health-check';

// Refusal classifier
export {
  RefusalClassifier,
  type RefusalClassifierConfig,
  type ClassificationResult
} from './classifiers/refusal-classifier';

export { extractResponseText } from './classifiers/response-extractor';

// Import types for function signatures
import type { 
  ModelConfiguration, 
  MultiplexerConfig 
} from './types/index';
import { BedrockMultiplexer } from './core/multiplexer';

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
