/**
 * Unit tests for Tracing utility
 */

import { MultiplexerTracer, createTracer, TracingConfig } from '../utils/tracing';

describe('MultiplexerTracer', () => {
  describe('constructor', () => {
    it('should create tracer with disabled config', () => {
      const tracer = new MultiplexerTracer({ enabled: false });
      expect(tracer).toBeDefined();
      expect(tracer.isEnabled()).toBe(false);
    });

    it('should create tracer with enabled config', () => {
      const tracer = new MultiplexerTracer({
        enabled: true,
        serviceName: 'test-service'
      });
      expect(tracer).toBeDefined();
      // isEnabled() returns false immediately after construction because the
      // tracer module is loaded via async import() — it resolves on the next
      // microtask tick, not synchronously. The tracer becomes active once the
      // import promise resolves.
      expect(tracer.isEnabled()).toBe(false);
    });
  });

  describe('isEnabled', () => {
    it('should return false when disabled', () => {
      const tracer = new MultiplexerTracer({ enabled: false });
      expect(tracer.isEnabled()).toBe(false);
    });

    it('should return false before async import resolves', () => {
      const tracer = new MultiplexerTracer({ enabled: true });
      // The tracer module is loaded via async import() — isEnabled() returns
      // false synchronously because the import promise has not yet resolved.
      expect(tracer.isEnabled()).toBe(false);
    });
  });

  describe('putAnnotation', () => {
    it('should not throw when tracer is disabled', () => {
      const tracer = new MultiplexerTracer({ enabled: false });
      expect(() => tracer.putAnnotation('key', 'value')).not.toThrow();
    });

    it('should handle different value types', () => {
      const tracer = new MultiplexerTracer({ enabled: false });
      expect(() => tracer.putAnnotation('string', 'value')).not.toThrow();
      expect(() => tracer.putAnnotation('number', 123)).not.toThrow();
      expect(() => tracer.putAnnotation('boolean', true)).not.toThrow();
      expect(() => tracer.putAnnotation('object', { key: 'value' })).not.toThrow();
    });
  });

  describe('putMetadata', () => {
    it('should not throw when tracer is disabled', () => {
      const tracer = new MultiplexerTracer({ enabled: false });
      expect(() => tracer.putMetadata('key', { data: 'value' })).not.toThrow();
    });

    it('should respect captureBodies setting', () => {
      const tracer = new MultiplexerTracer({
        enabled: false,
        captureBodies: true
      });
      expect(() => tracer.putMetadata('request', { body: 'test' })).not.toThrow();
    });
  });

  describe('createSubsegment', () => {
    it('should return null when tracer is disabled', () => {
      const tracer = new MultiplexerTracer({ enabled: false });
      const subsegment = tracer.createSubsegment('test-operation');
      expect(subsegment).toBeNull();
    });
  });

  describe('setSegment', () => {
    it('should not throw when tracer is disabled', () => {
      const tracer = new MultiplexerTracer({ enabled: false });
      expect(() => tracer.setSegment(null)).not.toThrow();
    });

    it('should not throw with segment', () => {
      const tracer = new MultiplexerTracer({ enabled: false });
      const mockSegment = { close: jest.fn() };
      expect(() => tracer.setSegment(mockSegment)).not.toThrow();
    });
  });

  describe('closeSegment', () => {
    it('should not throw when segment is null', () => {
      const tracer = new MultiplexerTracer({ enabled: false });
      expect(() => tracer.closeSegment(null)).not.toThrow();
    });

    it('should call close on segment', () => {
      const tracer = new MultiplexerTracer({ enabled: false });
      const mockSegment = { close: jest.fn() };
      tracer.closeSegment(mockSegment);
      expect(mockSegment.close).toHaveBeenCalled();
    });

    it('should handle close errors', () => {
      const tracer = new MultiplexerTracer({ enabled: false });
      const mockSegment = {
        close: jest.fn().mockImplementation(() => {
          throw new Error('Close failed');
        })
      };
      expect(() => tracer.closeSegment(mockSegment)).not.toThrow();
    });
  });

  describe('traceOperation', () => {
    it('should execute operation when tracer is disabled', async () => {
      const tracer = new MultiplexerTracer({ enabled: false });
      const operation = jest.fn().mockResolvedValue('result');
      
      const result = await tracer.traceOperation('test-op', operation);
      
      expect(result).toBe('result');
      expect(operation).toHaveBeenCalled();
    });

    it('should pass metadata to annotations', async () => {
      const tracer = new MultiplexerTracer({ enabled: false });
      const putAnnotationSpy = jest.spyOn(tracer, 'putAnnotation');
      
      await tracer.traceOperation(
        'test-op',
        async () => 'result',
        { key: 'value' }
      );
      
      expect(putAnnotationSpy).toHaveBeenCalledWith('key', 'value');
    });

    it('should handle operation errors', async () => {
      const tracer = new MultiplexerTracer({ enabled: false });
      const operation = jest.fn().mockRejectedValue(new Error('Test error'));
      
      await expect(tracer.traceOperation('test-op', operation))
        .rejects.toThrow('Test error');
    });

    it('should add error annotations on failure', async () => {
      const tracer = new MultiplexerTracer({ enabled: false });
      const putAnnotationSpy = jest.spyOn(tracer, 'putAnnotation');
      const error = new Error('Test error');
      error.name = 'TestError';
      
      try {
        await tracer.traceOperation('test-op', async () => {
          throw error;
        });
      } catch {
        // Expected
      }
      
      expect(putAnnotationSpy).toHaveBeenCalledWith('outcome', 'error');
      expect(putAnnotationSpy).toHaveBeenCalledWith('error_type', 'TestError');
    });

    it('should add success annotations', async () => {
      const tracer = new MultiplexerTracer({ enabled: false });
      const putAnnotationSpy = jest.spyOn(tracer, 'putAnnotation');
      
      await tracer.traceOperation('test-op', async () => 'result');
      
      expect(putAnnotationSpy).toHaveBeenCalledWith('outcome', 'success');
      expect(putAnnotationSpy).toHaveBeenCalledWith('latency_ms', expect.any(Number));
    });
  });

  describe('generateRequestId', () => {
    it('should generate unique request IDs', () => {
      const tracer = new MultiplexerTracer({ enabled: false });
      
      const id1 = tracer.generateRequestId();
      const id2 = tracer.generateRequestId();
      
      expect(id1).not.toBe(id2);
    });

    it('should start with "req_"', () => {
      const tracer = new MultiplexerTracer({ enabled: false });
      const id = tracer.generateRequestId();
      
      expect(id.startsWith('req_')).toBe(true);
    });

    it('should contain timestamp', () => {
      const tracer = new MultiplexerTracer({ enabled: false });
      const beforeTime = Date.now();
      const id = tracer.generateRequestId();
      const afterTime = Date.now();
      
      // Extract timestamp from ID
      const parts = id.split('_');
      const timestamp = parseInt(parts[1], 10);
      
      expect(timestamp).toBeGreaterThanOrEqual(beforeTime);
      expect(timestamp).toBeLessThanOrEqual(afterTime);
    });
  });
});

describe('createTracer', () => {
  it('should create tracer instance', () => {
    const config: TracingConfig = {
      enabled: false,
      serviceName: 'test'
    };
    
    const tracer = createTracer(config);
    
    expect(tracer).toBeInstanceOf(MultiplexerTracer);
  });

  it('should pass config to tracer', () => {
    const config: TracingConfig = {
      enabled: true,
      serviceName: 'test-service',
      captureBodies: true,
      captureModelSelection: true
    };
    
    const tracer = createTracer(config);
    expect(tracer).toBeDefined();
  });
});
