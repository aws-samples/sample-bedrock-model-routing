// Core types for the Amazon Bedrock Model Multiplexer

/**
 * Error response interface for failed requests
 */
export interface ErrorResponse {
  /** HTTP status code or custom error code */
  code: number;
  /** Error message description */
  message: string;
  /** Optional error details */
  details?: Record<string, any>;
}

/**
 * Configuration for initializing an Amazon Bedrock model
 */
export interface ModelConfiguration {
  /** Amazon Bedrock model ID (e.g., "amazon.nova-2-lite-v1:0") */
  modelId: string;
  /** Weight for weighted random selection (higher = more likely to be selected) */
  weight: number;
  /** Whether this model is a fallback model */
  isFallback: boolean;
}

/**
 * Statistics tracking for models and the multiplexer
 */
export interface MultiplexerStats {
  /** Total number of successful requests */
  successCount: number;
  /** Total number of rate-limited requests */
  rateLimitCount: number;
  /** Total number of fail-fast errors */
  failFastCount: number;
  /** Per-model statistics */
  modelStats: Record<string, ModelStats>;
  /** Overall request latency metrics */
  latencyMetrics: LatencyMetrics;
}

/**
 * Statistics for individual models
 */
export interface ModelStats {
  /** Model identifier */
  modelId: string;
  /** Number of successful requests to this model */
  successCount: number;
  /** Number of rate-limited requests to this model */
  rateLimitCount: number;
  /** Number of fail-fast errors from this model */
  failFastCount: number;
  /** Average response latency in milliseconds */
  averageLatency: number;
  /** Whether this is a fallback model */
  isFallback: boolean;
}

/**
 * Latency metrics for performance monitoring
 */
export interface LatencyMetrics {
  /** Average request latency in milliseconds */
  average: number;
  /** 50th percentile latency */
  p50: number;
  /** 95th percentile latency */
  p95: number;
  /** 99th percentile latency */
  p99: number;
  /** Minimum recorded latency */
  min: number;
  /** Maximum recorded latency */
  max: number;
}

/**
 * Request outcome classification
 */
export enum OutcomeType {
  /** Request completed successfully */
  SUCCESS = 0,
  /** Request was rate-limited (ThrottlingException) */
  RATE_LIMIT = 1,
  /** Request failed fast (other errors) */
  FAIL_FAST = 2
}

/**
 * Outcome of a model invocation
 */
export interface ModelOutcome {
  /** The model that processed the request */
  modelId: string;
  /** The outcome type */
  type: OutcomeType;
  /** Request latency in milliseconds */
  latency: number;
  /** Timestamp of the outcome */
  timestamp: Date;
  /** Optional error details for failed requests */
  error?: ErrorResponse;
}

/**
 * Request for model selection from the multiplexer
 */
export interface SelectModelRequest {
  /** Set of model IDs that have already been tried and should be skipped */
  skippedModels: Set<string>;
}

/**
 * Response from model selection
 */
export interface SelectModelResponse {
  /** Selected model ID, null if no models are available */
  modelId: string | null;
  /** Whether the selected model is a fallback model */
  isFallback: boolean;
}

/**
 * Configuration for the Amazon Bedrock Model Multiplexer
 */
export interface MultiplexerConfig {
  /** Models to register with the multiplexer */
  models: ModelConfiguration[];
  /** Default timeout for model requests in milliseconds */
  defaultTimeoutMs: number;
  /** Maximum number of retry attempts per request */
  maxRetries: number;
  /**
   * Opaque passthrough to the `BedrockRuntimeClient` constructor.
   *
   * The multiplexer does not inspect or transform these — they are forwarded
   * directly to every `BedrockRuntimeClient` it creates.  You can supply
   * `region`, `credentials`, `maxAttempts`, a custom `retryStrategy`,
   * `logger`, etc. — anything the SDK client accepts.
   *
   * **Recommended:** Set `maxAttempts: 1` to disable SDK-level retries so the
   * multiplexer can fail over to a different model immediately.  Without this,
   * the SDK defaults to 3 attempts against the same model before surfacing the
   * error, which triples latency before failover.
   *
   * @example
   * ```ts
   * clientConfig: { region: 'us-east-1', maxAttempts: 1 }
   * ```
   */
  clientConfig?: Record<string, any>;
  /** X-Ray tracing configuration */
  tracing?: {
    /** Whether to enable X-Ray tracing */
    enabled: boolean;
    /** Service name for X-Ray traces */
    serviceName?: string;
    /** Whether to capture request/response bodies (be careful with sensitive data) */
    captureBodies?: boolean;
    /** Whether to capture detailed model selection traces */
    captureModelSelection?: boolean;
  };
}


/**
 * Events emitted by the multiplexer
 */
export interface MultiplexerEvents {
  /** Emitted when a request is received */
  'request': (input: any) => void;
  /** Emitted when a request completes successfully */
  'success': (response: any, outcome: ModelOutcome) => void;
  /** Emitted when a request fails */
  'error': (error: ErrorResponse | null, outcome: ModelOutcome) => void;
  /** Emitted when a model is skipped during selection due to open circuit breaker */
  'model-circuit-open-skipped': (modelId: string) => void;
  /** Emitted when a model is added */
  'model-added': (modelId: string) => void;
  /** Emitted when a model is removed */
  'model-removed': (modelId: string) => void;
  /** Emitted periodically with statistics */
  'stats': (stats: MultiplexerStats) => void;
  /** Emitted when statistics are reset */
  'stats-reset': () => void;
  /** Emitted when a model is selected for a request */
  'model-selected': (modelId: string, isFallback: boolean, retryCount: number) => void;
  /** Emitted when a model invocation starts */
  'model-invocation-start': (modelId: string, requestId: string) => void;
  /** Emitted when a model invocation completes */
  'model-invocation-complete': (modelId: string, requestId: string, latency: number) => void;
}

/**
 * Timer interface for model re-enabling
 */
export interface MultiplexerTimer {
  /** Start the timer with specified duration in milliseconds */
  start(durationMs: number): void;
  /** Cancel the timer */
  cancel(): void;
  /** Whether the timer is currently running */
  isRunning(): boolean;
}

/**
 * Circuit breaker state enum
 */
export enum CircuitBreakerState {
  /** Circuit is closed, requests flow through normally */
  CLOSED = 'CLOSED',
  /** Circuit is open, requests are immediately rejected */
  OPEN = 'OPEN',
  /** Circuit is half-open, allowing test requests */
  HALF_OPEN = 'HALF_OPEN'
}

/**
 * Circuit breaker configuration
 */
export interface CircuitBreakerConfig {
  /** Number of consecutive failures to open the circuit */
  failureThreshold: number;
  /** Time in milliseconds before transitioning from OPEN to HALF_OPEN */
  recoveryTimeMs: number;
  /** Number of successful requests in HALF_OPEN state to close the circuit */
  successThreshold: number;
  /** Time window in milliseconds for tracking failures */
  failureWindowMs: number;
}

/**
 * Circuit breaker status
 */
export interface CircuitBreakerStatus {
  /** Current state of the circuit */
  state: CircuitBreakerState;
  /** Number of consecutive failures */
  failureCount: number;
  /** Number of consecutive successes (in HALF_OPEN state) */
  successCount: number;
  /** Timestamp when the circuit was last opened */
  lastOpenedAt?: Date;
  /** Timestamp when the circuit will transition to HALF_OPEN */
  nextRetryAt?: Date;
}


/**
 * Health status for a model
 */
export interface ModelHealthStatus {
  /** Model identifier */
  modelId: string;
  /** Whether the model is healthy */
  isHealthy: boolean;
  /** Current circuit breaker state */
  circuitState: CircuitBreakerState;
  /** Last successful request timestamp */
  lastSuccessAt?: Date;
  /** Last failure timestamp */
  lastFailureAt?: Date;
  /** Average response time in milliseconds */
  avgResponseTimeMs: number;
  /** Error rate (0-1) */
  errorRate: number;
  /** Number of requests in the last minute */
  requestsPerMinute: number;
}

/**
 * Overall system health status
 */
export interface SystemHealthStatus {
  /** Overall system health */
  isHealthy: boolean;
  /** Timestamp of the health check */
  timestamp: Date;
  /** Total number of registered models */
  totalModels: number;
  /** Number of healthy models */
  healthyModels: number;
  /** Number of degraded models */
  degradedModels: number;
  /** Number of unhealthy models */
  unhealthyModels: number;
  /** Per-model health status */
  models: Record<string, ModelHealthStatus>;
  /** System-wide metrics */
  metrics: {
    totalRequests: number;
    successRate: number;
    averageLatencyMs: number;
    p99LatencyMs: number;
  };
}

/**
 * Validation error details
 */
export interface ValidationError {
  /** Field that failed validation */
  field: string;
  /** Error message */
  message: string;
  /** Expected value or constraint */
  expected?: string;
  /** Actual value received */
  actual?: string;
}

/**
 * Validation result
 */
export interface ValidationResult {
  /** Whether validation passed */
  isValid: boolean;
  /** List of validation errors */
  errors: ValidationError[];
}

/**
 * Error types for detailed error handling
 */
export enum ErrorType {
  /** Validation error */
  VALIDATION = 'VALIDATION',
  /** Throttling/rate limit error */
  THROTTLING = 'THROTTLING',
  /** Model not available */
  MODEL_UNAVAILABLE = 'MODEL_UNAVAILABLE',
  /** Request timeout */
  TIMEOUT = 'TIMEOUT',
  /** Request cancelled */
  CANCELLED = 'CANCELLED',
  /** Circuit breaker open */
  CIRCUIT_OPEN = 'CIRCUIT_OPEN',
  /** Internal server error */
  INTERNAL = 'INTERNAL',
  /** Authentication error */
  AUTHENTICATION = 'AUTHENTICATION',
  /** Network error */
  NETWORK = 'NETWORK',
  /** Unknown error */
  UNKNOWN = 'UNKNOWN'
}

/**
 * Enhanced error response with detailed information
 */
export interface EnhancedErrorResponse extends ErrorResponse {
  /** Error type classification */
  errorType: ErrorType;
  /** Whether the error is retryable */
  retryable: boolean;
  /** Suggested retry delay in milliseconds */
  retryAfterMs?: number;
  /** Recovery suggestions */
  recoverySuggestions?: string[];
  /** Request ID for tracking */
  requestId?: string;
  /** Model ID that caused the error */
  modelId?: string;
} 