// AWS SDK imports for Amazon Bedrock Runtime
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseCommandInput,
  ConverseCommandOutput,
  ConverseStreamCommand,
  ConverseStreamCommandInput,
  ConverseStreamCommandOutput,
  ContentBlock,
  Message
} from '@aws-sdk/client-bedrock-runtime';

import {
  ModelConfiguration,
  ModelOutcome,
  OutcomeType,
  ErrorType,
  EnhancedErrorResponse
} from '../types/index.js';
import { classifyError, toErrorResponse, createEnhancedError } from '../utils/error-classifier.js';
import { CircuitBreaker, DEFAULT_CIRCUIT_BREAKER_CONFIG } from '../utils/circuit-breaker.js';

/** The multiplexer owns modelId — callers provide everything else */
export type MultiplexerInput = Omit<ConverseCommandInput, 'modelId'>;

/**
 * BedrockModel wraps Amazon Bedrock API calls with timeout and circuit breaking.
 */
export class BedrockModel {
  private readonly client: BedrockRuntimeClient;
  private readonly config: ModelConfiguration;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly defaultTimeoutMs: number;

  /**
   * Create a new BedrockModel instance
   * @param config Model configuration (modelId, weight, isFallback)
   * @param client Optional pre-configured Amazon Bedrock client (bypasses clientConfig when provided)
   * @param defaultTimeoutMs Default timeout for requests (default: 30000ms)
   * @param circuitBreaker Optional pre-configured CircuitBreaker instance (injected by multiplexer)
   * @param clientConfig Opaque passthrough to `BedrockRuntimeClient` constructor.
   *                     The multiplexer does not inspect or transform these.
   *                     Recommended: include `maxAttempts: 1` for fast failover.
   */
  constructor(
    config: ModelConfiguration,
    client?: BedrockRuntimeClient,
    defaultTimeoutMs: number = 30000,
    circuitBreaker?: CircuitBreaker,
    clientConfig: Record<string, any> = {}
  ) {
    this.config = config;
    this.defaultTimeoutMs = defaultTimeoutMs;
    
    // Use injected circuit breaker or create a standalone one
    this.circuitBreaker = circuitBreaker ?? new CircuitBreaker(config.modelId, DEFAULT_CIRCUIT_BREAKER_CONFIG);
    
    // Create client if not provided — pure passthrough, no opinions on SDK config.
    if (client) {
      this.client = client;
    } else {
      this.client = new BedrockRuntimeClient(clientConfig);
    }
  }

  /**
   * Get the model ID
   */
  public get modelId(): string {
    return this.config.modelId;
  }

  /**
   * Get the model configuration
   */
  public get configuration(): ModelConfiguration {
    return { ...this.config };
  }

  /**
   * Check if this is a fallback model
   */
  public get isFallback(): boolean {
    return this.config.isFallback;
  }

  /**
   * Get the model weight
   */
  public get weight(): number {
    return this.config.weight;
  }

  /**
   * Get circuit breaker instance
   */
  public getCircuitBreaker(): CircuitBreaker {
    return this.circuitBreaker;
  }

  /**
   * Invoke the model with a Converse API input
   * The multiplexer stamps modelId — the caller provides everything else
   */
  public async invoke(input: MultiplexerInput, abortSignal?: AbortSignal): Promise<{
    response: ConverseCommandOutput;
    outcome: ModelOutcome;
  }> {
    // Check circuit breaker
    if (!this.circuitBreaker.canExecute()) {
      const circuitError = this.circuitBreaker.getCircuitOpenError();
      const outcome: ModelOutcome = {
        modelId: this.config.modelId,
        type: OutcomeType.FAIL_FAST,
        latency: 0,
        timestamp: new Date(),
        error: circuitError
      };
      
      const failFastError = new Error(circuitError.message);
      failFastError.name = 'CircuitOpenError';
      (failFastError as any).outcome = outcome;
      (failFastError as any).errorResponse = circuitError;
      throw failFastError;
    }

    const startTime = new Date();
    const timeoutMs = this.defaultTimeoutMs;

    try {
      // Stamp modelId onto the caller's input — the only mutation the multiplexer makes
      const command = new ConverseCommand({ ...input, modelId: this.config.modelId });
      
      const response = await this.executeWithTimeout(
        () => this.client.send(command, { abortSignal }),
        timeoutMs,
        abortSignal
      );
      
      const latency = Date.now() - startTime.getTime();
      
      this.circuitBreaker.recordSuccess();
      
      const outcome: ModelOutcome = {
        modelId: this.config.modelId,
        type: OutcomeType.SUCCESS,
        latency,
        timestamp: new Date()
      };

      return { response, outcome };

    } catch (error: any) {
      // Calculate latency even for errors
      const latency = Date.now() - startTime.getTime();
      
      // Handle cancelled requests
      if (error.name === 'AbortError' || abortSignal?.aborted) {
        const cancelledError = createEnhancedError(
          error,
          ErrorType.CANCELLED,
          this.config.modelId,
          'Request was cancelled'
        );
        
        const outcome: ModelOutcome = {
          modelId: this.config.modelId,
          type: OutcomeType.FAIL_FAST,
          latency,
          timestamp: new Date(),
          error: cancelledError
        };
        
        const failFastError = new Error('Request cancelled');
        failFastError.name = 'CancelledError';
        (failFastError as any).outcome = outcome;
        (failFastError as any).errorResponse = cancelledError;
        throw failFastError;
      }
      
      // Handle timeout
      if (error.name === 'TimeoutError') {
        const timeoutError = createEnhancedError(
          error,
          ErrorType.TIMEOUT,
          this.config.modelId,
          `Request timed out after ${timeoutMs}ms`
        );
        
        // Record failure in circuit breaker
        this.circuitBreaker.recordFailure(error);
        
        const outcome: ModelOutcome = {
          modelId: this.config.modelId,
          type: OutcomeType.FAIL_FAST,
          latency,
          timestamp: new Date(),
          error: timeoutError
        };
        
        const failFastError = new Error(timeoutError.message);
        failFastError.name = 'TimeoutError';
        (failFastError as any).outcome = outcome;
        (failFastError as any).errorResponse = timeoutError;
        throw failFastError;
      }
      
      // Classify the error
      const outcomeType = classifyError(error);
      const errorResponse = toErrorResponse(error);
      
      // Record in circuit breaker
      if (outcomeType === OutcomeType.FAIL_FAST) {
        this.circuitBreaker.recordFailure(error);
      }
      
      // Create error outcome
      const outcome: ModelOutcome = {
        modelId: this.config.modelId,
        type: outcomeType,
        latency,
        timestamp: new Date(),
        error: errorResponse
      };

      // For rate limiting, record as circuit breaker failure and throw
      if (outcomeType === OutcomeType.RATE_LIMIT) {
        this.circuitBreaker.recordFailure(error);
        
        const rateLimitError = new Error('Model rate limited');
        rateLimitError.name = 'RateLimitError';
        (rateLimitError as any).outcome = outcome;
        throw rateLimitError;
      }

      // For other errors, throw a fail-fast error
      const failFastError = new Error(errorResponse.message);
      failFastError.name = 'FailFastError';
      (failFastError as any).outcome = outcome;
      (failFastError as any).errorResponse = errorResponse;
      throw failFastError;
    }
  }

  /**
   * Invoke the model with streaming response.
   * Returns the raw SDK `ConverseStreamCommandOutput` — transparent passthrough.
   * Circuit breaker is checked before sending and updated on success/failure.
   */
  public async invokeStream(input: MultiplexerInput, abortSignal?: AbortSignal): Promise<ConverseStreamCommandOutput> {
    if (!this.circuitBreaker.canExecute()) {
      const circuitError = this.circuitBreaker.getCircuitOpenError();
      throw new Error(circuitError.message);
    }

    const timeoutMs = this.defaultTimeoutMs;

    // Stamp modelId onto the caller's input
    const command = new ConverseStreamCommand({ ...input, modelId: this.config.modelId } as ConverseStreamCommandInput);

    try {
      const response = await this.executeWithTimeout(
        () => this.client.send(command, { abortSignal }),
        timeoutMs,
        abortSignal
      );

      // Record success in circuit breaker
      this.circuitBreaker.recordSuccess();

      // Return raw SDK response — consumers use native SDK streaming primitives
      return response;
    } catch (error: any) {
      // Record failure in circuit breaker
      this.circuitBreaker.recordFailure(error);
      throw error;
    }
  }

  /**
   * Execute a request with timeout support
   */
  private async executeWithTimeout<T>(
    operation: () => Promise<T>,
    timeoutMs: number,
    abortSignal?: AbortSignal
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let timeoutId: NodeJS.Timeout | undefined;
      let isCompleted = false;

      // Handle abort signal
      if (abortSignal?.aborted) {
        const error = new Error('Request aborted');
        error.name = 'AbortError';
        reject(error);
        return;
      }

      const abortListener = () => {
        if (!isCompleted) {
          isCompleted = true;
          if (timeoutId) clearTimeout(timeoutId);
          const error = new Error('Request aborted');
          error.name = 'AbortError';
          reject(error);
        }
      };

      if (abortSignal) {
        abortSignal.addEventListener('abort', abortListener, { once: true });
      }

      // Set timeout
      timeoutId = setTimeout(() => {
        if (!isCompleted) {
          isCompleted = true;
          if (abortSignal) {
            abortSignal.removeEventListener('abort', abortListener);
          }
          const error = new Error(`Request timed out after ${timeoutMs}ms`);
          error.name = 'TimeoutError';
          reject(error);
        }
      }, timeoutMs);

      // Execute operation
      operation()
        .then((result) => {
          if (!isCompleted) {
            isCompleted = true;
            clearTimeout(timeoutId);
            if (abortSignal) {
              abortSignal.removeEventListener('abort', abortListener);
            }
            resolve(result);
          }
        })
        .catch((error) => {
          if (!isCompleted) {
            isCompleted = true;
            clearTimeout(timeoutId);
            if (abortSignal) {
              abortSignal.removeEventListener('abort', abortListener);
            }
            reject(error);
          }
        });
    });
  }

  /**
   * Get the underlying Amazon Bedrock client (for testing)
   */
  public getClient(): BedrockRuntimeClient {
    return this.client;
  }

  /**
   * Destroy the model and clean up resources
   */
  public destroy(): void {
    // Reset circuit breaker
    this.circuitBreaker.reset();
  }
}
