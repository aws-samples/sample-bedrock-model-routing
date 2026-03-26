/**
 * Unit tests for RefusalClassifier and extractResponseText
 */

import { RefusalClassifier } from '../classifiers/refusal-classifier';
import { extractResponseText } from '../classifiers/response-extractor';
import { ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';

// Mock onnxruntime-node
jest.mock('onnxruntime-node', () => {
  const mockSession = {
    run: jest.fn(),
    release: jest.fn()
  };

  return {
    InferenceSession: {
      create: jest.fn().mockResolvedValue(mockSession)
    },
    Tensor: jest.fn().mockImplementation((type, data, dims) => ({
      type,
      data,
      dims
    }))
  };
});

const ort = require('onnxruntime-node');

describe('RefusalClassifier', () => {
  let classifier: RefusalClassifier;
  let mockSession: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSession = {
      run: jest.fn(),
      release: jest.fn()
    };
    ort.InferenceSession.create.mockResolvedValue(mockSession);

    classifier = new RefusalClassifier({
      modelPath: './models/test_classifier.onnx'
    });
  });

  describe('constructor', () => {
    it('should create with default confidence threshold', () => {
      const c = new RefusalClassifier({ modelPath: './model.onnx' });
      expect(c.confidenceThreshold).toBe(0.5);
      expect(c.isReady).toBe(false);
    });

    it('should accept custom confidence threshold', () => {
      const c = new RefusalClassifier({
        modelPath: './model.onnx',
        confidenceThreshold: 0.85
      });
      expect(c.confidenceThreshold).toBe(0.85);
    });
  });

  describe('initialize', () => {
    it('should load the ONNX session', async () => {
      await classifier.initialize();

      expect(ort.InferenceSession.create).toHaveBeenCalledWith(
        './models/test_classifier.onnx',
        { executionProviders: ['cpu'] }
      );
      expect(classifier.isReady).toBe(true);
    });

    it('should propagate initialization errors', async () => {
      ort.InferenceSession.create.mockRejectedValue(new Error('Model not found'));

      await expect(classifier.initialize()).rejects.toThrow('Model not found');
      expect(classifier.isReady).toBe(false);
    });
  });

  describe('classify', () => {
    beforeEach(async () => {
      await classifier.initialize();
    });

    it('should throw if not initialized', async () => {
      const uninitClassifier = new RefusalClassifier({ modelPath: './m.onnx' });
      await expect(uninitClassifier.classify('test')).rejects.toThrow(
        'RefusalClassifier not initialized'
      );
    });

    it('should classify non-refusal response correctly', async () => {
      mockSession.run.mockResolvedValue({
        probabilities: { data: new Float32Array([0.9, 0.1]) },
        label: { data: ['complied'] }
      });

      const result = await classifier.classify('Here is the information you requested.');

      expect(result.isRefusal).toBe(false);
      expect(result.confidence).toBeCloseTo(0.1);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('should classify refusal response correctly', async () => {
      mockSession.run.mockResolvedValue({
        probabilities: { data: new Float32Array([0.15, 0.85]) },
        label: { data: ['rejected'] }
      });

      const result = await classifier.classify("I can't help with that request.");

      expect(result.isRefusal).toBe(true);
      expect(result.confidence).toBeCloseTo(0.85);
    });

    it('should respect confidence threshold', async () => {
      const highThreshold = new RefusalClassifier({
        modelPath: './model.onnx',
        confidenceThreshold: 0.9
      });
      ort.InferenceSession.create.mockResolvedValue(mockSession);
      await highThreshold.initialize();

      // 0.85 is below 0.9 threshold — should NOT be classified as refusal
      mockSession.run.mockResolvedValue({
        probabilities: { data: new Float32Array([0.15, 0.85]) },
        label: { data: ['rejected'] }
      });

      const result = await highThreshold.classify('I cannot do that.');
      expect(result.isRefusal).toBe(false);
      expect(result.confidence).toBeCloseTo(0.85);
    });

    it('should classify at exactly the threshold as refusal', async () => {
      mockSession.run.mockResolvedValue({
        probabilities: { data: new Float32Array([0.5, 0.5]) },
        label: { data: ['rejected'] }
      });

      const result = await classifier.classify('Maybe...');
      expect(result.isRefusal).toBe(true); // 0.5 >= 0.5
    });

    it('should fall back to label if probabilities not present', async () => {
      mockSession.run.mockResolvedValue({
        label: { data: ['rejected'] }
      });

      const result = await classifier.classify('I refuse.');
      expect(result.isRefusal).toBe(true);
      expect(result.confidence).toBe(1.0);
    });

    it('should fall back to label for complied', async () => {
      mockSession.run.mockResolvedValue({
        label: { data: ['complied'] }
      });

      const result = await classifier.classify('Sure, here you go.');
      expect(result.isRefusal).toBe(false);
      expect(result.confidence).toBe(0.0);
    });

    it('should pass string tensor to ONNX session', async () => {
      mockSession.run.mockResolvedValue({
        probabilities: { data: new Float32Array([0.8, 0.2]) },
        label: { data: ['complied'] }
      });

      await classifier.classify('Test input');

      expect(ort.Tensor).toHaveBeenCalledWith('string', ['Test input'], [1, 1]);
      expect(mockSession.run).toHaveBeenCalledWith({
        input: expect.objectContaining({ type: 'string' })
      });
    });
  });

  describe('destroy', () => {
    it('should release the ONNX session', async () => {
      await classifier.initialize();
      expect(classifier.isReady).toBe(true);

      await classifier.destroy();
      expect(mockSession.release).toHaveBeenCalled();
      expect(classifier.isReady).toBe(false);
    });

    it('should be safe to call destroy when not initialized', async () => {
      await expect(classifier.destroy()).resolves.not.toThrow();
    });

    it('should be safe to call destroy multiple times', async () => {
      await classifier.initialize();
      await classifier.destroy();
      await classifier.destroy();
      expect(mockSession.release).toHaveBeenCalledTimes(1);
    });
  });
});

/** Helper to build a mock ConverseCommandOutput for extractResponseText tests */
function makeConverseOutput(content?: any[]): ConverseCommandOutput {
  return {
    output: { message: { role: 'assistant', content } },
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    metrics: { latencyMs: 100 },
    $metadata: {}
  } as any;
}

describe('extractResponseText', () => {
  it('should extract text from a single text block', () => {
    const output = makeConverseOutput([{ text: 'Hello, world!' }]);
    expect(extractResponseText(output)).toBe('Hello, world!');
  });

  it('should concatenate multiple text blocks', () => {
    const output = makeConverseOutput([
      { text: 'First part.' },
      { text: 'Second part.' }
    ]);
    expect(extractResponseText(output)).toBe('First part. Second part.');
  });

  it('should return empty string for no content', () => {
    const output = makeConverseOutput([]);
    expect(extractResponseText(output)).toBe('');
  });

  it('should return empty string for undefined content', () => {
    const output = { output: { message: { role: 'assistant' } }, $metadata: {} } as any;
    expect(extractResponseText(output)).toBe('');
  });

  it('should return empty string for missing message', () => {
    const output = { output: {}, $metadata: {} } as any;
    expect(extractResponseText(output)).toBe('');
  });

  it('should return empty string for missing output', () => {
    const output = { $metadata: {} } as any;
    expect(extractResponseText(output)).toBe('');
  });

  it('should filter out non-text content blocks', () => {
    const output = makeConverseOutput([
      { text: 'Only text' },
      { image: { format: 'png', source: { bytes: new Uint8Array() } } }
    ]);
    expect(extractResponseText(output)).toBe('Only text');
  });
});
