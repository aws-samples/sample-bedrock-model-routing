/**
 * Unit tests for RequestHandler
 */

import { RequestHandler, RequestHandlerDelegate } from '../core/request-handler';
import { MultiplexerError } from '../core/errors';
import { BedrockModel } from '../models/bedrock-model';
import { OutcomeType, ModelOutcome, SelectModelResponse, TierEscalationConfig } from '../types/index';
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
      emitEvent: jest.fn(),
      classifyRefusal: jest.fn().mockResolvedValue(null),
      refusalRetryEnabled: false,
      tierEscalationConfig: undefined
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

    describe('refusal detection', () => {
      it('should skip classification when refusalRetryEnabled is false', async () => {
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
        mockDelegate.refusalRetryEnabled = false;

        const handler = new RequestHandler(makeInput('test'), mockDelegate, 3);
        const result = await handler.process();

        expect(result).toEqual(response);
        expect(mockDelegate.classifyRefusal).not.toHaveBeenCalled();
      });

      it('should return response normally when classifier returns non-refusal', async () => {
        const response = makeOutput('Here is the answer.');
        const outcome: ModelOutcome = {
          modelId: 'test-model',
          type: OutcomeType.SUCCESS,
          latency: 100,
          timestamp: new Date()
        };

        mockDelegate.selectModel.mockResolvedValue({ modelId: 'test-model', isFallback: false });
        mockDelegate.getModel.mockResolvedValue(mockModel);
        mockModel.invoke.mockResolvedValue({ response, outcome });
        mockDelegate.refusalRetryEnabled = true;
        mockDelegate.classifyRefusal.mockResolvedValue({
          isRefusal: false,
          confidence: 0.1,
          latencyMs: 2
        });

        const handler = new RequestHandler(makeInput('test'), mockDelegate, 3);
        const result = await handler.process();

        expect(result).toEqual(response);
        expect(mockDelegate.classifyRefusal).toHaveBeenCalledWith('Here is the answer.');
        expect(mockDelegate.reportOutcome).toHaveBeenCalledWith(outcome);
        // Should emit refusal-classification event
        expect(mockDelegate.emitEvent).toHaveBeenCalledWith(
          'refusal-classification', 'test-model', false, 0.1, 2
        );
      });

      it('should retry with different model when refusal is detected', async () => {
        const refusalResponse = makeOutput("I can't help with that.");
        const refusalOutcome: ModelOutcome = {
          modelId: 'model-1',
          type: OutcomeType.SUCCESS,
          latency: 100,
          timestamp: new Date()
        };

        const successResponse = makeOutput('Here is the answer.');
        const successOutcome: ModelOutcome = {
          modelId: 'model-2',
          type: OutcomeType.SUCCESS,
          latency: 150,
          timestamp: new Date()
        };

        const secondModel = { ...mockModel, modelId: 'model-2' };

        mockDelegate.selectModel
          .mockResolvedValueOnce({ modelId: 'model-1', isFallback: false })
          .mockResolvedValueOnce({ modelId: 'model-2', isFallback: false });

        mockDelegate.getModel
          .mockResolvedValueOnce(mockModel)
          .mockResolvedValueOnce(secondModel as any);

        mockModel.invoke.mockResolvedValue({ response: refusalResponse, outcome: refusalOutcome });
        (secondModel as any).invoke = jest.fn().mockResolvedValue({
          response: successResponse,
          outcome: successOutcome
        });

        mockDelegate.refusalRetryEnabled = true;
        mockDelegate.classifyRefusal
          .mockResolvedValueOnce({ isRefusal: true, confidence: 0.92, latencyMs: 3 })
          .mockResolvedValueOnce({ isRefusal: false, confidence: 0.05, latencyMs: 2 });

        const handler = new RequestHandler(makeInput('test'), mockDelegate, 3);
        const result = await handler.process();

        expect(result).toEqual(successResponse);

        // Should have emitted refusal-detected for model-1
        expect(mockDelegate.emitEvent).toHaveBeenCalledWith(
          'refusal-detected', 'model-1', 0.92, "I can't help with that."
        );

        // Should have reported REFUSAL outcome for model-1
        expect(mockDelegate.reportOutcome).toHaveBeenCalledWith(
          expect.objectContaining({
            modelId: 'model-1',
            type: OutcomeType.REFUSAL
          })
        );

        // model-1 should be skipped on second selection
        const secondCallArg = mockDelegate.selectModel.mock.calls[1][0];
        expect(secondCallArg.skippedModels.has('model-1')).toBe(true);
      });

      it('should handle classifier returning null (disabled)', async () => {
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
        mockDelegate.refusalRetryEnabled = true;
        mockDelegate.classifyRefusal.mockResolvedValue(null);

        const handler = new RequestHandler(makeInput('test'), mockDelegate, 3);
        const result = await handler.process();

        expect(result).toEqual(response);
        // Should NOT emit refusal-classification when classifier returns null
        expect(mockDelegate.emitEvent).not.toHaveBeenCalledWith(
          'refusal-classification', expect.anything(), expect.anything(), expect.anything(), expect.anything()
        );
      });

      it('should exhaust retries when all models refuse', async () => {
        const refusalResponse = makeOutput("I can't do that.");
        const outcome: ModelOutcome = {
          modelId: 'test-model',
          type: OutcomeType.SUCCESS,
          latency: 100,
          timestamp: new Date()
        };

        mockDelegate.selectModel
          .mockResolvedValueOnce({ modelId: 'test-model', isFallback: false })
          .mockResolvedValue({ modelId: null, isFallback: false });

        mockDelegate.getModel.mockResolvedValue(mockModel);
        mockModel.invoke.mockResolvedValue({ response: refusalResponse, outcome });
        mockDelegate.refusalRetryEnabled = true;
        mockDelegate.classifyRefusal.mockResolvedValue({
          isRefusal: true,
          confidence: 0.95,
          latencyMs: 2
        });

        const handler = new RequestHandler(makeInput('test'), mockDelegate, 1);

        try {
          await handler.process();
          fail('Should have thrown');
        } catch (error: any) {
          expect(error).toBeInstanceOf(MultiplexerError);
          expect(error.code).toBe('NO_MODELS_AVAILABLE');
        }
      });
    });

    describe('tier escalation', () => {
      it('should not attempt tier escalation when not configured', async () => {
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

        mockDelegate.tierEscalationConfig = undefined;

        const handler = new RequestHandler(makeInput('test'), mockDelegate, 3);
        const result = await handler.process();

        expect(result).toEqual(successResponse);
        // Should NOT emit tier-escalation event
        expect(mockDelegate.emitEvent).not.toHaveBeenCalledWith(
          'tier-escalation', expect.anything(), expect.anything(), expect.anything()
        );
      });

      it('should escalate to priority tier on throttling when configured', async () => {
        const rateLimitOutcome: ModelOutcome = {
          modelId: 'test-model',
          type: OutcomeType.RATE_LIMIT,
          latency: 50,
          timestamp: new Date()
        };

        const rateLimitError = new Error('Rate limited');
        rateLimitError.name = 'RateLimitError';
        (rateLimitError as any).outcome = rateLimitOutcome;

        const escalatedResponse = makeOutput('Escalated success!');
        const escalatedOutcome: ModelOutcome = {
          modelId: 'test-model',
          type: OutcomeType.SUCCESS,
          latency: 80,
          timestamp: new Date()
        };

        mockDelegate.selectModel.mockResolvedValue({ modelId: 'test-model', isFallback: false });
        mockDelegate.getModel.mockResolvedValue(mockModel);

        // First invoke at default tier fails with rate limit
        mockModel.invoke
          .mockRejectedValueOnce(rateLimitError)
          // Second invoke at priority tier succeeds
          .mockResolvedValueOnce({ response: escalatedResponse, outcome: escalatedOutcome });

        mockDelegate.tierEscalationConfig = { enabled: true, escalationTier: 'priority' };

        const handler = new RequestHandler(makeInput('test'), mockDelegate, 3);
        const result = await handler.process();

        expect(result).toEqual(escalatedResponse);

        // Should have emitted tier-escalation event
        expect(mockDelegate.emitEvent).toHaveBeenCalledWith(
          'tier-escalation', 'test-model', 'default', 'priority'
        );

        // Should have emitted tier-escalation-success event
        expect(mockDelegate.emitEvent).toHaveBeenCalledWith(
          'tier-escalation-success', 'test-model', 'priority'
        );

        // Second invoke should have been called with 'priority' tier
        expect(mockModel.invoke).toHaveBeenCalledTimes(2);
        expect(mockModel.invoke.mock.calls[1][2]).toBe('priority');
      });

      it('should escalate to reserved tier when configured', async () => {
        const rateLimitOutcome: ModelOutcome = {
          modelId: 'test-model',
          type: OutcomeType.RATE_LIMIT,
          latency: 50,
          timestamp: new Date()
        };

        const rateLimitError = new Error('Rate limited');
        rateLimitError.name = 'RateLimitError';
        (rateLimitError as any).outcome = rateLimitOutcome;

        const escalatedResponse = makeOutput('Reserved success!');
        const escalatedOutcome: ModelOutcome = {
          modelId: 'test-model',
          type: OutcomeType.SUCCESS,
          latency: 60,
          timestamp: new Date()
        };

        mockDelegate.selectModel.mockResolvedValue({ modelId: 'test-model', isFallback: false });
        mockDelegate.getModel.mockResolvedValue(mockModel);

        mockModel.invoke
          .mockRejectedValueOnce(rateLimitError)
          .mockResolvedValueOnce({ response: escalatedResponse, outcome: escalatedOutcome });

        mockDelegate.tierEscalationConfig = { enabled: true, escalationTier: 'reserved' };

        const handler = new RequestHandler(makeInput('test'), mockDelegate, 3);
        const result = await handler.process();

        expect(result).toEqual(escalatedResponse);
        expect(mockModel.invoke.mock.calls[1][2]).toBe('reserved');
      });

      it('should fall back to cross-model failover when escalation also fails', async () => {
        const rateLimitOutcome: ModelOutcome = {
          modelId: 'model-1',
          type: OutcomeType.RATE_LIMIT,
          latency: 50,
          timestamp: new Date()
        };

        const rateLimitError = new Error('Rate limited');
        rateLimitError.name = 'RateLimitError';
        (rateLimitError as any).outcome = rateLimitOutcome;

        const escalationError = new Error('Still rate limited at priority');
        escalationError.name = 'RateLimitError';
        (escalationError as any).outcome = {
          modelId: 'model-1',
          type: OutcomeType.RATE_LIMIT,
          latency: 30,
          timestamp: new Date()
        };

        const successResponse = makeOutput('Model 2 success!');
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
          .mockResolvedValueOnce(mockModel) // For escalation attempt
          .mockResolvedValueOnce(secondModel as any);

        mockModel.invoke
          .mockRejectedValueOnce(rateLimitError)   // Default tier fails
          .mockRejectedValueOnce(escalationError);  // Priority tier also fails

        (secondModel as any).invoke = jest.fn().mockResolvedValue({
          response: successResponse,
          outcome: successOutcome
        });

        mockDelegate.tierEscalationConfig = { enabled: true, escalationTier: 'priority' };

        const handler = new RequestHandler(makeInput('test'), mockDelegate, 3);
        const result = await handler.process();

        expect(result).toEqual(successResponse);

        // Should have emitted tier-escalation-failure
        expect(mockDelegate.emitEvent).toHaveBeenCalledWith(
          'tier-escalation-failure', 'model-1', 'priority', expect.any(String)
        );
      });

      it('should only attempt tier escalation once per model per request', async () => {
        const rateLimitOutcome1: ModelOutcome = {
          modelId: 'test-model',
          type: OutcomeType.RATE_LIMIT,
          latency: 50,
          timestamp: new Date()
        };

        const rateLimitError1 = new Error('Rate limited');
        rateLimitError1.name = 'RateLimitError';
        (rateLimitError1 as any).outcome = rateLimitOutcome1;

        const escalationError = new Error('Still rate limited');
        escalationError.name = 'RateLimitError';
        (escalationError as any).outcome = {
          modelId: 'test-model',
          type: OutcomeType.RATE_LIMIT,
          latency: 30,
          timestamp: new Date()
        };

        mockDelegate.selectModel
          .mockResolvedValueOnce({ modelId: 'test-model', isFallback: false })
          .mockResolvedValue({ modelId: null, isFallback: false });

        mockDelegate.getModel.mockResolvedValue(mockModel);

        mockModel.invoke
          .mockRejectedValueOnce(rateLimitError1)   // Default tier fails
          .mockRejectedValueOnce(escalationError);   // Priority tier also fails

        mockDelegate.tierEscalationConfig = { enabled: true, escalationTier: 'priority' };

        const handler = new RequestHandler(makeInput('test'), mockDelegate, 3);

        try {
          await handler.process();
          fail('Should have thrown');
        } catch (error: any) {
          expect(error).toBeInstanceOf(MultiplexerError);
        }

        // tier-escalation should only be emitted once for this model
        const escalationCalls = mockDelegate.emitEvent.mock.calls.filter(
          (c: any[]) => c[0] === 'tier-escalation'
        );
        expect(escalationCalls).toHaveLength(1);
      });

      it('should not attempt tier escalation for non-throttling errors', async () => {
        const failFastOutcome: ModelOutcome = {
          modelId: 'test-model',
          type: OutcomeType.FAIL_FAST,
          latency: 50,
          timestamp: new Date()
        };

        const failFastError = new Error('Validation failed');
        failFastError.name = 'FailFastError';
        (failFastError as any).outcome = failFastOutcome;

        mockDelegate.selectModel.mockResolvedValue({ modelId: 'test-model', isFallback: false });
        mockDelegate.getModel.mockResolvedValue(mockModel);
        mockModel.invoke.mockRejectedValue(failFastError);

        mockDelegate.tierEscalationConfig = { enabled: true, escalationTier: 'priority' };

        const handler = new RequestHandler(makeInput('test'), mockDelegate, 3);

        await expect(handler.process()).rejects.toBeDefined();

        // Should NOT emit tier-escalation event for non-throttling errors
        expect(mockDelegate.emitEvent).not.toHaveBeenCalledWith(
          'tier-escalation', expect.anything(), expect.anything(), expect.anything()
        );
      });

      it('should run refusal detection on escalated response', async () => {
        const rateLimitOutcome: ModelOutcome = {
          modelId: 'test-model',
          type: OutcomeType.RATE_LIMIT,
          latency: 50,
          timestamp: new Date()
        };

        const rateLimitError = new Error('Rate limited');
        rateLimitError.name = 'RateLimitError';
        (rateLimitError as any).outcome = rateLimitOutcome;

        const escalatedResponse = makeOutput('Here is the answer.');
        const escalatedOutcome: ModelOutcome = {
          modelId: 'test-model',
          type: OutcomeType.SUCCESS,
          latency: 80,
          timestamp: new Date()
        };

        mockDelegate.selectModel.mockResolvedValue({ modelId: 'test-model', isFallback: false });
        mockDelegate.getModel.mockResolvedValue(mockModel);

        mockModel.invoke
          .mockRejectedValueOnce(rateLimitError)
          .mockResolvedValueOnce({ response: escalatedResponse, outcome: escalatedOutcome });

        mockDelegate.tierEscalationConfig = { enabled: true, escalationTier: 'priority' };
        mockDelegate.refusalRetryEnabled = true;
        mockDelegate.classifyRefusal.mockResolvedValue({
          isRefusal: false,
          confidence: 0.1,
          latencyMs: 2
        });

        const handler = new RequestHandler(makeInput('test'), mockDelegate, 3);
        const result = await handler.process();

        expect(result).toEqual(escalatedResponse);
        expect(mockDelegate.classifyRefusal).toHaveBeenCalledWith('Here is the answer.');
      });

      it('should fall through to cross-model failover when escalated response is a refusal', async () => {
        const rateLimitOutcome: ModelOutcome = {
          modelId: 'model-1',
          type: OutcomeType.RATE_LIMIT,
          latency: 50,
          timestamp: new Date()
        };

        const rateLimitError = new Error('Rate limited');
        rateLimitError.name = 'RateLimitError';
        (rateLimitError as any).outcome = rateLimitOutcome;

        const refusalResponse = makeOutput("I can't help with that.");
        const refusalOutcome: ModelOutcome = {
          modelId: 'model-1',
          type: OutcomeType.SUCCESS,
          latency: 80,
          timestamp: new Date()
        };

        const successResponse = makeOutput('Here is the answer.');
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
          .mockResolvedValueOnce(mockModel) // For escalation attempt
          .mockResolvedValueOnce(secondModel as any);

        mockModel.invoke
          .mockRejectedValueOnce(rateLimitError)
          .mockResolvedValueOnce({ response: refusalResponse, outcome: refusalOutcome });

        (secondModel as any).invoke = jest.fn().mockResolvedValue({
          response: successResponse,
          outcome: successOutcome
        });

        mockDelegate.tierEscalationConfig = { enabled: true, escalationTier: 'priority' };
        mockDelegate.refusalRetryEnabled = true;
        mockDelegate.classifyRefusal
          .mockResolvedValueOnce({ isRefusal: true, confidence: 0.9, latencyMs: 3 })
          .mockResolvedValueOnce({ isRefusal: false, confidence: 0.05, latencyMs: 2 });

        const handler = new RequestHandler(makeInput('test'), mockDelegate, 3);
        const result = await handler.process();

        expect(result).toEqual(successResponse);

        // Should have emitted refusal-detected for the escalated response
        expect(mockDelegate.emitEvent).toHaveBeenCalledWith(
          'refusal-detected', 'model-1', 0.9, "I can't help with that."
        );
      });
    });
  });
});
