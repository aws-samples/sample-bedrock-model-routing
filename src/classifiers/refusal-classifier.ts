/**
 * Refusal Classifier — wraps an ONNX binary classifier that detects
 * whether a model response is a refusal (e.g., "I can't help with that")
 * versus a substantive answer.
 *
 * The ONNX model embeds a TF-IDF vectorizer in its graph, so it accepts
 * raw text strings directly — no separate tokenizer is needed.
 *
 * ONNX model contract:
 *   Input:  "input" — tensor(string), shape [N, 1]
 *   Output: "label" — predicted class ("complied" or "rejected")
 *           "probabilities" — float array [p_complied, p_rejected]
 */

import * as ort from 'onnxruntime-node';

export interface RefusalClassifierConfig {
  /** Path to the .onnx model file */
  modelPath: string;
  /** Confidence threshold for classifying as refusal (default: 0.5) */
  confidenceThreshold?: number;
}

export interface ClassificationResult {
  /** Whether the response is classified as a refusal */
  isRefusal: boolean;
  /** Confidence score (0–1) for the refusal class */
  confidence: number;
  /** Inference latency in milliseconds */
  latencyMs: number;
}

export class RefusalClassifier {
  private session: ort.InferenceSession | null = null;
  private readonly config: Required<RefusalClassifierConfig>;

  constructor(config: RefusalClassifierConfig) {
    this.config = {
      modelPath: config.modelPath,
      confidenceThreshold: config.confidenceThreshold ?? 0.5
    };
  }

  /**
   * Initialize the ONNX inference session. Must be called before classify().
   * Designed to be called once at multiplexer construction time.
   */
  public async initialize(): Promise<void> {
    this.session = await ort.InferenceSession.create(this.config.modelPath, {
      executionProviders: ['cpu']
    });
  }

  /**
   * Classify a model response as refusal or non-refusal.
   *
   * The ONNX model accepts raw text via the embedded TF-IDF pipeline.
   * Input tensor: "input" — string tensor of shape [1, 1]
   * Output: "label" (class name) and "probabilities" ([p_complied, p_rejected])
   *
   * @param responseText The text content extracted from ConverseCommandOutput
   * @returns Classification result with refusal flag and confidence
   */
  public async classify(responseText: string): Promise<ClassificationResult> {
    if (!this.session) {
      throw new Error('RefusalClassifier not initialized. Call initialize() first.');
    }

    const startTime = Date.now();

    // Build string tensor — shape [1, 1] matching the ONNX model's expected input
    const inputTensor = new ort.Tensor('string', [responseText], [1, 1]);

    // Run inference — the model's input name is "input"
    const feeds: Record<string, ort.Tensor> = { input: inputTensor };
    const results = await this.session.run(feeds);

    // Read probabilities output: [p_complied, p_rejected]
    const probabilities = results['probabilities'];
    let refusalProbability: number;

    if (probabilities) {
      // probabilities is a sequence of maps in the ONNX pipeline output.
      // onnxruntime-node surfaces it as a flat Float32Array: [p_complied, p_rejected]
      const probData = probabilities.data as Float32Array;
      refusalProbability = probData[1]; // index 1 = "rejected" class
    } else {
      // Fallback: use the label output directly
      const label = results['label'];
      const labelStr = (label?.data as string[])?.[0] ?? '';
      refusalProbability = labelStr === 'rejected' ? 1.0 : 0.0;
    }

    const latencyMs = Date.now() - startTime;

    return {
      isRefusal: refusalProbability >= this.config.confidenceThreshold,
      confidence: refusalProbability,
      latencyMs
    };
  }

  /**
   * Destroy the classifier and release ONNX session resources.
   */
  public async destroy(): Promise<void> {
    if (this.session) {
      await this.session.release();
      this.session = null;
    }
  }

  /** Whether the classifier session is loaded and ready */
  public get isReady(): boolean {
    return this.session !== null;
  }

  /** Get the current confidence threshold */
  public get confidenceThreshold(): number {
    return this.config.confidenceThreshold;
  }
}
