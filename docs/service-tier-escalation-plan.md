# Service Tier Escalation — Resilience Enhancement Plan

## Motivation

Amazon Bedrock introduced four service tiers for model inference: **Reserved**, **Priority**, **Standard**, and **Flex**. Each tier offers different availability and prioritization characteristics. The multiplexer can leverage this as a new resilience dimension — escalating to a higher-priority tier when the Standard tier is throttled, before falling back to a different model.

This is a **resilience-first** feature. The goal is not cost optimization — it's maximizing the chance of a successful response by exploiting tier-level capacity before exhausting cross-model failover.

## Core Idea

Today the retry loop does:

```
Model A (Standard) throttled → skip A → try Model B (Standard)
```

With tier escalation:

```
Model A (Standard) throttled → retry Model A (Reserved or Priority) → if still fails → skip A → try Model B (Standard) → Model B throttled → retry Model B (Reserved or Priority) → ...
```

A throttling error at Standard doesn't mean the model is broken — it means that tier is congested. The same model at a higher tier may succeed immediately since Reserved/Priority requests are served ahead of Standard.

## Escalation Tier Selection

The escalation target is binary — determined by whether the customer has a capacity reservation:

| Customer Has Reservation? | Escalation Tier | Rationale |
|---------------------------|-----------------|-----------|
| Yes | `reserved` | Reserved capacity is pre-provisioned and separate from on-demand quota. Overflows to Standard automatically if reservation is full. |
| No | `priority` | Priority requests are served ahead of Standard and Flex. No reservation needed. Price premium per request. |

Only one escalation tier is used — never both. The customer configures this once at the multiplexer level.

## Configuration

```typescript
tierEscalation?: {
  enabled: boolean;
  // "reserved" if customer has a capacity reservation,
  // "priority" if not — determines the single escalation target tier
  escalationTier: 'reserved' | 'priority';
}
```

- All models start at `"default"` (Standard tier).
- When escalation is triggered, the multiplexer retries the same model with `serviceTier: { type: escalationTier }`.
- This is a **multiplexer-level** setting (not per-model), since the reservation decision is account-level.

## Escalation Trigger

Tier escalation is triggered **only on throttling errors** (HTTP 429 `ThrottlingException`).

The multiplexer already detects these via `isThrottlingError`, which matches six AWS SDK error names:

- `ThrottlingException`
- `TooManyRequestsException`
- `ServiceQuotaExceededException`
- `LimitExceededException`
- `RequestLimitExceeded`
- `RateLimitExceeded`

Other error types (timeout, auth, validation, circuit-open) are **not** escalation candidates — a higher tier won't help with those.

## Escalation Budget

Tier escalation gets **one attempt per model per request**. It does not consume the cross-model retry budget.

Example with `maxRetries: 3` and two models (A, B):

```
1. Model A at Standard → ThrottlingException
2. Model A at Priority → ThrottlingException (escalation exhausted for A)
3. Model B at Standard → ThrottlingException
4. Model B at Priority → ThrottlingException (escalation exhausted for B)
5. RETRIES_EXHAUSTED
```

The cross-model retry count tracks how many models have been skipped. Tier escalation is a "free" retry within the same model before it gets skipped.

## API Integration

The `serviceTier` parameter is a first-class field on the Bedrock Converse API:

```typescript
// Request — stamped by the multiplexer alongside modelId
serviceTier: {
  type: 'reserved' | 'priority' | 'default' | 'flex'
}

// Response — the tier that actually served the request
serviceTier: {
  type: 'reserved' | 'priority' | 'default' | 'flex'
}
```

The response includes the **resolved tier**, which is useful for observability — the multiplexer can emit events indicating when escalation occurred and which tier ultimately served the request.

## Impact on Existing Architecture

| Component | Change |
|-----------|--------|
| **MultiplexerConfig** | Add optional `tierEscalation` config field |
| **BedrockModel.invoke()** | Accept and stamp `serviceTier` on the Converse request (same pattern as `modelId` stamping) |
| **RequestHandler retry loop** | On `RATE_LIMIT` outcome, check if tier escalation is available for this model before skipping it |
| **Event system** | New events for tier escalation attempts and resolved tier reporting |
| **Statistics** | Track escalation attempts and success rate |

The existing cross-model failover, circuit breaker, refusal detection, and health monitoring remain unchanged. Tier escalation is layered in as an additional resilience strategy that runs *before* cross-model failover.

## Open Questions

- Should `ServiceUnavailableException` (503) also trigger escalation? It indicates service-level congestion where Priority could help, but it's less directly tied to quota exhaustion.
- Should the resolved tier from the response be surfaced in `ModelOutcome` for downstream observability?
- Should there be a per-model override to opt out of tier escalation (e.g., a model that should never use Priority pricing)?

## References

- [Service tiers for optimizing performance and cost](https://docs.aws.amazon.com/bedrock/latest/userguide/service-tiers-inference.html)
- [Amazon Bedrock introduces Reserved Service tier](https://aws.amazon.com/about-aws/whats-new/2025/11/amazon-bedrock-reserved-service-tier/)
- [Troubleshooting Amazon Bedrock API Error Codes](https://docs.aws.amazon.com/bedrock/latest/userguide/troubleshooting-api-error-codes.html)
