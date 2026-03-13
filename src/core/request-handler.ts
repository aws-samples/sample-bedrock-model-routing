import {
  ModelOutcome,
  OutcomeType,
  SelectModelRequest,
  SelectModelResponse
} from '../types/index.js';
import { BedrockModel, MultiplexerInput } from '../models/bedrock-model.js';
import { ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { MultiplexerError } from './errors.js';

/**
 * RequestHandler manages individual chat requests with retry logic
 * and cross-model failover.
 */
export class RequestHandler {
  private readonly input: MultiplexerInput;
  private readonly multiplexer: RequestHandlerDelegate;
  private readonly maxRetries: number;
  private readonly requestId: string;
  private readonly skippedModels: Set<string> = new Set();

  constructor(
    input: MultiplexerInput,
    multiplexer: RequestHandlerDelegate,
    maxRetries: number = 3,
    requestId: string = ''
  ) {
    this.input = input;
    this.multiplexer = multiplexer;
    this.maxRetries = maxRetries;
    this.requestId = requestId;
  }

  /**
   * Process the request with retry logic.
   *
   * Error contract:
   * - SDK errors are re-thrown in their original form (the last one seen when retries are exhausted).
   * - Multiplexer-level failures (no models available, all breakers open) throw `MultiplexerError`.
   */
  public async process(): Promise<ConverseCommandOutput> {
    let retryCount = 0;
    let lastError: any = null;

    while (retryCount <= this.maxRetries) {
      try {
        // Ask multiplexer to select a model
        const selection = await this.selectModel();
        
        if (!selection.modelId) {
          // No models available — this is a multiplexer-level failure
          throw new MultiplexerError(
            'No models available to process the request',
            'NO_MODELS_AVAILABLE',
            {
              skippedModels: Array.from(this.skippedModels),
              totalSkipped: this.skippedModels.size
            }
          );
        }

        // Get the model instance
        const model = await this.multiplexer.getModel(selection.modelId);
        
        if (!model) {
          // Model not found, skip and try again
          this.skippedModels.add(selection.modelId);
          retryCount++;
          continue;
        }

        // Emit model-invocation-start event
        this.multiplexer.emitEvent('model-invocation-start', selection.modelId, this.requestId);
        const invokeStartTime = Date.now();

        try {
          // Invoke the model
          const result = await model.invoke(this.input);

          // Emit model-invocation-complete event (success path)
          const invokeLatency = Date.now() - invokeStartTime;
          this.multiplexer.emitEvent('model-invocation-complete', selection.modelId, this.requestId, invokeLatency);

          // Report successful outcome to multiplexer
          await this.multiplexer.reportOutcome(result.outcome);

          return result.response;
        } catch (invokeError: any) {
          // Emit model-invocation-complete event (failure path)
          const invokeLatency = Date.now() - invokeStartTime;
          this.multiplexer.emitEvent('model-invocation-complete', selection.modelId, this.requestId, invokeLatency);

          throw invokeError;
        }

      } catch (error: any) {
        lastError = error;

        // If this is already a MultiplexerError (e.g. no models available), throw immediately
        if (error instanceof MultiplexerError) {
          throw error;
        }

        // Check if this is a recoverable error
        const outcome = this.extractOutcome(error);
        
        if (outcome) {
          // Report the outcome to the multiplexer
          await this.multiplexer.reportOutcome(outcome);
          
          // For rate limiting errors, skip this model and try another
          if (outcome.type === OutcomeType.RATE_LIMIT) {
            this.skippedModels.add(outcome.modelId);
            retryCount++;
            continue;
          }
          
          // For circuit-open errors, skip this model and try another
          // (defense-in-depth: breaker may have opened between selection and invocation)
          if (error.name === 'CircuitOpenError') {
            this.skippedModels.add(outcome.modelId);
            retryCount++;
            continue;
          }
        }

        // For fail-fast errors or unknown errors, fail immediately.
        // Re-throw the last SDK error directly — don't wrap in ErrorResponse.
        throw error;
      }
    }

    // Exhausted all retries — throw MultiplexerError with the last SDK error as cause
    throw new MultiplexerError(
      `All retry attempts exhausted (${retryCount} retries)`,
      'RETRIES_EXHAUSTED',
      {
        maxRetries: this.maxRetries,
        actualRetries: retryCount,
        skippedModels: Array.from(this.skippedModels),
        totalSkipped: this.skippedModels.size,
        lastError: lastError?.message
      }
    );
  }

  /**
   * Request model selection from the multiplexer
   * @returns Model selection response
   */
  private async selectModel(): Promise<SelectModelResponse> {
    const request: SelectModelRequest = {
      skippedModels: new Set(this.skippedModels)
    };
    
    return this.multiplexer.selectModel(request);
  }

  /**
   * Extract outcome from error if available
   * @param error The error object
   * @returns ModelOutcome if available, null otherwise
   */
  private extractOutcome(error: any): ModelOutcome | null {
    if (error && error.outcome) {
      return error.outcome;
    }
    return null;
  }
}

/**
 * Interface for RequestHandler to communicate with the Multiplexer
 * This decouples the RequestHandler from the concrete Multiplexer implementation
 */
export interface RequestHandlerDelegate {
  /**
   * Select a model for the request
   * @param request Model selection request
   * @returns Promise resolving to model selection response
   */
  selectModel(request: SelectModelRequest): Promise<SelectModelResponse>;

  /**
   * Get a model instance by ID
   * @param modelId The model identifier
   * @returns Promise resolving to model instance or null if not found
   */
  getModel(modelId: string): Promise<BedrockModel | null>;

  /**
   * Report an outcome back to the multiplexer
   * @param outcome The model outcome to report
   * @returns Promise that resolves when outcome is processed
   */
  reportOutcome(outcome: ModelOutcome): Promise<void>;

  /**
   * Emit an event through the multiplexer's EventEmitter
   * @param event Event name
   * @param args Event arguments
   */
  emitEvent(event: string, ...args: any[]): void;
}
