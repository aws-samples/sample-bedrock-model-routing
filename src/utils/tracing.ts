/**
 * X-Ray Tracing utility for the Amazon Bedrock Model Multiplexer
 * Provides optional X-Ray tracing functionality with graceful fallback
 */

/**
 * Interface for X-Ray tracer functionality
 */
export interface TracerInterface {
  putAnnotation(key: string, value: any): void;
  putMetadata(key: string, value: any): void;
  getSegment(): any;
  setSegment(segment: any): void;
}

/**
 * Configuration for tracing
 */
export interface TracingConfig {
  enabled: boolean;
  serviceName?: string | undefined;
  captureBodies?: boolean | undefined;
  captureModelSelection?: boolean | undefined;
}

/**
 * Tracing utility class that handles X-Ray integration
 */
export class MultiplexerTracer {
  private tracer: TracerInterface | null = null;
  private config: TracingConfig;

  constructor(config: TracingConfig) {
    this.config = config;
    
    if (config.enabled) {
      this.initializeTracer();
    }
  }

  /**
   * Initialize the X-Ray tracer if available
   */
  private initializeTracer(): void {
    import('@aws-lambda-powertools/tracer').then(({ Tracer }) => {
      this.tracer = new Tracer({
        serviceName: this.config.serviceName ?? 'bedrock-multiplexer'
      });
    }).catch(() => {
      // Tracer not available, continue without tracing
      this.tracer = null;
    });
  }

  /**
   * Check if tracing is enabled and available
   */
  public isEnabled(): boolean {
    return this.config.enabled && this.tracer !== null;
  }

  /**
   * Add an annotation to the current trace
   */
  public putAnnotation(key: string, value: any): void {
    if (this.tracer) {
      try {
        this.tracer.putAnnotation(key, value);
      } catch (error) {
        // Ignore tracing errors to prevent disrupting the main flow
      }
    }
  }

  /**
   * Add metadata to the current trace
   */
  public putMetadata(key: string, value: any): void {
    if (this.tracer && this.config.captureBodies) {
      try {
        this.tracer.putMetadata(key, value);
      } catch (error) {
        // Ignore tracing errors to prevent disrupting the main flow
      }
    }
  }

  /**
   * Create a subsegment for a specific operation
   */
  public createSubsegment(name: string): any {
    if (this.tracer) {
      try {
        const parentSegment = this.tracer.getSegment();
        if (parentSegment) {
          return parentSegment.addNewSubsegment(name);
        }
      } catch (error) {
        // Ignore tracing errors
      }
    }
    return null;
  }

  /**
   * Set the active segment
   */
  public setSegment(segment: any): void {
    if (this.tracer && segment) {
      try {
        this.tracer.setSegment(segment);
      } catch (error) {
        // Ignore tracing errors
      }
    }
  }

  /**
   * Close a segment
   */
  public closeSegment(segment: any): void {
    if (segment) {
      try {
        segment.close();
      } catch (error) {
        // Ignore tracing errors
      }
    }
  }

  /**
   * Trace a request with automatic timing and error handling
   */
  public async traceOperation<T>(
    operationName: string,
    operation: () => Promise<T>,
    metadata?: Record<string, any>
  ): Promise<T> {
    const segment = this.createSubsegment(operationName);
    const startTime = Date.now();
    
    try {
      // Add initial metadata
      if (metadata) {
        Object.entries(metadata).forEach(([key, value]) => {
          this.putAnnotation(key, value);
        });
      }
      
      // Set the segment as active
      this.setSegment(segment);
      
      // Execute the operation
      const result = await operation();
      
      // Add success annotations
      this.putAnnotation('outcome', 'success');
      this.putAnnotation('latency_ms', Date.now() - startTime);
      
      return result;
    } catch (error: any) {
      // Add error annotations
      this.putAnnotation('outcome', 'error');
      this.putAnnotation('error_type', error.name || 'UnknownError');
      this.putAnnotation('latency_ms', Date.now() - startTime);
      
      // Add error metadata if enabled
      if (this.config.captureBodies) {
        this.putMetadata('error', {
          message: error.message,
          stack: error.stack,
          code: error.code
        });
      }
      
      throw error;
    } finally {
      // Close the segment
      this.closeSegment(segment);
    }
  }

  /**
   * Generate a unique request ID for tracking
   */
  public generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

/**
 * Create a tracer instance with the given configuration
 */
export function createTracer(config: TracingConfig): MultiplexerTracer {
  return new MultiplexerTracer(config);
} 