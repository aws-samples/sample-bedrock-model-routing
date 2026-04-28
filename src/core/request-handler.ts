import {
  ModelOutcome,
  OutcomeType,
  SelectModelRequest,
  SelectModelResponse,
  ServiceTierType,
  TierEscalationConfig
} from '../types/index';
import { BedrockModel, MultiplexerInput } from '../models/bedrock-model';
import { ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { MultiplexerError } from './errors';
import { extractResponseText } from '../classifiers/response-extractor';

/**
 * RequestHandler manages individual chat requests with retry logic,
 * cross-model failover, and service tier escalation.
 */
export class RequestHandler {
  private readonly input: MultiplexerInput;
  private readonly multiplexer: RequestHandlerDelegate;
  private readonly maxRetries: number;
  private readonly requestId: string;
  private readonly skippedModels: Set<string> = new Set();
  /** Tracks models that have already attempted tier escalation for this request */
  private readonly tierEscalatedModels: Set<string> = new Set();

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
          // Invoke the model (at default/Standard tier)
          const result = await model.invoke(this.input);

          // Emit model-invocation-complete event (success path)
          const invokeLatency = Date.now() - invokeStartTime;
          this.multiplexer.emitEvent('model-invocation-complete', selection.modelId, this.requestId, invokeLatency);

          // --- REFUSAL DETECTION ---
          // If refusal detection is enabled, classify the response before returning
          if (this.multiplexer.refusalRetryEnabled) {
            const responseText = extractResponseText(result.response);
            const classification = await this.multiplexer.classifyRefusal(responseText);

            if (classification) {
              // Emit classification event (always, regardless of result)
              this.multiplexer.emitEvent(
                'refusal-classification',
                selection.modelId,
                classification.isRefusal,
                classification.confidence,
                classification.latencyMs
              );

              if (classification.isRefusal) {
                // Emit refusal-detected event
                this.multiplexer.emitEvent(
                  'refusal-detected',
                  selection.modelId,
                  classification.confidence,
                  responseText
                );

                // Report refusal outcome
                const refusalOutcome: ModelOutcome = {
                  modelId: selection.modelId,
                  type: OutcomeType.REFUSAL,
                  latency: result.outcome.latency,
                  timestamp: new Date()
                };
                await this.multiplexer.reportOutcome(refusalOutcome);

                // Skip this model and retry with a different one (same as throttle path)
                this.skippedModels.add(selection.modelId);
                retryCount++;
                continue;
              }
            }
          }
          // --- END REFUSAL DETECTION ---

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
          
          // For rate limiting errors, attempt tier escalation before skipping the model
          if (outcome.type === OutcomeType.RATE_LIMIT) {
            const escalationResult = await this.attemptTierEscalation(outcome.modelId);
            if (escalationResult) {
              // Tier escalation succeeded — return the response
              return escalationResult;
            }
            // Tier escalation not available or failed — skip model and try another
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
   * Attempt to retry the same model at a higher service tier.
   * Returns the response if escalation succeeds, or null if escalation
   * is not available or fails (caller should proceed with cross-model failover).
   *
   * Tier escalation gets one attempt per model per request.
   */
  private async attemptTierEscalation(modelId: string): Promise<ConverseCommandOutput | null> {
    const tierConfig = this.multiplexer.tierEscalationConfig;

    // Tier escalation not enabled
    if (!tierConfig?.enabled) {
      return null;
    }

    // Already attempted escalation for this model in this request
    if (this.tierEscalatedModels.has(modelId)) {
      return null;
    }

    // Mark this model as having attempted escalation
    this.tierEscalatedModels.add(modelId);

    const escalationTier = tierConfig.escalationTier;
    const fromTier: ServiceTierType = 'default';

    // Emit tier-escalation event
    this.multiplexer.emitEvent('tier-escalation', modelId, fromTier, escalationTier);

    // Get the model instance
    const model = await this.multiplexer.getModel(modelId);
    if (!model) {
      return null;
    }

    try {
      // Retry the same model at the escalation tier
      const result = await model.invoke(this.input, undefined, escalationTier);

      // Emit tier-escalation-success event
      this.multiplexer.emitEvent('tier-escalation-success', modelId, escalationTier);

      // Run refusal detection on the escalated response if enabled
      if (this.multiplexer.refusalRetryEnabled) {
        const responseText = extractResponseText(result.response);
        const classification = await this.multiplexer.classifyRefusal(responseText);

        if (classification) {
          this.multiplexer.emitEvent(
            'refusal-classification',
            modelId,
            classification.isRefusal,
            classification.confidence,
            classification.latencyMs
          );

          if (classification.isRefusal) {
            this.multiplexer.emitEvent(
              'refusal-detected',
              modelId,
              classification.confidence,
              responseText
            );

            const refusalOutcome: ModelOutcome = {
              modelId,
              type: OutcomeType.REFUSAL,
              latency: result.outcome.latency,
              timestamp: new Date()
            };
            await this.multiplexer.reportOutcome(refusalOutcome);

            // Refusal on escalated tier — fall through to cross-model failover
            return null;
          }
        }
      }

      // Report successful outcome
      await this.multiplexer.reportOutcome(result.outcome);

      return result.response;
    } catch (escalationError: any) {
      // Emit tier-escalation-failure event
      this.multiplexer.emitEvent(
        'tier-escalation-failure',
        modelId,
        escalationTier,
        escalationError.message || 'Unknown error'
      );

      // Report the escalation failure outcome if available
      const escalationOutcome = this.extractOutcome(escalationError);
      if (escalationOutcome) {
        await this.multiplexer.reportOutcome(escalationOutcome);
      }

      // Escalation failed — return null so caller proceeds with cross-model failover
      return null;
    }
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

  /**
   * Classify a model response for refusal. Returns null if refusal detection is disabled.
   * @param responseText Extracted text from the model response
   * @returns Classification result or null
   */
  classifyRefusal(responseText: string): Promise<{ isRefusal: boolean; confidence: number; latencyMs: number } | null>;

  /**
   * Whether refusal detection is configured and retry-on-refusal is enabled.
   */
  refusalRetryEnabled: boolean;

  /**
   * Service tier escalation configuration, or undefined if not configured.
   * Used by RequestHandler to decide whether to retry at a higher tier on throttling.
   */
  tierEscalationConfig: TierEscalationConfig | undefined;
}
