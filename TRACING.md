# AWS X-Ray Tracing Integration for Amazon Bedrock Model Multiplexer

This document explains how to use AWS X-Ray tracing with the Amazon Bedrock Model Multiplexer to gain deep insights into your application's performance, error patterns, and model usage.

## Overview

The X-Ray tracing integration provides:
- **End-to-end request tracking** across Lambda functions
- **Performance metrics** for model selection and invocation
- **Error tracking** with detailed retry and fallback patterns
- **Model usage insights** to understand load balancing
- **Service maps** to visualize dependencies

## Quick Start

### 1. Install Dependencies

```bash
npm install @aws-lambda-powertools/tracer
```

### 2. Enable Tracing in Your Lambda Function

```typescript
import { createMultiplexer, ModelConfiguration } from 'bedrock-model-multiplexer';

const models: ModelConfiguration[] = [
  { modelId: 'amazon.nova-lite-v1:0', weight: 100, isFallback: false },
  { modelId: 'amazon.nova-pro-v1:0',  weight: 60,  isFallback: true  }
];

// Create multiplexer with X-Ray tracing enabled
const multiplexer = createMultiplexer(models, {
  tracing: {
    enabled: true,
    serviceName: 'my-bedrock-app',
    captureBodies: false,  // Set to true to capture request/response bodies
    captureModelSelection: true  // Enable detailed model selection tracing
  }
});

// Your Lambda handler
export const handler = async (event: any) => {
  // All multiplexer operations are automatically traced
  const response = await multiplexer.processRequest({
    messages: [{ role: 'user', content: [{ text: event.prompt }] }],
    inferenceConfig: { maxTokens: 1000 }
  });

  return response;
};
```

### 3. Enable X-Ray in Lambda Configuration

In your Lambda function configuration:
- Set `Tracing configuration` to `Active`
- Verify that your execution role has `xray:PutTraceSegments` and `xray:PutTelemetryRecords` permissions

## Configuration Options

### TracingConfig Interface

```typescript
interface TracingConfig {
  enabled: boolean;                    // Enable/disable X-Ray tracing
  serviceName?: string;                // Service name in X-Ray traces
  captureBodies?: boolean;             // Capture request/response bodies
  captureModelSelection?: boolean;     // Enable detailed model selection tracing
}
```

### Configuration Examples

#### Basic Tracing
```typescript
{
  tracing: {
    enabled: true,
    serviceName: 'bedrock-multiplexer'
  }
}
```

#### Detailed Tracing with Body Capture
```typescript
{
  tracing: {
    enabled: true,
    serviceName: 'my-ai-service',
    captureBodies: true,           // ⚠️ Be careful with sensitive data
    captureModelSelection: true
  }
}
```

#### Production Configuration
```typescript
{
  tracing: {
    enabled: process.env.ENABLE_XRAY_TRACING === 'true',
    serviceName: process.env.SERVICE_NAME || 'bedrock-multiplexer',
    captureBodies: false,          // Recommended for production
    captureModelSelection: true
  }
}
```

## What Gets Traced

### Main Operations

1. **BedrockMultiplexer.processRequest**
   - Request metadata (model count, configuration)
   - Overall request latency
   - Success/error outcomes
   - Request/response bodies (if enabled)

2. **BedrockMultiplexer.selectModel** (if captureModelSelection enabled)
   - Available models (primary/fallback)
   - Skipped models from previous attempts
   - Selected model and type
   - Model selection latency

### Annotations (Searchable)

| Annotation | Description | Example Value |
|------------|-------------|---------------|
| `request_id` | Unique request identifier | `req_1640995200000_abc123` |
| `model_count` | Total available models | `3` |
| `primary_models` | Number of primary models | `2` |
| `fallback_models` | Number of fallback models | `1` |
| `selected_model_id` | Selected model identifier | `amazon.nova-2-lite-v1:0` |
| `selected_model_type` | Model type selected | `primary` or `fallback` |
| `skipped_models_count` | Number of skipped models | `1` |
| `outcome` | Request outcome | `success` or `error` |
| `error_code` | Error code (if failed) | `503` |
| `latency_ms` | Operation latency | `1250` |

### Metadata (Detailed Information)

| Metadata Key | Description | When Captured |
|--------------|-------------|---------------|
| `request` | Full request body | If `captureBodies: true` |
| `response` | Full response body | If `captureBodies: true` |
| `error` | Error details | On failures |
| `skipped_models` | List of skipped model IDs | If `captureModelSelection: true` |

## Trace Structure

### Example Trace Hierarchy

```
📊 BedrockMultiplexer.processRequest (1.2s)
├── 📋 Annotations:
│   ├── request_id: req_1640995200000_abc123
│   ├── model_count: 3
│   ├── primary_models: 2
│   ├── fallback_models: 1
│   ├── outcome: success
│   └── latency_ms: 1200
├── 📁 Metadata:
│   └── request: { prompt: "...", max_tokens: 1000 }
└── 🔍 BedrockMultiplexer.selectModel (0.05s)
    ├── 📋 Annotations:
    │   ├── skipped_models_count: 0
    │   ├── available_primary_models: 2
    │   ├── selected_model_id: amazon.nova-2-lite-v1:0
    │   └── selected_model_type: primary
    └── 📁 Metadata:
        └── skipped_models: []
```

## Event Integration

The multiplexer emits additional events for tracing coordination:

```typescript
// Listen to tracing-related events
multiplexer.on('model-selected', (modelId, isFallback, retryCount) => {
  console.log(`Model selected: ${modelId} (${isFallback ? 'fallback' : 'primary'})`);
});

multiplexer.on('model-invocation-start', (modelId, requestId) => {
  console.log(`Starting invocation: ${modelId} [${requestId}]`);
});

multiplexer.on('model-invocation-complete', (modelId, requestId, latency) => {
  console.log(`Completed invocation: ${modelId} [${requestId}] in ${latency}ms`);
});

// Tier escalation events (when tierEscalation is enabled)
multiplexer.on('tier-escalation', (modelId, fromTier, toTier) => {
  console.log(`Tier escalation: ${modelId} ${fromTier} → ${toTier}`);
});

multiplexer.on('tier-escalation-success', (modelId, tier) => {
  console.log(`Tier escalation succeeded: ${modelId} at ${tier}`);
});

multiplexer.on('tier-escalation-failure', (modelId, tier, error) => {
  console.log(`Tier escalation failed: ${modelId} at ${tier} — ${error}`);
});
```

## Performance Considerations

### Overhead
- **Minimal**: X-Ray tracing adds ~1-5ms overhead per request
- **Sampling**: X-Ray automatically samples traces (1 req/sec + 5%)
- **Async**: Trace data is sent asynchronously

### Memory Usage
- **Annotations**: ~100 bytes per annotation
- **Metadata**: Variable, depends on body capture settings
- **Automatic cleanup**: No manual memory management required

### Network Impact
- **Batched**: Trace data is batched and sent periodically
- **Compressed**: Trace data is compressed before transmission
- **Resilient**: Tracing failures don't affect application logic

## Recommended Practices

### Security
```typescript
// ✅ Good: Disable body capture for sensitive data
{
  tracing: {
    enabled: true,
    captureBodies: false,  // Don't capture sensitive prompts/responses
    captureModelSelection: true
  }
}

// ❌ Avoid: Capturing bodies with sensitive data
{
  tracing: {
    enabled: true,
    captureBodies: true,  // Could expose sensitive information
  }
}
```

### Performance
```typescript
// ✅ Good: Use environment variables for configuration
{
  tracing: {
    enabled: process.env.NODE_ENV === 'production',
    serviceName: process.env.SERVICE_NAME,
    captureModelSelection: process.env.NODE_ENV !== 'production'
  }
}
```

### Monitoring
```typescript
// ✅ Good: Use structured service names
{
  tracing: {
    enabled: true,
    serviceName: `${process.env.SERVICE_NAME}-${process.env.STAGE}`,  // e.g., "ai-service-prod"
  }
}
```

## Querying Traces

### AWS X-Ray Console

1. **Service Map**: Visualize service dependencies and performance
2. **Traces**: Search and filter traces by annotations
3. **Analytics**: Generate performance reports and error analysis

### Common Queries

```javascript
// Find slow requests (>5 seconds)
annotation.latency_ms > 5000

// Find requests that used fallback models
annotation.selected_model_type = "fallback"

// Find requests with specific model
annotation.selected_model_id = "amazon.nova-2-lite-v1:0"

// Find failed requests
annotation.outcome = "error"

// Find requests with retries
annotation.skipped_models_count > 0
```

### AWS CLI Examples

```bash
# Get traces for the last hour with errors
aws xray get-trace-summaries \
  --time-range-type TimeRangeByStartTime \
  --start-time $(date -d '1 hour ago' --iso-8601) \
  --end-time $(date --iso-8601) \
  --filter-expression 'annotation.outcome = "error"'

# Get service statistics
aws xray get-service-graph \
  --start-time $(date -d '1 hour ago' --iso-8601) \
  --end-time $(date --iso-8601)
```

## Troubleshooting

### Tracing Not Appearing

1. **Check Lambda Configuration**
   ```bash
   aws lambda get-function-configuration --function-name your-function-name
   # Look for TracingConfig.Mode: "Active"
   ```

2. **Check IAM Permissions**
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": [
           "xray:PutTraceSegments",
           "xray:PutTelemetryRecords"
         ],
         "Resource": "*"
       }
     ]
   }
   ```

   > **Note**: `Resource: "*"` is required for X-Ray — trace segment ARNs are generated dynamically at runtime and cannot be predicted in advance. This matches the AWS-managed `AWSXRayDaemonWriteAccess` policy.

3. **Verify Environment**
   ```typescript
   console.log('X-Ray tracing enabled:', multiplexer.isTracingEnabled());
   ```

### Common Issues

| Issue | Solution |
|-------|----------|
| No traces in X-Ray | Verify Lambda tracing is Active and IAM permissions |
| Missing annotations | Check that tracing is enabled in multiplexer config |
| High latency | Disable body capture or detailed model selection tracing |
| Traces cut off | Increase Lambda timeout and memory allocation |

## Example Implementation

### Complete Lambda Function

```typescript
import { createMultiplexer, type ModelConfiguration } from 'bedrock-model-multiplexer';
import type { ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';

const models: ModelConfiguration[] = [
  { modelId: 'amazon.nova-lite-v1:0', weight: 100, isFallback: false },
  { modelId: 'amazon.nova-pro-v1:0',  weight: 60,  isFallback: true  }
];

// Initialize multiplexer with tracing
const multiplexer = createMultiplexer(models, {
  tracing: {
    enabled: true,
    serviceName: process.env.SERVICE_NAME || 'ai-service',
    captureBodies: process.env.CAPTURE_BODIES === 'true',
    captureModelSelection: true
  },
  maxRetries: 3,
  defaultTimeoutMs: 30000
});

export const handler = async (event: any): Promise<any> => {
  try {
    const response: ConverseCommandOutput = await multiplexer.processRequest({
      messages: [{ role: 'user', content: [{ text: event.prompt }] }],
      inferenceConfig: {
        maxTokens: event.max_tokens || 1000,
        temperature: event.temperature || 0.7
      }
    });

    return {
      statusCode: 200,
      body: JSON.stringify(response)
    };
  } catch (error: any) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};
```

## Integration with Other Tools

### CloudWatch Integration
X-Ray traces automatically integrate with CloudWatch:
- **Logs**: Trace IDs appear in CloudWatch logs
- **Metrics**: Performance metrics in CloudWatch
- **Alarms**: Set up alarms based on trace data

### Application Insights
Use trace data for:
- **Performance optimization**: Identify slow models
- **Error analysis**: Track retry patterns
- **Capacity planning**: Understand usage patterns
- **Cost optimization**: Model usage insights

This tracing integration provides comprehensive observability for your Amazon Bedrock Model Multiplexer, enabling you to optimize performance, troubleshoot issues, and understand usage patterns in production environments.
