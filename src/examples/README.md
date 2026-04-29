# Examples

Each example isolates a single feature of the Amazon Bedrock Model Multiplexer.
They are written as consumer code — importing from `'bedrock-model-multiplexer'`
as a published package — and are excluded from TypeScript compilation.

## Running examples

Build the library first, then run any example with `ts-node` or `tsx`:

```bash
npm run build
npx tsx src/examples/01-basic-usage.ts
```

> **Note:** Most examples require valid AWS credentials and Amazon Bedrock model access.
> Without credentials, requests will fail — the examples still demonstrate
> setup, configuration, event handling, and metrics inspection.

## Examples

| # | File | Feature |
|---|------|---------|
| 01 | [basic-usage](01-basic-usage.ts) | Minimum setup: models → multiplexer → processRequest → response |
| 02 | [weighted-selection](02-weighted-selection.ts) | How weights control traffic distribution across primary/fallback pools |
| 03 | [failover-and-retry](03-failover-and-retry.ts) | Cross-model failover on rate limits, fail-fast semantics, caller-side retry for 503, opt-in service tier escalation on throttling |
| 04 | [circuit-breaker](04-circuit-breaker.ts) | Circuit breaker lifecycle (CLOSED → OPEN → HALF_OPEN), inspecting state |
| 05 | [health-checks](05-health-checks.ts) | Health check API: simple probe, detailed status, per-model health, health formula |
| 06 | [timeout-tuning](06-timeout-tuning.ts) | Configuring `defaultTimeoutMs`, using health metrics to calibrate |
| 07 | [event-system](07-event-system.ts) | Every event the multiplexer emits, including model management and stats |
| 08 | [statistics](08-statistics.ts) | `getStats()` for cumulative counts, latency percentiles, per-model breakdowns |
| 09 | [xray-tracing](09-xray-tracing.ts) | Optional X-Ray tracing: config, trace structure, annotations, metadata |
| 10 | [refusal-detection](10-refusal-detection.ts) | Opt-in ONNX refusal classifier: config, events (`refusal-detected`, `refusal-classification`), per-model refusal stats, retry-on-refusal |
| 11 | [credential-providers](11-credential-providers.ts) | Using `@aws-sdk/credential-providers` via `clientConfig`: named profiles, assume role, SSO, custom chains, web identity, IMDS |
