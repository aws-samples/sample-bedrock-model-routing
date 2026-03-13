import { OutcomeType, ErrorResponse, ErrorType, EnhancedErrorResponse } from '../types/index.js';

/**
 * Error classification utilities for Amazon Bedrock SDK errors
 */

/**
 * AWS SDK error interface
 */
interface AwsError extends Error {
  name: string;
  $metadata?: {
    httpStatusCode?: number;
    requestId?: string;
  };
  $fault?: 'client' | 'server';
  retryAfterSeconds?: number;
}

/**
 * Classifies an error into the appropriate outcome type
 * @param error The error to classify
 * @returns The outcome type
 */
export function classifyError(error: any): OutcomeType {
  if (!error) {
    return OutcomeType.FAIL_FAST;
  }

  const errorName = error.name || '';

  // Rate limiting errors (map to RATE_LIMIT)
  if (isThrottlingError(errorName)) {
    return OutcomeType.RATE_LIMIT;
  }

  // All other errors are fail-fast
  return OutcomeType.FAIL_FAST;
}

/**
 * Classify error into detailed error type
 * @param error The error to classify
 * @returns The detailed error type
 */
export function classifyErrorType(error: any): ErrorType {
  if (!error) {
    return ErrorType.UNKNOWN;
  }

  const errorName = error.name || '';
  const errorMessage = (error.message || '').toLowerCase();

  // Throttling errors
  if (isThrottlingError(errorName)) {
    return ErrorType.THROTTLING;
  }

  // Validation errors
  if (errorName === 'ValidationException' || errorName === 'ValidationError') {
    return ErrorType.VALIDATION;
  }

  // Authentication errors
  if (
    errorName === 'AccessDeniedException' ||
    errorName === 'UnauthorizedException' ||
    errorName === 'CredentialsProviderError' ||
    errorMessage.includes('credentials') ||
    errorMessage.includes('access denied')
  ) {
    return ErrorType.AUTHENTICATION;
  }

  // Timeout errors
  if (
    errorName === 'TimeoutError' ||
    errorName === 'ModelTimeoutException' ||
    errorMessage.includes('timeout') ||
    errorMessage.includes('timed out')
  ) {
    return ErrorType.TIMEOUT;
  }

  // Cancelled errors
  if (
    errorName === 'AbortError' ||
    errorName === 'CancelledError' ||
    errorMessage.includes('abort') ||
    errorMessage.includes('cancel')
  ) {
    return ErrorType.CANCELLED;
  }

  // Circuit breaker errors
  if (errorName === 'CircuitOpenError' || errorMessage.includes('circuit breaker')) {
    return ErrorType.CIRCUIT_OPEN;
  }

  // Model unavailable errors
  if (
    errorName === 'ModelNotReadyException' ||
    errorName === 'ServiceUnavailableException' ||
    errorName === 'ResourceNotFoundException' ||
    errorMessage.includes('not found') ||
    errorMessage.includes('unavailable')
  ) {
    return ErrorType.MODEL_UNAVAILABLE;
  }

  // Network errors
  if (
    errorName === 'NetworkError' ||
    errorName === 'NetworkingError' ||
    errorMessage.includes('network') ||
    errorMessage.includes('econnrefused') ||
    errorMessage.includes('enotfound')
  ) {
    return ErrorType.NETWORK;
  }

  // Internal errors
  if (errorName === 'InternalServerException' || error.$fault === 'server') {
    return ErrorType.INTERNAL;
  }

  return ErrorType.UNKNOWN;
}

/**
 * Checks if an error is a throttling/rate limiting error
 * @param errorName The error name
 * @returns True if it's a throttling error
 */
export function isThrottlingError(errorName: string): boolean {
  const throttlingErrors = [
    'ThrottlingException',
    'TooManyRequestsException',
    'ServiceQuotaExceededException',
    'LimitExceededException',
    'RequestLimitExceeded',
    'RateLimitExceeded'
  ];

  return throttlingErrors.includes(errorName);
}

/**
 * Checks if an error is retryable
 * @param error The error to check
 * @returns True if the error is retryable
 */
export function isRetryableError(error: any): boolean {
  const errorType = classifyErrorType(error);
  
  // Retryable error types
  const retryableTypes: ErrorType[] = [
    ErrorType.THROTTLING,
    ErrorType.TIMEOUT,
    ErrorType.NETWORK,
    ErrorType.INTERNAL,
    ErrorType.MODEL_UNAVAILABLE
  ];
  
  return retryableTypes.includes(errorType);
}

/**
 * Get retry delay for an error
 * @param error The error
 * @param baseDelayMs Base delay in milliseconds
 * @param attempt Current attempt number
 * @returns Retry delay in milliseconds
 */
export function getRetryDelay(error: any, baseDelayMs: number = 1000, attempt: number = 1): number {
  // Check for retry-after header
  if (error.retryAfterSeconds) {
    return error.retryAfterSeconds * 1000;
  }

  // Exponential backoff with jitter
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt - 1);
  const jitter = Math.random() * 0.3 * exponentialDelay;
  
  return Math.min(exponentialDelay + jitter, 60000); // Max 60 seconds
}

/**
 * Converts an error to a standardized ErrorResponse
 * @param error The error to convert
 * @returns Standardized error response
 */
export function toErrorResponse(error: any): ErrorResponse {
  if (!error) {
    return {
      code: 500,
      message: 'Unknown error occurred',
      details: {}
    };
  }

  const awsError = error as AwsError;
  
  return {
    code: awsError.$metadata?.httpStatusCode || 500,
    message: awsError.message || 'Unknown error',
    details: {
      name: awsError.name,
      stack: awsError.stack,
      ...extractErrorDetails(error)
    }
  };
}

/**
 * Create an enhanced error response with detailed information
 * @param error The original error
 * @param errorType The error type (or auto-detect)
 * @param modelId The model ID
 * @param customMessage Optional custom message
 * @returns Enhanced error response
 */
export function createEnhancedError(
  error: any,
  errorType?: ErrorType,
  modelId?: string,
  customMessage?: string
): EnhancedErrorResponse {
  const baseResponse = toErrorResponse(error);
  const detectedType = errorType ?? classifyErrorType(error);
  const isRetryable = isRetryableError(error);
  
  const recoverySuggestions = getRecoverySuggestions(detectedType);
  const retryAfterMs = isRetryable ? getRetryDelay(error) : undefined;

  return {
    ...baseResponse,
    message: customMessage ?? baseResponse.message,
    errorType: detectedType,
    retryable: isRetryable,
    retryAfterMs,
    recoverySuggestions,
    modelId,
    requestId: error?.$metadata?.requestId
  };
}

/**
 * Get recovery suggestions for an error type
 * @param errorType The error type
 * @returns Array of recovery suggestions
 */
export function getRecoverySuggestions(errorType: ErrorType): string[] {
  switch (errorType) {
    case ErrorType.THROTTLING:
      return [
        'Reduce request rate',
        'Implement exponential backoff',
        'Consider using a different model',
        'Request a quota increase from AWS'
      ];
    
    case ErrorType.VALIDATION:
      return [
        'Check request parameters',
        'Verify prompt is not empty',
        'Verify max_tokens is within allowed range',
        'Check temperature is between 0 and 2'
      ];
    
    case ErrorType.AUTHENTICATION:
      return [
        'Check AWS credentials configuration',
        'Verify IAM permissions for Amazon Bedrock',
        'Verify the AWS region is correct',
        'Check if the model is available in your region'
      ];
    
    case ErrorType.TIMEOUT:
      return [
        'Increase timeout duration',
        'Reduce prompt size',
        'Reduce max_tokens',
        'Try a faster model'
      ];
    
    case ErrorType.CANCELLED:
      return [
        'Request was intentionally cancelled',
        'Resubmit the request if needed'
      ];
    
    case ErrorType.CIRCUIT_OPEN:
      return [
        'Wait for the circuit breaker to recover',
        'Check model health status',
        'Use an alternative model'
      ];
    
    case ErrorType.MODEL_UNAVAILABLE:
      return [
        'Check if the model ID is correct',
        'Verify the model is available in your region',
        'Use a fallback model',
        'Wait and retry later'
      ];
    
    case ErrorType.NETWORK:
      return [
        'Check network connectivity',
        'Verify VPC/endpoint configuration',
        'Check firewall rules',
        'Retry the request'
      ];
    
    case ErrorType.INTERNAL:
      return [
        'Retry the request with exponential backoff',
        'Contact AWS support if the issue persists',
        'Check AWS service health dashboard'
      ];
    
    default:
      return [
        'Check error details for more information',
        'Retry the request',
        'Contact support if the issue persists'
      ];
  }
}

/**
 * Extracts additional error details from various error types
 * @param error The error object
 * @returns Additional error details
 */
function extractErrorDetails(error: any): Record<string, any> {
  const details: Record<string, any> = {};

  // AWS SDK specific properties
  if (error.$metadata) {
    details.metadata = error.$metadata;
  }

  if (error.$fault) {
    details.fault = error.$fault;
  }

  if (error.requestId) {
    details.requestId = error.requestId;
  }

  if (error.retryAfterSeconds) {
    details.retryAfterSeconds = error.retryAfterSeconds;
  }

  return details;
}

/**
 * Gets a human-readable error message for different error types
 * @param error The error object
 * @returns Human-readable error message
 */
export function getErrorMessage(error: any): string {
  if (!error) {
    return 'Unknown error occurred';
  }

  const errorName = error.name || '';

  // Provide specific messages for common errors
  switch (errorName) {
    case 'ThrottlingException':
      return 'Request was throttled due to rate limiting. Please retry after some time.';
    case 'ValidationException':
      return 'Request validation failed. Please check your input parameters.';
    case 'AccessDeniedException':
      return 'Access denied. Please check your AWS credentials and permissions.';
    case 'InternalServerException':
      return 'Internal server error occurred. Please retry the request.';
    case 'ModelNotReadyException':
      return 'Model is not ready to serve requests. Please try again later.';
    case 'ModelTimeoutException':
      return 'Model request timed out. Please try again.';
    case 'ServiceUnavailableException':
      return 'Service is temporarily unavailable. Please try again later.';
    case 'ResourceNotFoundException':
      return 'Requested model or resource was not found.';
    case 'TimeoutError':
      return 'Request timed out. Consider increasing timeout or reducing request size.';
    case 'AbortError':
    case 'CancelledError':
      return 'Request was cancelled.';
    case 'CircuitOpenError':
      return 'Circuit breaker is open. The model is temporarily unavailable due to repeated failures.';
    default:
      return error.message || `${errorName} occurred`;
  }
} 