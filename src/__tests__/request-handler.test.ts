/**
 * Unit tests for RequestHandler
 */

import { RequestHandler, RequestHandlerDelegate } from '../core/request-handler';
import { MultiplexerError } from '../core/errors';
import { BedrockModel } from '../models/bedrock-model';
import { OutcomeType, ModelOutcome, SelectModelResponse } from '../types/index';
import { ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';

// Mock BedrockModel
jest.mock('../models/bedrock-model');

/** Helper to build a valid MultiplexerInput (Omit<ConverseCommandInput, 'modelId'>) */
function makeInput(text: string = 'test') {
  return {
    messages: [{ role: 'user' as const, content: [{ text }] }]
  };
}

/** Helper to build a mock ConverseCommandOutput */
function makeOutput(text: string = 'Hello!'): ConverseCommandOutput {
  return {
    output: { message: { role: 'assistant', content: [{ text }] } },
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    metrics: { latencyMs: 100 },
    $metadata: {}
  };
}

describe('RequestHandler', () => {
  let mockDelegate: jest.Mocked<RequestHandlerDelegate>;
  let mockModel: jest.Mocked<BedrockModel>;

  beforeEach(() => {
    jest.clearAllMocks();
    
    mockModel = {
      invoke: jest.fn(),
      modelId: 'test-model',
      isFallback: false,
      weight: 100,
      configuration: {},
      getClient: jest.fn(),
      destroy: jest.fn(),
      getCircuitBreaker: jest.fn(),
      invokeStream: jest.fn()
    } as any;
    
    mockDelegate = {
      selectModel: jest.fn(),
      getModel: jest.fn(),
      reportOutcome: jest.fn(),
      emitEvent: jest.fn()
    };
  });

  describe('constructor', () => {
    it('should create request handler', () => {
      const handler = new RequestHandler(
        makeInput('test'),
        mockDelegate,
        3,
        'req-123'
      );
      expect(handler).toBeDefined();
    });

    it('should use default maxRetries and requestId', () => {
      const handler = new RequestHandler(
        makeInput('test'),
        mockDelegate
      );
      expect(handler).toBeDefined();
    });
  });

  describe('process', () => {
    it('should process request successfully', async () => {
      const response = makeOutput('Hello!');
      const outcome: ModelOutcome = {
        modelId: 'test-model',
        type: OutcomeType.SUCCESS,
        latency: 100,
        timestamp: new Date()
      };
      
      mockDelegate.selectModel.mockResolvedValue({ modelId: 'test-model', isFallback: false });
      mockDelegate.getModel.mockResolvedValue(mockModel);
      mockModel.invoke.mockResolvedValue({ response, outcome });
      
      const handler = new RequestHandler(
        makeInput('test'),
        mockDelegate,
        3
      );
      
      const result = await handler.process();
      
      expect(result).toEqual(response);
      expect(mockDelegate.reportOutcome).toHaveBeenCalledWith(outcome);
    });

    it('should throw MultiplexerError when no models available', async () => {
      mockDelegate.selectModel.mockResolvedValue({ modelId: null, isFallback: false });
      
      const handler = new RequestHandler(
        makeInput('test'),
        mockDelegate,
        3
      );
      
      await expect(handler.process()).rejects.toThrow(MultiplexerError);
      await expect(handler.process()).rejects.toThrow(/No models available/);
    });

    it('should throw MultiplexerError with code NO_MODELS_AVAILABLE', async () => {
      mockDelegate.selectModel.mockResolvedValue({ modelId: null, isFallback: false });
      
      const handler = new RequestHandler(
        makeInput('test'),
        mockDelegate,
        3
      );
      
      try {
        await handler.process();
        fail('Should have thrown');
      } catch (error: any) {
        expect(error).toBeInstanceOf(MultiplexerError);
        expect(error.code).toBe('NO_MODELS_AVAILABLE');
        expect(error.name).toBe('MultiplexerError');
      }
    });

    it('should retry when model is not found', async () => {
      const response = makeOutput('Success!');
      const outcome: ModelOutcome = {
        modelId: 'model-2',
        type: OutcomeType.SUCCESS,
        latency: 100,
        timestamp: new Date()
      };
      
      mockDelegate.selectModel
        .mockResolvedValueOnce({ modelId: 'model-1', isFallback: false })
        .mockResolvedValueOnce({ modelId: 'model-2', isFallback: false });
      
      mockDelegate.getModel
        .mockResolvedValueOnce(null) // First model not found
        .mockResolvedValueOnce(mockModel);
      
      mockModel.invoke.mockResolvedValue({ response, outcome });
      
      const handler = new RequestHandler(
        makeInput('test'),
        mockDelegate,
        3
      );
      
      const result = await handler.process();
      
      expect(result).toEqual(response);
      expect(mockDelegate.selectModel).toHaveBeenCalledTimes(2);
    });

    it('should retry on rate limit error', async () => {
      const rateLimitOutcome: ModelOutcome = {
        modelId: 'model-1',
        type: OutcomeType.RATE_LIMIT,
        latency: 50,
        timestamp: new Date()
      };
      
      const rateLimitError = new Error('Rate limited');
      rateLimitError.name = 'RateLimitError';
      (rateLimitError as any).outcome = rateLimitOutcome;
      
      const successResponse = makeOutput('Success!');
      const successOutcome: ModelOutcome = {
        modelId: 'model-2',
        type: OutcomeType.SUCCESS,
        latency: 100,
        timestamp: new Date()
      };
      
      const secondModel = { ...mockModel, modelId: 'model-2' };
      
      mockDelegate.selectModel
        .mockResolvedValueOnce({ modelId: 'model-1', isFallback: false })
        .mockResolvedValueOnce({ modelId: 'model-2', isFallback: false });
      
      mockDelegate.getModel
        .mockResolvedValueOnce(mockModel)
        .mockResolvedValueOnce(secondModel as any);
      
      mockModel.invoke.mockRejectedValueOnce(rateLimitError);
      (secondModel as any).invoke = jest.fn().mockResolvedValue({
        response: successResponse,
        outcome: successOutcome
      });
      
      const handler = new RequestHandler(
        makeInput('test'),
        mockDelegate,
        3
      );
      
      const result = await handler.process();
      
      expect(result).toEqual(successResponse);
      expect(mockDelegate.reportOutcome).toHaveBeenCalledWith(rateLimitOutcome);
    });

    it('should passthrough fail-fast errors directly (not as ErrorResponse)', async () => {
      const failFastError = new Error('Validation failed');
      failFastError.name = 'FailFastError';
      (failFastError as any).errorResponse = { code: 400, message: 'Validation failed' };
      
      mockDelegate.selectModel.mockResolvedValue({ modelId: 'test-model', isFallback: false });
      mockDelegate.getModel.mockResolvedValue(mockModel);
      mockModel.invoke.mockRejectedValue(failFastError);
      
      const handler = new RequestHandler(
        makeInput('test'),
        mockDelegate,
        3
      );
      
      try {
        await handler.process();
        fail('Should have thrown');
      } catch (error: any) {
        // Error should be the original Error instance, not a plain {code, message} object
        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe('FailFastError');
        expect(error.message).toBe('Validation failed');
      }
    });

    it('should throw MultiplexerError after exhausting retries', async () => {
      const rateLimitOutcome: ModelOutcome = {
        modelId: 'test-model',
        type: OutcomeType.RATE_LIMIT,
        latency: 50,
        timestamp: new Date()
      };
      
      const rateLimitError = new Error('Rate limited');
      rateLimitError.name = 'RateLimitError';
      (rateLimitError as any).outcome = rateLimitOutcome;
      
      mockDelegate.selectModel.mockResolvedValue({ modelId: 'test-model', isFallback: false });
      mockDelegate.getModel.mockResolvedValue(mockModel);
      mockModel.invoke.mockRejectedValue(rateLimitError);
      
      const handler = new RequestHandler(
        makeInput('test'),
        mockDelegate,
        2
      );
      
      try {
        await handler.process();
        fail('Should have thrown');
      } catch (error: any) {
        expect(error).toBeInstanceOf(MultiplexerError);
        expect(error.code).toBe('RETRIES_EXHAUSTED');
        expect(error.message).toContain('retry');
      }
    });

    it('should passthrough unknown errors as Error instances', async () => {
      const unknownError = new Error('Something went wrong');
      
      mockDelegate.selectModel.mockResolvedValue({ modelId: 'test-model', isFallback: false });
      mockDelegate.getModel.mockResolvedValue(mockModel);
      mockModel.invoke.mockRejectedValue(unknownError);
      
      const handler = new RequestHandler(
        makeInput('test'),
        mockDelegate,
        3
      );
      
      try {
        await handler.process();
        fail('Should have thrown');
      } catch (error: any) {
        // Should be the original error, not an ErrorResponse plain object
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe('Something went wrong');
      }
    });

    it('should emit model-invocation-start and model-invocation-complete on success', async () => {
      const response = makeOutput('Hello!');
      const outcome: ModelOutcome = {
        modelId: 'test-model',
        type: OutcomeType.SUCCESS,
        latency: 100,
        timestamp: new Date()
      };

      mockDelegate.selectModel.mockResolvedValue({ modelId: 'test-model', isFallback: false });
      mockDelegate.getModel.mockResolvedValue(mockModel);
      mockModel.invoke.mockResolvedValue({ response, outcome });

      const handler = new RequestHandler(
        makeInput('test'),
        mockDelegate,
        3,
        'req-abc'
      );

      await handler.process();

      // model-invocation-start should be emitted before invoke
      expect(mockDelegate.emitEvent).toHaveBeenCalledWith(
        'model-invocation-start', 'test-model', 'req-abc'
      );
      // model-invocation-complete should be emitted after invoke with latency
      expect(mockDelegate.emitEvent).toHaveBeenCalledWith(
        'model-invocation-complete', 'test-model', 'req-abc', expect.any(Number)
      );

      // start should come before complete
      const calls = mockDelegate.emitEvent.mock.calls;
      const startIdx = calls.findIndex((c: any[]) => c[0] === 'model-invocation-start');
      const completeIdx = calls.findIndex((c: any[]) => c[0] === 'model-invocation-complete');
      expect(startIdx).toBeLessThan(completeIdx);
    });

    it('should emit model-invocation-complete on invoke failure', async () => {
      const rateLimitOutcome: ModelOutcome = {
        modelId: 'test-model',
        type: OutcomeType.RATE_LIMIT,
        latency: 50,
        timestamp: new Date()
      };

      const rateLimitError = new Error('Rate limited');
      rateLimitError.name = 'RateLimitError';
      (rateLimitError as any).outcome = rateLimitOutcome;

      // First call fails, then no models available so it throws MultiplexerError
      mockDelegate.selectModel
        .mockResolvedValueOnce({ modelId: 'test-model', isFallback: false })
        .mockResolvedValue({ modelId: null, isFallback: false });
      mockDelegate.getModel.mockResolvedValue(mockModel);
      mockModel.invoke.mockRejectedValue(rateLimitError);

      const handler = new RequestHandler(
        makeInput('test'),
        mockDelegate,
        1,
        'req-fail'
      );

      await expect(handler.process()).rejects.toBeDefined();

      // Both events should have fired even though the invocation failed
      expect(mockDelegate.emitEvent).toHaveBeenCalledWith(
        'model-invocation-start', 'test-model', 'req-fail'
      );
      expect(mockDelegate.emitEvent).toHaveBeenCalledWith(
        'model-invocation-complete', 'test-model', 'req-fail', expect.any(Number)
      );
    });

    it('should emit invocation events per retry attempt', async () => {
      const rateLimitOutcome: ModelOutcome = {
        modelId: 'model-1',
        type: OutcomeType.RATE_LIMIT,
        latency: 50,
        timestamp: new Date()
      };

      const rateLimitError = new Error('Rate limited');
      rateLimitError.name = 'RateLimitError';
      (rateLimitError as any).outcome = rateLimitOutcome;

      const successResponse = makeOutput('Success!');
      const successOutcome: ModelOutcome = {
        modelId: 'model-2',
        type: OutcomeType.SUCCESS,
        latency: 100,
        timestamp: new Date()
      };

      const secondModel = { ...mockModel, modelId: 'model-2' };

      mockDelegate.selectModel
        .mockResolvedValueOnce({ modelId: 'model-1', isFallback: false })
        .mockResolvedValueOnce({ modelId: 'model-2', isFallback: false });

      mockDelegate.getModel
        .mockResolvedValueOnce(mockModel)
        .mockResolvedValueOnce(secondModel as any);

      mockModel.invoke.mockRejectedValueOnce(rateLimitError);
      (secondModel as any).invoke = jest.fn().mockResolvedValue({
        response: successResponse,
        outcome: successOutcome
      });

      const handler = new RequestHandler(
        makeInput('test'),
        mockDelegate,
        3,
        'req-retry'
      );

      await handler.process();

      // Should see 2 start events and 2 complete events (one per invocation attempt)
      const startCalls = mockDelegate.emitEvent.mock.calls.filter(
        (c: any[]) => c[0] === 'model-invocation-start'
      );
      const completeCalls = mockDelegate.emitEvent.mock.calls.filter(
        (c: any[]) => c[0] === 'model-invocation-complete'
      );

      expect(startCalls).toHaveLength(2);
      expect(completeCalls).toHaveLength(2);

      // First attempt: model-1
      expect(startCalls[0]).toEqual(['model-invocation-start', 'model-1', 'req-retry']);
      expect(completeCalls[0][1]).toBe('model-1');

      // Second attempt: model-2
      expect(startCalls[1]).toEqual(['model-invocation-start', 'model-2', 'req-retry']);
      expect(completeCalls[1][1]).toBe('model-2');
    });

    it('should handle error with outcome attached', async () => {
      const outcome: ModelOutcome = {
        modelId: 'test-model',
        type: OutcomeType.FAIL_FAST,
        latency: 100,
        timestamp: new Date()
      };
      
      const errorWithOutcome = new Error('Test error');
      (errorWithOutcome as any).outcome = outcome;
      
      mockDelegate.selectModel.mockResolvedValue({ modelId: 'test-model', isFallback: false });
      mockDelegate.getModel.mockResolvedValue(mockModel);
      mockModel.invoke.mockRejectedValue(errorWithOutcome);
      
      const handler = new RequestHandler(
        makeInput('test'),
        mockDelegate,
        3
      );
      
      await expect(handler.process()).rejects.toBeDefined();
      expect(mockDelegate.reportOutcome).toHaveBeenCalledWith(outcome);
    });

    it('should retry on CircuitOpenError by skipping the model', async () => {
      const circuitOpenError = new Error('Circuit breaker is open for model-1');
      circuitOpenError.name = 'CircuitOpenError';
      (circuitOpenError as any).outcome = {
        modelId: 'model-1',
        type: OutcomeType.FAIL_FAST,
        latency: 0,
        timestamp: new Date()
      };
      
      const successResponse = makeOutput('Success!');
      const successOutcome: ModelOutcome = {
        modelId: 'model-2',
        type: OutcomeType.SUCCESS,
        latency: 100,
        timestamp: new Date()
      };
      
      const secondModel = { ...mockModel, modelId: 'model-2' };
      
      mockDelegate.selectModel
        .mockResolvedValueOnce({ modelId: 'model-1', isFallback: false })
        .mockResolvedValueOnce({ modelId: 'model-2', isFallback: false });
      
      mockDelegate.getModel
        .mockResolvedValueOnce(mockModel)
        .mockResolvedValueOnce(secondModel as any);
      
      mockModel.invoke.mockRejectedValueOnce(circuitOpenError);
      (secondModel as any).invoke = jest.fn().mockResolvedValue({
        response: successResponse,
        outcome: successOutcome
      });
      
      const handler = new RequestHandler(
        makeInput('test'),
        mockDelegate,
        3
      );
      
      const result = await handler.process();
      
      expect(result).toEqual(successResponse);
      // model-1 should be skipped on the second selection
      const secondCallArg = mockDelegate.selectModel.mock.calls[1][0];
      expect(secondCallArg.skippedModels.has('model-1')).toBe(true);
    });

    it('should skip previously tried models', async () => {
      const rateLimitError = new Error('Rate limited');
      rateLimitError.name = 'RateLimitError';
      (rateLimitError as any).outcome = {
        modelId: 'model-1',
        type: OutcomeType.RATE_LIMIT,
        latency: 50,
        timestamp: new Date()
      };
      
      mockDelegate.selectModel
        .mockResolvedValueOnce({ modelId: 'model-1', isFallback: false })
        .mockResolvedValueOnce({ modelId: null, isFallback: false }); // No more models
      
      mockDelegate.getModel.mockResolvedValue(mockModel);
      mockModel.invoke.mockRejectedValue(rateLimitError);
      
      const handler = new RequestHandler(
        makeInput('test'),
        mockDelegate,
        3
      );
      
      await expect(handler.process()).rejects.toBeDefined();
      
      // Second call should have skipped model-1
      expect(mockDelegate.selectModel).toHaveBeenCalledTimes(2);
      const secondCallArg = mockDelegate.selectModel.mock.calls[1][0];
      expect(secondCallArg.skippedModels.has('model-1')).toBe(true);
    });

    it('should throw proper Error instances, not plain objects (Issue #17)', async () => {
      const unknownError = new Error('Something went wrong');
      
      mockDelegate.selectModel.mockResolvedValue({ modelId: 'test-model', isFallback: false });
      mockDelegate.getModel.mockResolvedValue(mockModel);
      mockModel.invoke.mockRejectedValue(unknownError);
      
      const handler = new RequestHandler(
        makeInput('test'),
        mockDelegate,
        3
      );
      
      try {
        await handler.process();
        fail('Should have thrown');
      } catch (error: any) {
        // Must be an Error instance — not a plain object with {code, message}
        expect(error).toBeInstanceOf(Error);
        expect(error.stack).toBeDefined();
      }
    });
  });
});
