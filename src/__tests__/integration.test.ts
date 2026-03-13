/**
 * Integration Test Examples for Amazon Bedrock Connectivity
 * 
 * These tests require real AWS credentials and Amazon Bedrock access.
 * They run automatically when AWS credentials are available via environment variables.
 * 
 * Prerequisites:
 * - AWS credentials configured via environment variables:
 *   - AWS_ACCESS_KEY_ID
 *   - AWS_SECRET_ACCESS_KEY
 *   - AWS_SESSION_TOKEN (optional, for temporary credentials)
 * - Amazon Bedrock model access enabled in your AWS account
 * - Appropriate IAM permissions for bedrock:InvokeModel and bedrock:ConverseStream
 * 
 * To run these tests:
 * 1. Set AWS credentials in environment variables
 * 2. Run: npm run test:integration
 * 
 * Example:
 *   AWS_ACCESS_KEY_ID=xxx AWS_SECRET_ACCESS_KEY=yyy AWS_SESSION_TOKEN=zzz npm run test:integration
 */

import {
  createMultiplexer,
  DefaultModelConfigs,
  BedrockModel,
  BedrockMultiplexer,
  CircuitBreakerState
} from '../index';

/**
 * Check if AWS credentials are available in environment variables
 */
const hasAwsCredentials = (): boolean => {
  const hasAccessKey = !!process.env.AWS_ACCESS_KEY_ID;
  const hasSecretKey = !!process.env.AWS_SECRET_ACCESS_KEY;
  return hasAccessKey && hasSecretKey;
};

// Run integration tests only when AWS credentials are available
const describeIntegration = hasAwsCredentials() ? describe : describe.skip;

// Log credential status for debugging
if (!hasAwsCredentials()) {
  console.log('⚠️  Skipping integration tests: AWS credentials not found in environment variables');
  console.log('   Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and optionally AWS_SESSION_TOKEN to run these tests');
} else {
  console.log('✅ AWS credentials found, running integration tests');
  if (process.env.AWS_SESSION_TOKEN) {
    console.log('   Using temporary credentials (AWS_SESSION_TOKEN is set)');
  }
}

describeIntegration('Amazon Bedrock Integration Tests', () => {
  // Increase timeout for real API calls
  jest.setTimeout(60000);

  describe('Single Model Invocation', () => {
    let model: BedrockModel;

    beforeEach(() => {
      model = new BedrockModel(
        {
          modelId: 'amazon.nova-2-lite-v1:0',
          weight: 100,
          isFallback: false,
        },
        undefined,
        undefined,
        undefined,
        { region: 'us-east-1', maxAttempts: 1 }
      );
    });

    afterEach(() => {
      model.destroy();
    });

    it('should invoke model and get response', async () => {
      const result = await model.invoke({
        messages: [
          {
            role: 'user',
            content: [{ text: 'Say "Hello, World!" and nothing else.' }]
          }
        ],
        inferenceConfig: { maxTokens: 50 }
      });

      expect(result.response.output).toBeDefined();
      expect(result.outcome.type).toBe(0); // SUCCESS
      expect(result.outcome.latency).toBeGreaterThan(0);
    });

    it('should handle streaming response (raw SDK passthrough)', async () => {
      const streamResponse = await model.invokeStream({
        messages: [
          {
            role: 'user',
            content: [{ text: 'Count from 1 to 5.' }]
          }
        ],
        inferenceConfig: { maxTokens: 100 }
      });

      // streamResponse is raw ConverseStreamCommandOutput — iterate SDK events directly
      const events: any[] = [];
      if (streamResponse.stream) {
        for await (const event of streamResponse.stream) {
          events.push(event);
        }
      }

      expect(events.length).toBeGreaterThan(0);
    });

    it('should update circuit breaker on success', async () => {
      await model.invoke({
        messages: [{ role: 'user', content: [{ text: 'Hi' }] }],
        inferenceConfig: { maxTokens: 10 }
      });

      const cbStatus = model.getCircuitBreaker().getStatus();
      expect(cbStatus.state).toBe(CircuitBreakerState.CLOSED);
    });
  });

  describe('Multiplexer with Multiple Models', () => {
    let multiplexer: BedrockMultiplexer;

    beforeEach(() => {
      multiplexer = createMultiplexer([
        {
          modelId: 'amazon.nova-2-lite-v1:0',
          weight: 100,
          isFallback: false,
        },
        {
          modelId: 'amazon.nova-pro-v1:0',
          weight: 50,
          isFallback: true,
        }
      ], {
        maxRetries: 2,
        defaultTimeoutMs: 30000,
        clientConfig: { region: 'us-east-1', maxAttempts: 1 }
      });
    });

    afterEach(() => {
      multiplexer.destroy();
    });

    it('should process request through multiplexer', async () => {
      const response = await multiplexer.processRequest({
        messages: [
          { role: 'user', content: [{ text: 'What is 2 + 2?' }] }
        ],
        inferenceConfig: { maxTokens: 50 }
      });

      expect(response.output).toBeDefined();
    });

    it('should update statistics after request', async () => {
      await multiplexer.processRequest({
        messages: [{ role: 'user', content: [{ text: 'Hello' }] }],
        inferenceConfig: { maxTokens: 10 }
      });

      const stats = multiplexer.getStats();
      expect(stats.successCount).toBeGreaterThan(0);
    });

    it('should provide health status', () => {
      const health = multiplexer.getHealthStatus();

      expect(health.totalModels).toBe(2);
      expect(health.timestamp).toBeInstanceOf(Date);
      expect(health.models).toBeDefined();
    });

    it('should provide simple health check for load balancer', () => {
      const health = multiplexer.getSimpleHealthCheck();

      expect(health.status).toBe('healthy');
      expect(health.code).toBe(200);
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid model ID gracefully', async () => {
      const model = new BedrockModel(
        { modelId: 'invalid.model.id', weight: 100, isFallback: false },
        undefined, undefined, undefined,
        { region: 'us-east-1', maxAttempts: 1 }
      );

      try {
        await model.invoke({
          messages: [{ role: 'user', content: [{ text: 'test' }] }]
        });
        fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.name).toBe('FailFastError');
        expect(error.outcome).toBeDefined();
      } finally {
        model.destroy();
      }
    });

    it('should timeout on slow requests', async () => {
      const model = new BedrockModel(
        { modelId: 'amazon.nova-2-lite-v1:0', weight: 100, isFallback: false },
        undefined,
        1, // 1ms timeout - expected to fail
        undefined,
        { region: 'us-east-1', maxAttempts: 1 }
      );

      try {
        await model.invoke({
          messages: [{ role: 'user', content: [{ text: 'test' }] }],
          inferenceConfig: { maxTokens: 100 }
        });
        fail('Should have timed out');
      } catch (error: any) {
        expect(error.name).toBe('TimeoutError');
      } finally {
        model.destroy();
      }
    });

    it('should support request cancellation', async () => {
      const model = new BedrockModel(
        { modelId: 'amazon.nova-2-lite-v1:0', weight: 100, isFallback: false },
        undefined, undefined, undefined,
        { region: 'us-east-1', maxAttempts: 1 }
      );

      const abortController = new AbortController();

      // Abort immediately
      abortController.abort();

      try {
        await model.invoke(
          {
            messages: [{ role: 'user', content: [{ text: 'test' }] }],
            inferenceConfig: { maxTokens: 100 }
          },
          abortController.signal
        );
        fail('Should have been cancelled');
      } catch (error: any) {
        expect(['AbortError', 'CancelledError']).toContain(error.name);
      } finally {
        model.destroy();
      }
    });
  });

  describe('Circuit Breaker Integration', () => {
    it('should open circuit after repeated failures', async () => {
      const model = new BedrockModel(
        { modelId: 'invalid.model.definitely.not.real', weight: 100, isFallback: false },
        undefined, undefined, undefined,
        { region: 'us-east-1', maxAttempts: 1 }
      );

      // Configure circuit breaker with low threshold
      const cb = model.getCircuitBreaker();

      // Attempt multiple requests to trigger circuit breaker
      for (let i = 0; i < 5; i++) {
        try {
          await model.invoke({
            messages: [{ role: 'user', content: [{ text: 'test' }] }]
          });
        } catch {
          // Expected to fail
        }
      }

      // Circuit should be open after failures
      expect(cb.getState()).toBe(CircuitBreakerState.OPEN);
      expect(cb.canExecute()).toBe(false);

      model.destroy();
    });
  });
});

/**
 * Example: How to run integration tests
 * 
 * Local Development:
 * 
 * Set AWS credentials as environment variables and run:
 * 
 *   export AWS_ACCESS_KEY_ID="your-access-key"
 *   export AWS_SECRET_ACCESS_KEY="your-secret-key"
 *   export AWS_SESSION_TOKEN="your-session-token"  # Optional, for temporary credentials
 *   npm run test:integration
 * 
 * Or in a single command:
 * 
 *   AWS_ACCESS_KEY_ID=xxx AWS_SECRET_ACCESS_KEY=yyy AWS_SESSION_TOKEN=zzz npm run test:integration
 */

export {};
