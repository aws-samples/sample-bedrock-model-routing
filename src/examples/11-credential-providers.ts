/**
 * Example 11: Credential Providers
 *
 * Demonstrates how to use `@aws-sdk/credential-providers` with the
 * multiplexer's `clientConfig` passthrough. The multiplexer is a
 * routing/resilience facade — it does NOT own credential resolution.
 * AWS SDK clients handle credentials automatically via the default
 * Node.js credential chain, but you can override this by passing any
 * credential provider through `clientConfig.credentials`.
 *
 * Install the optional peer dependency first:
 *   npm install @aws-sdk/credential-providers
 *
 * Common scenarios shown below:
 *  A. Default — no explicit credentials (SDK resolves automatically)
 *  B. Named profile from ~/.aws/credentials
 *  C. Assume a role via STS (temporary credentials)
 *  D. SSO credentials
 *  E. Custom credential chain with expiry
 *  F. Web identity token (EKS / OIDC)
 *  G. Container/instance metadata (ECS / EC2)
 */
import 'dotenv/config';
import { ConverseCommandInput } from '@aws-sdk/client-bedrock-runtime';
import { createMultiplexer, ModelConfiguration } from 'bedrock-model-multiplexer';

// ------------------------------------------------------------------
// Import from @aws-sdk/credential-providers (install separately)
// Uncomment the imports you need:
// ------------------------------------------------------------------
// import {
//   fromIni,
//   fromTemporaryCredentials,
//   fromSSO,
//   fromNodeProviderChain,
//   fromEnv,
//   fromTokenFile,
//   fromContainerMetadata,
//   fromInstanceMetadata,
//   createCredentialChain
// } from '@aws-sdk/credential-providers';

const models: ModelConfiguration[] = [
  { modelId: 'amazon.nova-2-lite-v1:0', weight: 100, isFallback: false },
  { modelId: 'amazon.nova-pro-v1:0',    weight: 30,  isFallback: true  },
];

// ──────────────────────────────────────────────────────────────────
// A. Default — SDK resolves credentials automatically
//    (env vars → SSO cache → web identity → INI files → IMDS)
//    This is what happens when you omit `credentials` from clientConfig.
// ──────────────────────────────────────────────────────────────────
function exampleDefault() {
  return createMultiplexer(models, {
    defaultTimeoutMs: 30000,
    maxRetries: 3,
    clientConfig: { region: 'us-east-1', maxAttempts: 1 },
    // No `credentials` — SDK uses the default Node.js credential chain
  });
}

// ──────────────────────────────────────────────────────────────────
// B. Named profile from ~/.aws/credentials or ~/.aws/config
// ──────────────────────────────────────────────────────────────────
// function exampleNamedProfile() {
//   return createMultiplexer(models, {
//     defaultTimeoutMs: 30000,
//     maxRetries: 3,
//     clientConfig: {
//       region: 'us-east-1',
//       maxAttempts: 1,
//       credentials: fromIni({ profile: 'my-bedrock-profile' }),
//     },
//   });
// }

// ──────────────────────────────────────────────────────────────────
// C. Assume a role via STS (temporary credentials)
//    Useful for cross-account access or least-privilege role scoping.
// ──────────────────────────────────────────────────────────────────
// function exampleAssumeRole() {
//   return createMultiplexer(models, {
//     defaultTimeoutMs: 30000,
//     maxRetries: 3,
//     clientConfig: {
//       region: 'us-east-1',
//       maxAttempts: 1,
//       credentials: fromTemporaryCredentials({
//         params: {
//           RoleArn: 'arn:aws:iam::123456789012:role/BedrockAccessRole',
//           RoleSessionName: 'multiplexer-session',
//           DurationSeconds: 3600,
//         },
//       }),
//     },
//   });
// }

// ──────────────────────────────────────────────────────────────────
// D. AWS SSO credentials
//    Run `aws configure sso` and `aws sso login` first.
// ──────────────────────────────────────────────────────────────────
// function exampleSSO() {
//   return createMultiplexer(models, {
//     defaultTimeoutMs: 30000,
//     maxRetries: 3,
//     clientConfig: {
//       region: 'us-east-1',
//       maxAttempts: 1,
//       credentials: fromSSO({ profile: 'my-sso-profile' }),
//     },
//   });
// }

// ──────────────────────────────────────────────────────────────────
// E. Custom credential chain with auto-refresh
//    Try env vars first, then fall back to INI profile.
//    Expire after 15 minutes to force periodic refresh.
// ──────────────────────────────────────────────────────────────────
// function exampleCustomChain() {
//   return createMultiplexer(models, {
//     defaultTimeoutMs: 30000,
//     maxRetries: 3,
//     clientConfig: {
//       region: 'us-east-1',
//       maxAttempts: 1,
//       credentials: createCredentialChain(
//         fromEnv(),
//         fromIni({ profile: 'fallback-profile' }),
//       ).expireAfter(15 * 60_000),
//     },
//   });
// }

// ──────────────────────────────────────────────────────────────────
// F. Web identity token (EKS / OIDC)
//    Reads AWS_WEB_IDENTITY_TOKEN_FILE and AWS_ROLE_ARN from env.
// ──────────────────────────────────────────────────────────────────
// function exampleWebIdentity() {
//   return createMultiplexer(models, {
//     defaultTimeoutMs: 30000,
//     maxRetries: 3,
//     clientConfig: {
//       region: 'us-east-1',
//       maxAttempts: 1,
//       credentials: fromTokenFile(),
//     },
//   });
// }

// ──────────────────────────────────────────────────────────────────
// G. EC2 instance metadata / ECS container credentials
// ──────────────────────────────────────────────────────────────────
// function exampleInstanceMetadata() {
//   return createMultiplexer(models, {
//     defaultTimeoutMs: 30000,
//     maxRetries: 3,
//     clientConfig: {
//       region: 'us-east-1',
//       maxAttempts: 1,
//       credentials: fromInstanceMetadata({ timeout: 1000, maxRetries: 0 }),
//       // Or for ECS:
//       // credentials: fromContainerMetadata({ timeout: 1000, maxRetries: 0 }),
//     },
//   });
// }

// ──────────────────────────────────────────────────────────────────
// Run the default example
// ──────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log('=== Credential Providers Example ===\n');
  console.log('The multiplexer does not own credential resolution.');
  console.log('Pass any @aws-sdk/credential-providers function via clientConfig.credentials.\n');

  // Using default credentials (Scenario A)
  const multiplexer = exampleDefault();

  const input: Omit<ConverseCommandInput, 'modelId'> = {
    messages: [
      { role: 'user', content: [{ text: 'What credentials am I using?' }] },
    ],
    inferenceConfig: { maxTokens: 200 },
  };

  try {
    const response = await multiplexer.processRequest(input);
    const text = response.output?.message?.content?.[0]?.text;
    console.log('Assistant:', text);
  } catch (error: any) {
    console.error('Request failed:', error.message);
    console.log('\nThis is expected if no AWS credentials are configured.');
    console.log('Uncomment one of the scenarios above and provide valid credentials.');
  } finally {
    multiplexer.destroy();
  }
}

main().catch(console.error);
