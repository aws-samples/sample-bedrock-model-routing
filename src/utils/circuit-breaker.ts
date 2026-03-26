/**
 * Circuit Breaker implementation for model resilience
 * Implements the Circuit Breaker pattern to prevent cascading failures
 */

import {
  CircuitBreakerConfig,
  CircuitBreakerState,
  CircuitBreakerStatus,
  ErrorType,
  EnhancedErrorResponse
} from '../types/index';

/**
 * Default circuit breaker configuration
 */
export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  recoveryTimeMs: 30000,
  successThreshold: 2,
  failureWindowMs: 60000
};

/**
 * Failure record for tracking
 */
interface FailureRecord {
  timestamp: Date;
  error?: Error;
}

/**
 * Circuit Breaker class for managing model health and availability
 */
export class CircuitBreaker {
  private state: CircuitBreakerState = CircuitBreakerState.CLOSED;
  private readonly config: CircuitBreakerConfig;
  private failures: FailureRecord[] = [];
  private successCount: number = 0;
  private lastOpenedAt?: Date;
  private halfOpenStartedAt?: Date;
  private readonly modelId: string;

  /**
   * Create a new CircuitBreaker
   * @param modelId Model identifier for tracking
   * @param config Optional configuration overrides
   */
  constructor(modelId: string, config: Partial<CircuitBreakerConfig> = {}) {
    this.modelId = modelId;
    this.config = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config };
  }

  /**
   * Get the current state of the circuit breaker
   */
  public getState(): CircuitBreakerState {
    this.updateState();
    return this.state;
  }

  /**
   * Get the full status of the circuit breaker
   */
  public getStatus(): CircuitBreakerStatus {
    this.updateState();
    return {
      state: this.state,
      failureCount: this.getRecentFailureCount(),
      successCount: this.successCount,
      lastOpenedAt: this.lastOpenedAt,
      nextRetryAt: this.state === CircuitBreakerState.OPEN && this.lastOpenedAt
        ? new Date(this.lastOpenedAt.getTime() + this.config.recoveryTimeMs)
        : undefined
    };
  }

  /**
   * Check if the circuit allows a request
   * @returns true if request is allowed, false otherwise
   */
  public canExecute(): boolean {
    this.updateState();
    return this.state !== CircuitBreakerState.OPEN;
  }

  /**
   * Record a successful request
   */
  public recordSuccess(): void {
    this.updateState();

    if (this.state === CircuitBreakerState.HALF_OPEN) {
      this.successCount++;
      if (this.successCount >= this.config.successThreshold) {
        this.close();
      }
    } else if (this.state === CircuitBreakerState.CLOSED) {
      // Clear failures on success in closed state
      this.failures = [];
    }
  }

  /**
   * Record a failed request
   * @param error Optional error to record
   */
  public recordFailure(error?: Error): void {
    this.updateState();
    
    this.failures.push({
      timestamp: new Date(),
      error
    });

    // Clean up old failures outside the window
    this.cleanupOldFailures();

    if (this.state === CircuitBreakerState.HALF_OPEN) {
      // Any failure in half-open state opens the circuit
      this.open();
    } else if (this.state === CircuitBreakerState.CLOSED) {
      if (this.getRecentFailureCount() >= this.config.failureThreshold) {
        this.open();
      }
    }
  }

  /**
   * Get an error response when circuit is open
   */
  public getCircuitOpenError(): EnhancedErrorResponse {
    const status = this.getStatus();
    return {
      code: 503,
      message: `Circuit breaker is open for model ${this.modelId}`,
      errorType: ErrorType.CIRCUIT_OPEN,
      retryable: true,
      retryAfterMs: status.nextRetryAt
        ? Math.max(0, status.nextRetryAt.getTime() - Date.now())
        : this.config.recoveryTimeMs,
      recoverySuggestions: [
        'Wait for the circuit to transition to half-open state',
        'Check model health status',
        'Use an alternative model if available'
      ],
      modelId: this.modelId,
      details: {
        circuitState: this.state,
        failureCount: this.getRecentFailureCount(),
        lastOpenedAt: this.lastOpenedAt?.toISOString(),
        nextRetryAt: status.nextRetryAt?.toISOString()
      }
    };
  }

  /**
   * Force the circuit to open
   */
  public forceOpen(): void {
    this.open();
  }

  /**
   * Force the circuit to close
   */
  public forceClose(): void {
    this.close();
  }

  /**
   * Reset the circuit breaker to initial state
   */
  public reset(): void {
    this.state = CircuitBreakerState.CLOSED;
    this.failures = [];
    this.successCount = 0;
    this.lastOpenedAt = undefined;
    this.halfOpenStartedAt = undefined;
  }

  /**
   * Open the circuit
   */
  private open(): void {
    this.state = CircuitBreakerState.OPEN;
    this.lastOpenedAt = new Date();
    this.successCount = 0;
    this.halfOpenStartedAt = undefined;
  }

  /**
   * Close the circuit
   */
  private close(): void {
    this.state = CircuitBreakerState.CLOSED;
    this.failures = [];
    this.successCount = 0;
    this.halfOpenStartedAt = undefined;
  }

  /**
   * Transition to half-open state
   */
  private halfOpen(): void {
    this.state = CircuitBreakerState.HALF_OPEN;
    this.successCount = 0;
    this.halfOpenStartedAt = new Date();
  }

  /**
   * Update the state based on time
   */
  private updateState(): void {
    if (this.state === CircuitBreakerState.OPEN && this.lastOpenedAt) {
      const timeSinceOpen = Date.now() - this.lastOpenedAt.getTime();
      if (timeSinceOpen >= this.config.recoveryTimeMs) {
        this.halfOpen();
      }
    }
  }

  /**
   * Get the count of failures within the failure window
   */
  private getRecentFailureCount(): number {
    this.cleanupOldFailures();
    return this.failures.length;
  }

  /**
   * Remove failures outside the failure window
   */
  private cleanupOldFailures(): void {
    const cutoff = Date.now() - this.config.failureWindowMs;
    this.failures = this.failures.filter(f => f.timestamp.getTime() > cutoff);
  }
}

/**
 * Circuit breaker manager for multiple models
 */
export class CircuitBreakerManager {
  private readonly breakers: Map<string, CircuitBreaker> = new Map();
  private readonly defaultConfig: CircuitBreakerConfig;

  /**
   * Create a new CircuitBreakerManager
   * @param config Default configuration for new circuit breakers
   */
  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.defaultConfig = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config };
  }

  /**
   * Get or create a circuit breaker for a model
   * @param modelId Model identifier
   * @param config Optional configuration overrides
   */
  public getBreaker(modelId: string, config?: Partial<CircuitBreakerConfig>): CircuitBreaker {
    let breaker = this.breakers.get(modelId);
    if (!breaker) {
      breaker = new CircuitBreaker(modelId, config ?? this.defaultConfig);
      this.breakers.set(modelId, breaker);
    }
    return breaker;
  }

  /**
   * Check if a model's circuit allows requests
   * @param modelId Model identifier
   */
  public canExecute(modelId: string): boolean {
    const breaker = this.breakers.get(modelId);
    return breaker ? breaker.canExecute() : true;
  }

  /**
   * Record a success for a model
   * @param modelId Model identifier
   */
  public recordSuccess(modelId: string): void {
    this.getBreaker(modelId).recordSuccess();
  }

  /**
   * Record a failure for a model
   * @param modelId Model identifier
   * @param error Optional error
   */
  public recordFailure(modelId: string, error?: Error): void {
    this.getBreaker(modelId).recordFailure(error);
  }

  /**
   * Get status for all circuit breakers
   */
  public getAllStatus(): Record<string, CircuitBreakerStatus> {
    const result: Record<string, CircuitBreakerStatus> = {};
    this.breakers.forEach((breaker, modelId) => {
      result[modelId] = breaker.getStatus();
    });
    return result;
  }

  /**
   * Reset all circuit breakers
   */
  public resetAll(): void {
    this.breakers.forEach(breaker => breaker.reset());
  }

  /**
   * Remove a circuit breaker for a model
   * @param modelId Model identifier
   */
  public removeBreaker(modelId: string): void {
    this.breakers.delete(modelId);
  }

  /**
   * Clear all circuit breakers
   */
  public clear(): void {
    this.breakers.clear();
  }
}
