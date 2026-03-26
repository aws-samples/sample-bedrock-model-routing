import { EventEmitter } from 'events';

import {
  ModelConfiguration,
  ModelOutcome,
  ModelStats,
  MultiplexerConfig,
  MultiplexerEvents,
  MultiplexerStats,
  OutcomeType,
  SelectModelRequest,
  SelectModelResponse,
  LatencyMetrics,
  SystemHealthStatus,
  ModelHealthStatus,
  CircuitBreakerState
} from '../types/index';
import { BedrockModel, MultiplexerInput } from '../models/bedrock-model';
import { ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { RequestHandler, RequestHandlerDelegate } from './request-handler';
import { 
  weightedRandomSelect, 
  createWeightedItem,
  WeightedItem 
} from '../utils/weighted-selection';

import { MultiplexerTracer, createTracer } from '../utils/tracing';
import { CircuitBreakerManager, DEFAULT_CIRCUIT_BREAKER_CONFIG } from '../utils/circuit-breaker';
import { HealthCheckManager, HealthCheckEndpoint } from '../utils/health-check';
import { MultiplexerConfigValidator, assertValid } from '../utils/validation';
import { RefusalClassifier } from '../classifiers/refusal-classifier';

/**
 * Model information maintained by the multiplexer
 */
interface ModelInfo {
  model: BedrockModel;
  weight: number;
  isFallback: boolean;
  stats: ModelStats;
}

/**
 * BedrockMultiplexer manages multiple Amazon Bedrock models with weighted routing,
 * circuit breaking, and retry logic.
 */
export class BedrockMultiplexer extends EventEmitter implements RequestHandlerDelegate {
  private readonly config: MultiplexerConfig;
  private readonly primaryModels: Map<string, ModelInfo> = new Map();
  private readonly fallbackModels: Map<string, ModelInfo> = new Map();
  private readonly latencyBuffer: number[];
  private latencyHead: number = 0;
  private latencyCount: number = 0;
  private readonly maxLatencyHistory = 1000; // Keep last 1000 latencies for percentiles
  private readonly tracer: MultiplexerTracer; // X-Ray tracer instance
  private readonly circuitBreakerManager: CircuitBreakerManager;
  private readonly healthCheckManager: HealthCheckManager;
  private readonly healthCheckEndpoint: HealthCheckEndpoint;
  private refusalClassifier: RefusalClassifier | null = null;
  private classifierReady: Promise<void> | null = null;

  /**
   * Create a new BedrockMultiplexer
   * @param config Multiplexer configuration
   */
  constructor(config: MultiplexerConfig) {
    super();
    
    // Default no-op 'error' listener to prevent Node.js EventEmitter from throwing
    // on unhandled 'error' events. Errors are already propagated via Promise rejections
    // in processRequest(). Consumers can register additional 'error' listeners for
    // observability (e.g., logging, metrics).
    this.on('error', () => {});
    
    // Validate configuration
    const validationResult = MultiplexerConfigValidator.validate(config);
    assertValid(validationResult);
    
    this.config = config;
    
    // Initialize X-Ray tracer
    this.tracer = createTracer({
      enabled: config.tracing?.enabled || false,
      serviceName: config.tracing?.serviceName,
      captureBodies: config.tracing?.captureBodies,
      captureModelSelection: config.tracing?.captureModelSelection
    });
    
    // Initialize circuit breaker manager
    this.circuitBreakerManager = new CircuitBreakerManager(DEFAULT_CIRCUIT_BREAKER_CONFIG);
    
    // Initialize latency ring buffer
    this.latencyBuffer = new Array(this.maxLatencyHistory).fill(0);
    
    // Initialize health check manager
    this.healthCheckManager = new HealthCheckManager(this.circuitBreakerManager);
    this.healthCheckEndpoint = new HealthCheckEndpoint(this.healthCheckManager);
    
    // Initialize refusal classifier if configured (opt-in)
    if (config.refusalDetection?.enabled) {
      this.refusalClassifier = new RefusalClassifier({
        modelPath: config.refusalDetection.modelPath,
        confidenceThreshold: config.refusalDetection.confidenceThreshold
      });
      // Start async initialization — classifyRefusal() awaits this before classifying
      this.classifierReady = this.refusalClassifier.initialize().catch((err) => {
        // Graceful degradation: log warning and continue without classification
        console.warn(`[BedrockMultiplexer] Failed to initialize refusal classifier: ${err.message}. Refusal detection will be disabled.`);
        this.refusalClassifier = null;
        this.classifierReady = null;
      });
    }

    this.initializeModels();
  }

  /**
   * Add a model to the multiplexer
   * @param modelConfig Model configuration
   */
  public addModel(modelConfig: ModelConfiguration): void {
    // Get or create the circuit breaker from the manager — single source of truth
    const breaker = this.circuitBreakerManager.getBreaker(modelConfig.modelId);
    const model = new BedrockModel(modelConfig, undefined, this.config.defaultTimeoutMs, breaker, this.config.clientConfig);
    
    const modelInfo: ModelInfo = {
      model,
      weight: modelConfig.weight,
      isFallback: modelConfig.isFallback,
      stats: {
        modelId: modelConfig.modelId,
        successCount: 0,
        rateLimitCount: 0,
        failFastCount: 0,
        refusalCount: 0,
        averageLatency: 0,
        isFallback: modelConfig.isFallback
      }
    };

    if (modelConfig.isFallback) {
      this.fallbackModels.set(modelConfig.modelId, modelInfo);
    } else {
      this.primaryModels.set(modelConfig.modelId, modelInfo);
    }

    // Register with health check manager
    this.healthCheckManager.registerModel(modelConfig.modelId);

    this.emit('model-added', modelConfig.modelId);
  }

  /**
   * Remove a model from the multiplexer
   * @param modelId Model ID to remove
   */
  public removeModel(modelId: string): void {
    const primaryInfo = this.primaryModels.get(modelId);
    const fallbackInfo = this.fallbackModels.get(modelId);
    
    if (primaryInfo) {
      primaryInfo.model.destroy();
      this.primaryModels.delete(modelId);
    }
    
    if (fallbackInfo) {
      fallbackInfo.model.destroy();
      this.fallbackModels.delete(modelId);
    }

    // Clean up health check and circuit breaker
    this.healthCheckManager.unregisterModel(modelId);
    this.circuitBreakerManager.removeBreaker(modelId);

    this.emit('model-removed', modelId);
  }

  /**
   * Process a chat request through the multiplexer
   * @param message Chat message to process
   * @returns Promise resolving to chat response
   */
  public async processRequest(input: MultiplexerInput): Promise<ConverseCommandOutput> {
    const requestId = this.tracer.generateRequestId();
    
    return this.tracer.traceOperation(
      'BedrockMultiplexer.processRequest',
      async () => {
        this.emit('request', input);

        // Add request metadata to trace
        this.tracer.putAnnotation('request_id', requestId);
        this.tracer.putAnnotation('model_count', this.primaryModels.size + this.fallbackModels.size);
        this.tracer.putAnnotation('primary_models', this.primaryModels.size);
        this.tracer.putAnnotation('fallback_models', this.fallbackModels.size);
        
        // Add request body to metadata if enabled
        if (this.config.tracing?.captureBodies) {
          this.tracer.putMetadata('request', input);
        }

        try {
          const handler = new RequestHandler(
            input,
            this,
            this.config.maxRetries,
            requestId
          );

          const response = await handler.process();
          
          // Add success metadata to trace
          this.tracer.putAnnotation('outcome', 'success');
          if (this.config.tracing?.captureBodies) {
            this.tracer.putMetadata('response', response);
          }
          
          return response;
        } catch (error: any) {
          // Add error metadata to trace
          this.tracer.putAnnotation('outcome', 'error');
          this.tracer.putAnnotation('error_message', error.message || 'Unknown error');
          if (error.code) {
            this.tracer.putAnnotation('error_code', error.code);
          }

          this.emit('error', error, null as any);

          // Passthrough the error as-is — SDK errors, MultiplexerErrors, etc.
          // Consumers get the original error type with full stack trace and metadata.
          throw error;
        }
      },
      {
        request_id: requestId,
        service: 'bedrock-multiplexer'
      }
    );
  }

  /**
   * Get current multiplexer statistics
   * @returns Current statistics
   */
  public getStats(): MultiplexerStats {
    const allModels = [
      ...Array.from(this.primaryModels.values()),
      ...Array.from(this.fallbackModels.values())
    ];

    const totalSuccess = allModels.reduce((sum, info) => sum + info.stats.successCount, 0);
    const totalRateLimit = allModels.reduce((sum, info) => sum + info.stats.rateLimitCount, 0);
    const totalFailFast = allModels.reduce((sum, info) => sum + info.stats.failFastCount, 0);
    const totalRefusal = allModels.reduce((sum, info) => sum + info.stats.refusalCount, 0);

    const modelStats: Record<string, ModelStats> = {};
    allModels.forEach(info => {
      modelStats[info.stats.modelId] = { ...info.stats };
    });

    return {
      successCount: totalSuccess,
      rateLimitCount: totalRateLimit,
      failFastCount: totalFailFast,
      refusalCount: totalRefusal,
      modelStats,
      latencyMetrics: this.calculateLatencyMetrics()
    };
  }

  /**
   * Reset all statistics
   */
  public resetStats(): void {
    const allModels = [
      ...Array.from(this.primaryModels.values()),
      ...Array.from(this.fallbackModels.values())
    ];

    allModels.forEach(info => {
      info.stats.successCount = 0;
      info.stats.rateLimitCount = 0;
      info.stats.failFastCount = 0;
      info.stats.refusalCount = 0;
      info.stats.averageLatency = 0;
    });

    this.latencyHead = 0;
    this.latencyCount = 0;
    this.emit('stats-reset');
  }

  /**
   * Select a model for a request (implements RequestHandlerDelegate)
   * @param request Model selection request
   * @returns Promise resolving to model selection response
   */
  public async selectModel(request: SelectModelRequest): Promise<SelectModelResponse> {
    if (this.config.tracing?.captureModelSelection) {
      return this.tracer.traceOperation(
        'BedrockMultiplexer.selectModel',
        async () => {
          // Add model selection metadata
          this.tracer.putAnnotation('skipped_models_count', request.skippedModels.size);
          this.tracer.putAnnotation('available_primary_models', this.primaryModels.size);
          this.tracer.putAnnotation('available_fallback_models', this.fallbackModels.size);
          
          if (this.config.tracing?.captureBodies) {
            this.tracer.putMetadata('skipped_models', Array.from(request.skippedModels));
          }

          // Try primary models first
          const selectedPrimary = this.selectFromPool(this.primaryModels, request.skippedModels);
          if (selectedPrimary) {
            this.tracer.putAnnotation('selected_model_type', 'primary');
            this.tracer.putAnnotation('selected_model_id', selectedPrimary);
            
            this.emit('model-selected', selectedPrimary, false, request.skippedModels.size);
            
            return { modelId: selectedPrimary, isFallback: false };
          }

          // Fall back to fallback models
          const selectedFallback = this.selectFromPool(this.fallbackModels, request.skippedModels);
          if (selectedFallback) {
            this.tracer.putAnnotation('selected_model_type', 'fallback');
            this.tracer.putAnnotation('selected_model_id', selectedFallback);
            
            this.emit('model-selected', selectedFallback, true, request.skippedModels.size);
            
            return { modelId: selectedFallback, isFallback: true };
          }

          // No models available
          this.tracer.putAnnotation('selected_model_type', 'none');
          return { modelId: null, isFallback: false };
        }
      );
    } else {
      // Quick path without detailed tracing
      const selectedPrimary = this.selectFromPool(this.primaryModels, request.skippedModels);
      if (selectedPrimary) {
        this.emit('model-selected', selectedPrimary, false, request.skippedModels.size);
        return { modelId: selectedPrimary, isFallback: false };
      }

      const selectedFallback = this.selectFromPool(this.fallbackModels, request.skippedModels);
      if (selectedFallback) {
        this.emit('model-selected', selectedFallback, true, request.skippedModels.size);
        return { modelId: selectedFallback, isFallback: true };
      }

      return { modelId: null, isFallback: false };
    }
  }

  /**
   * Get a model instance by ID (implements RequestHandlerDelegate)
   * @param modelId Model identifier
   * @returns Promise resolving to model instance or null
   */
  public async getModel(modelId: string): Promise<BedrockModel | null> {
    const primaryInfo = this.primaryModels.get(modelId);
    if (primaryInfo) {
      return primaryInfo.model;
    }

    const fallbackInfo = this.fallbackModels.get(modelId);
    if (fallbackInfo) {
      return fallbackInfo.model;
    }

    return null;
  }

  /**
   * Report an outcome (implements RequestHandlerDelegate)
   * @param outcome Model outcome
   */
  public async reportOutcome(outcome: ModelOutcome): Promise<void> {
    const modelInfo = this.primaryModels.get(outcome.modelId) || 
                     this.fallbackModels.get(outcome.modelId);
    
    if (!modelInfo) {
      return; // Model not found
    }

    // Update statistics
    this.updateModelStats(modelInfo, outcome);
    
    // Record latency
    this.recordLatency(outcome.latency);

    // Update health metrics (circuit breaker recording is handled by BedrockModel.invoke()
    // via the shared breaker instance — no duplicate recording here)
    if (outcome.type === OutcomeType.SUCCESS) {
      this.healthCheckManager.recordSuccess(outcome.modelId, outcome.latency);
    } else {
      this.healthCheckManager.recordFailure(outcome.modelId, outcome.latency);
    }

    // Emit events
    if (outcome.type === OutcomeType.SUCCESS) {
      this.emit('success', null, outcome);
    } else {
      this.emit('error', outcome.error || null, outcome);
    }

    // Emit periodic stats
    this.emit('stats', this.getStats());
  }

  /**
   * Initialize models from configuration
   */
  private initializeModels(): void {
    for (const modelConfig of this.config.models) {
      this.addModel(modelConfig);
    }
  }

  /**
   * Select a model from a specific pool using circuit breaker state for availability.
   * Models with open circuit breakers are excluded from selection.
   * @param pool Model pool to select from
   * @param skippedModels Models to skip
   * @returns Selected model ID or null
   */
  private selectFromPool(pool: Map<string, ModelInfo>, skippedModels: Set<string>): string | null {
    const availableModels: WeightedItem<string>[] = [];
    
    pool.forEach((info, modelId) => {
      if (skippedModels.has(modelId)) {
        return;
      }
      
      if (!this.circuitBreakerManager.canExecute(modelId)) {
        this.emit('model-circuit-open-skipped', modelId);
        return;
      }
      
      availableModels.push(createWeightedItem(modelId, info.weight));
    });

    // Use weighted random selection
    return weightedRandomSelect(availableModels);
  }

  /**
   * Update model statistics with an outcome
   * @param modelInfo Model information
   * @param outcome Outcome to record
   */
  private updateModelStats(modelInfo: ModelInfo, outcome: ModelOutcome): void {
    const stats = modelInfo.stats;
    
    switch (outcome.type) {
      case OutcomeType.SUCCESS:
        stats.successCount++;
        break;
      case OutcomeType.RATE_LIMIT:
        stats.rateLimitCount++;
        break;
      case OutcomeType.FAIL_FAST:
        stats.failFastCount++;
        break;
      case OutcomeType.REFUSAL:
        stats.refusalCount++;
        break;
    }

    // Update average latency
    const totalRequests = stats.successCount + stats.rateLimitCount + stats.failFastCount + stats.refusalCount;
    if (totalRequests > 0) {
      stats.averageLatency = (stats.averageLatency * (totalRequests - 1) + outcome.latency) / totalRequests;
    }
  }

  /**
   * Record latency for overall metrics using a ring buffer.
   * O(1) insertion — overwrites the oldest entry when the buffer is full.
   * @param latency Latency in milliseconds
   */
  private recordLatency(latency: number): void {
    this.latencyBuffer[this.latencyHead] = latency;
    this.latencyHead = (this.latencyHead + 1) % this.maxLatencyHistory;
    if (this.latencyCount < this.maxLatencyHistory) {
      this.latencyCount++;
    }
  }

  /**
   * Calculate latency metrics from the ring buffer
   * @returns Latency metrics
   */
  private calculateLatencyMetrics(): LatencyMetrics {
    if (this.latencyCount === 0) {
      return {
        average: 0,
        p50: 0,
        p95: 0,
        p99: 0,
        min: 0,
        max: 0
      };
    }

    // Extract active entries from the ring buffer
    const active: number[] = new Array(this.latencyCount);
    if (this.latencyCount < this.maxLatencyHistory) {
      // Buffer not yet full — entries are at indices [0, latencyCount)
      for (let i = 0; i < this.latencyCount; i++) {
        active[i] = this.latencyBuffer[i];
      }
    } else {
      // Buffer full — head points to the next write slot (i.e. the oldest entry)
      for (let i = 0; i < this.latencyCount; i++) {
        active[i] = this.latencyBuffer[(this.latencyHead + i) % this.maxLatencyHistory];
      }
    }

    const sorted = active.sort((a, b) => a - b);
    const len = sorted.length;

    return {
      average: active.reduce((sum, lat) => sum + lat, 0) / len,
      p50: sorted[Math.floor(len * 0.5)],
      p95: sorted[Math.floor(len * 0.95)],
      p99: sorted[Math.floor(len * 0.99)],
      min: sorted[0],
      max: sorted[len - 1]
    };
  }

  /**
   * Get system health status
   * @returns System health status
   */
  public getHealthStatus(): SystemHealthStatus {
    const modelStatsMap: Record<string, ModelStats> = {};
    
    const allModels = [
      ...Array.from(this.primaryModels.entries()),
      ...Array.from(this.fallbackModels.entries())
    ];
    
    allModels.forEach(([modelId, info]) => {
      modelStatsMap[modelId] = { ...info.stats };
    });
    
    return this.healthCheckManager.getSystemHealth(modelStatsMap);
  }

  /**
   * Get health status for a specific model
   * @param modelId Model identifier
   * @returns Model health status or null if model not found
   */
  public getModelHealthStatus(modelId: string): ModelHealthStatus | null {
    const modelInfo = this.primaryModels.get(modelId) || this.fallbackModels.get(modelId);
    if (!modelInfo) {
      return null;
    }
    
    return this.healthCheckManager.getModelHealth(
      modelId,
      modelInfo.stats
    );
  }

  /**
   * Get simple health check response (for load balancers)
   * @returns Simple health status
   */
  public getSimpleHealthCheck(): { status: 'healthy' | 'unhealthy'; code: number } {
    const modelStatsMap: Record<string, ModelStats> = {};
    
    const allModels = [
      ...Array.from(this.primaryModels.entries()),
      ...Array.from(this.fallbackModels.entries())
    ];
    
    allModels.forEach(([modelId, info]) => {
      modelStatsMap[modelId] = { ...info.stats };
    });
    
    return this.healthCheckEndpoint.getSimpleHealth(modelStatsMap);
  }

  /**
   * Check if the multiplexer is healthy and can accept requests
   * @returns True if healthy
   */
  public isHealthy(): boolean {
    return this.getSimpleHealthCheck().status === 'healthy';
  }

  /**
   * Get circuit breaker status for all models
   * @returns Circuit breaker status map
   */
  public getCircuitBreakerStatus(): Record<string, { state: CircuitBreakerState; failureCount: number }> {
    const allStatus = this.circuitBreakerManager.getAllStatus();
    const result: Record<string, { state: CircuitBreakerState; failureCount: number }> = {};
    
    Object.entries(allStatus).forEach(([modelId, status]) => {
      result[modelId] = {
        state: status.state,
        failureCount: status.failureCount
      };
    });
    
    return result;
  }

  /**
   * Emit an event through the multiplexer's EventEmitter (implements RequestHandlerDelegate).
   * This allows RequestHandler to emit events without a direct dependency on EventEmitter.
   * @param event Event name
   * @param args Event arguments
   */
  public emitEvent(event: string, ...args: any[]): void {
    this.emit(event as any, ...args);
  }

  /**
   * Classify a model response for refusal (implements RequestHandlerDelegate).
   * Returns null if refusal detection is disabled or the classifier failed to load.
   * @param responseText Extracted text from the model response
   * @returns Classification result or null
   */
  public async classifyRefusal(responseText: string): Promise<{ isRefusal: boolean; confidence: number; latencyMs: number } | null> {
    if (!this.refusalClassifier || !this.classifierReady) {
      return null; // Refusal detection not enabled or failed to initialize
    }

    // Ensure the ONNX session is loaded
    await this.classifierReady;

    // After awaiting, the classifier may have been nulled out by the catch handler
    if (!this.refusalClassifier) {
      return null;
    }

    return this.refusalClassifier.classify(responseText);
  }

  /**
   * Whether refusal detection is configured and the retry-on-refusal behavior is enabled.
   * Used by RequestHandler to decide whether to run post-inference classification.
   */
  public get refusalRetryEnabled(): boolean {
    return this.config.refusalDetection?.enabled === true &&
           this.config.refusalDetection?.retryOnRefusal !== false;
  }

  /**
   * Destroy the multiplexer and clean up resources
   */
  public destroy(): void {
    // Clean up all models
    this.primaryModels.forEach((info) => {
      info.model.destroy();
    });

    this.fallbackModels.forEach((info) => {
      info.model.destroy();
    });

    // Clean up refusal classifier
    if (this.refusalClassifier) {
      this.refusalClassifier.destroy();
      this.refusalClassifier = null;
      this.classifierReady = null;
    }

    this.primaryModels.clear();
    this.fallbackModels.clear();
    this.circuitBreakerManager.clear();
    this.healthCheckManager.resetAllMetrics();
    this.removeAllListeners();
  }
}

// Type the EventEmitter methods for strong event typing via declaration merging
export interface BedrockMultiplexer {
  on<K extends keyof MultiplexerEvents>(event: K, listener: MultiplexerEvents[K]): this;
  once<K extends keyof MultiplexerEvents>(event: K, listener: MultiplexerEvents[K]): this;
  off<K extends keyof MultiplexerEvents>(event: K, listener: MultiplexerEvents[K]): this;
  removeListener<K extends keyof MultiplexerEvents>(event: K, listener: MultiplexerEvents[K]): this;
  emit<K extends keyof MultiplexerEvents>(event: K, ...args: Parameters<MultiplexerEvents[K]>): boolean;
}
