/**
 * Unit tests for error-classifier utility
 */

import {
  classifyError,
  classifyErrorType,
  isThrottlingError,
  isRetryableError,
  getRetryDelay,
  toErrorResponse,
  createEnhancedError,
  getRecoverySuggestions,
  getErrorMessage
} from '../utils/error-classifier';
import { OutcomeType, ErrorType } from '../types/index';

describe('error-classifier', () => {
  describe('classifyError', () => {
    it('should return FAIL_FAST for null error', () => {
      expect(classifyError(null)).toBe(OutcomeType.FAIL_FAST);
    });

    it('should return FAIL_FAST for undefined error', () => {
      expect(classifyError(undefined)).toBe(OutcomeType.FAIL_FAST);
    });

    it('should return RATE_LIMIT for ThrottlingException', () => {
      const error = new Error('Rate limited');
      error.name = 'ThrottlingException';
      expect(classifyError(error)).toBe(OutcomeType.RATE_LIMIT);
    });

    it('should return RATE_LIMIT for TooManyRequestsException', () => {
      const error = new Error();
      error.name = 'TooManyRequestsException';
      expect(classifyError(error)).toBe(OutcomeType.RATE_LIMIT);
    });

    it('should return RATE_LIMIT for ServiceQuotaExceededException', () => {
      const error = new Error();
      error.name = 'ServiceQuotaExceededException';
      expect(classifyError(error)).toBe(OutcomeType.RATE_LIMIT);
    });

    it('should return RATE_LIMIT for LimitExceededException', () => {
      const error = new Error();
      error.name = 'LimitExceededException';
      expect(classifyError(error)).toBe(OutcomeType.RATE_LIMIT);
    });

    it('should return RATE_LIMIT for RequestLimitExceeded', () => {
      const error = new Error();
      error.name = 'RequestLimitExceeded';
      expect(classifyError(error)).toBe(OutcomeType.RATE_LIMIT);
    });

    it('should return RATE_LIMIT for RateLimitExceeded', () => {
      const error = new Error();
      error.name = 'RateLimitExceeded';
      expect(classifyError(error)).toBe(OutcomeType.RATE_LIMIT);
    });

    it('should return FAIL_FAST for other errors', () => {
      const error = new Error('Unknown error');
      error.name = 'SomeOtherError';
      expect(classifyError(error)).toBe(OutcomeType.FAIL_FAST);
    });
  });

  describe('classifyErrorType', () => {
    it('should return UNKNOWN for null error', () => {
      expect(classifyErrorType(null)).toBe(ErrorType.UNKNOWN);
    });

    it('should return THROTTLING for throttling errors', () => {
      const error = new Error();
      error.name = 'ThrottlingException';
      expect(classifyErrorType(error)).toBe(ErrorType.THROTTLING);
    });

    it('should return VALIDATION for ValidationException', () => {
      const error = new Error();
      error.name = 'ValidationException';
      expect(classifyErrorType(error)).toBe(ErrorType.VALIDATION);
    });

    it('should return VALIDATION for ValidationError', () => {
      const error = new Error();
      error.name = 'ValidationError';
      expect(classifyErrorType(error)).toBe(ErrorType.VALIDATION);
    });

    it('should return AUTHENTICATION for AccessDeniedException', () => {
      const error = new Error();
      error.name = 'AccessDeniedException';
      expect(classifyErrorType(error)).toBe(ErrorType.AUTHENTICATION);
    });

    it('should return AUTHENTICATION for UnauthorizedException', () => {
      const error = new Error();
      error.name = 'UnauthorizedException';
      expect(classifyErrorType(error)).toBe(ErrorType.AUTHENTICATION);
    });

    it('should return AUTHENTICATION for CredentialsProviderError', () => {
      const error = new Error();
      error.name = 'CredentialsProviderError';
      expect(classifyErrorType(error)).toBe(ErrorType.AUTHENTICATION);
    });

    it('should return AUTHENTICATION for errors mentioning credentials', () => {
      const error = new Error('Invalid credentials provided');
      expect(classifyErrorType(error)).toBe(ErrorType.AUTHENTICATION);
    });

    it('should return AUTHENTICATION for errors mentioning access denied', () => {
      const error = new Error('Access denied to resource');
      expect(classifyErrorType(error)).toBe(ErrorType.AUTHENTICATION);
    });

    it('should return TIMEOUT for TimeoutError', () => {
      const error = new Error();
      error.name = 'TimeoutError';
      expect(classifyErrorType(error)).toBe(ErrorType.TIMEOUT);
    });

    it('should return TIMEOUT for ModelTimeoutException', () => {
      const error = new Error();
      error.name = 'ModelTimeoutException';
      expect(classifyErrorType(error)).toBe(ErrorType.TIMEOUT);
    });

    it('should return TIMEOUT for errors mentioning timeout', () => {
      const error = new Error('Request timeout occurred');
      expect(classifyErrorType(error)).toBe(ErrorType.TIMEOUT);
    });

    it('should return CANCELLED for AbortError', () => {
      const error = new Error();
      error.name = 'AbortError';
      expect(classifyErrorType(error)).toBe(ErrorType.CANCELLED);
    });

    it('should return CANCELLED for CancelledError', () => {
      const error = new Error();
      error.name = 'CancelledError';
      expect(classifyErrorType(error)).toBe(ErrorType.CANCELLED);
    });

    it('should return CIRCUIT_OPEN for CircuitOpenError', () => {
      const error = new Error();
      error.name = 'CircuitOpenError';
      expect(classifyErrorType(error)).toBe(ErrorType.CIRCUIT_OPEN);
    });

    it('should return MODEL_UNAVAILABLE for ModelNotReadyException', () => {
      const error = new Error();
      error.name = 'ModelNotReadyException';
      expect(classifyErrorType(error)).toBe(ErrorType.MODEL_UNAVAILABLE);
    });

    it('should return MODEL_UNAVAILABLE for ServiceUnavailableException', () => {
      const error = new Error();
      error.name = 'ServiceUnavailableException';
      expect(classifyErrorType(error)).toBe(ErrorType.MODEL_UNAVAILABLE);
    });

    it('should return MODEL_UNAVAILABLE for ResourceNotFoundException', () => {
      const error = new Error();
      error.name = 'ResourceNotFoundException';
      expect(classifyErrorType(error)).toBe(ErrorType.MODEL_UNAVAILABLE);
    });

    it('should return NETWORK for NetworkError', () => {
      const error = new Error();
      error.name = 'NetworkError';
      expect(classifyErrorType(error)).toBe(ErrorType.NETWORK);
    });

    it('should return NETWORK for NetworkingError', () => {
      const error = new Error();
      error.name = 'NetworkingError';
      expect(classifyErrorType(error)).toBe(ErrorType.NETWORK);
    });

    it('should return NETWORK for errors mentioning network', () => {
      const error = new Error('Network connection failed');
      expect(classifyErrorType(error)).toBe(ErrorType.NETWORK);
    });

    it('should return NETWORK for ECONNREFUSED errors', () => {
      const error = new Error('connect ECONNREFUSED');
      expect(classifyErrorType(error)).toBe(ErrorType.NETWORK);
    });

    it('should return INTERNAL for InternalServerException', () => {
      const error = new Error();
      error.name = 'InternalServerException';
      expect(classifyErrorType(error)).toBe(ErrorType.INTERNAL);
    });

    it('should return INTERNAL for server faults', () => {
      const error: any = new Error();
      error.$fault = 'server';
      expect(classifyErrorType(error)).toBe(ErrorType.INTERNAL);
    });

    it('should return UNKNOWN for unrecognized errors', () => {
      const error = new Error('Something went wrong');
      error.name = 'CustomError';
      expect(classifyErrorType(error)).toBe(ErrorType.UNKNOWN);
    });
  });

  describe('isThrottlingError', () => {
    it('should return true for throttling error names', () => {
      expect(isThrottlingError('ThrottlingException')).toBe(true);
      expect(isThrottlingError('TooManyRequestsException')).toBe(true);
      expect(isThrottlingError('ServiceQuotaExceededException')).toBe(true);
      expect(isThrottlingError('LimitExceededException')).toBe(true);
      expect(isThrottlingError('RequestLimitExceeded')).toBe(true);
      expect(isThrottlingError('RateLimitExceeded')).toBe(true);
    });

    it('should return false for non-throttling error names', () => {
      expect(isThrottlingError('ValidationException')).toBe(false);
      expect(isThrottlingError('AccessDeniedException')).toBe(false);
      expect(isThrottlingError('InternalServerException')).toBe(false);
      expect(isThrottlingError('')).toBe(false);
    });
  });

  describe('isRetryableError', () => {
    it('should return true for throttling errors', () => {
      const error = new Error();
      error.name = 'ThrottlingException';
      expect(isRetryableError(error)).toBe(true);
    });

    it('should return true for timeout errors', () => {
      const error = new Error();
      error.name = 'TimeoutError';
      expect(isRetryableError(error)).toBe(true);
    });

    it('should return true for network errors', () => {
      const error = new Error();
      error.name = 'NetworkError';
      expect(isRetryableError(error)).toBe(true);
    });

    it('should return true for internal errors', () => {
      const error = new Error();
      error.name = 'InternalServerException';
      expect(isRetryableError(error)).toBe(true);
    });

    it('should return true for model unavailable errors', () => {
      const error = new Error();
      error.name = 'ServiceUnavailableException';
      expect(isRetryableError(error)).toBe(true);
    });

    it('should return false for validation errors', () => {
      const error = new Error();
      error.name = 'ValidationException';
      expect(isRetryableError(error)).toBe(false);
    });

    it('should return false for authentication errors', () => {
      const error = new Error();
      error.name = 'AccessDeniedException';
      expect(isRetryableError(error)).toBe(false);
    });

    it('should return false for cancelled errors', () => {
      const error = new Error();
      error.name = 'AbortError';
      expect(isRetryableError(error)).toBe(false);
    });
  });

  describe('getRetryDelay', () => {
    it('should use retryAfterSeconds if provided', () => {
      const error: any = new Error();
      error.retryAfterSeconds = 5;
      expect(getRetryDelay(error)).toBe(5000);
    });

    it('should use exponential backoff for first attempt', () => {
      const error = new Error();
      const delay = getRetryDelay(error, 1000, 1);
      // Should be 1000 + jitter (up to 300ms)
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(1300);
    });

    it('should use exponential backoff for second attempt', () => {
      const error = new Error();
      const delay = getRetryDelay(error, 1000, 2);
      // Should be 2000 + jitter (up to 600ms)
      expect(delay).toBeGreaterThanOrEqual(2000);
      expect(delay).toBeLessThanOrEqual(2600);
    });

    it('should cap delay at 60 seconds', () => {
      const error = new Error();
      const delay = getRetryDelay(error, 10000, 10);
      expect(delay).toBeLessThanOrEqual(60000);
    });
  });

  describe('toErrorResponse', () => {
    it('should return default response for null error', () => {
      const response = toErrorResponse(null);
      expect(response.code).toBe(500);
      expect(response.message).toBe('Unknown error occurred');
    });

    it('should extract HTTP status code from metadata', () => {
      const error: any = new Error('Bad request');
      error.$metadata = { httpStatusCode: 400 };
      const response = toErrorResponse(error);
      expect(response.code).toBe(400);
    });

    it('should include error message', () => {
      const error = new Error('Something went wrong');
      const response = toErrorResponse(error);
      expect(response.message).toBe('Something went wrong');
    });

    it('should include error details', () => {
      const error: any = new Error('Test error');
      error.name = 'TestError';
      error.$metadata = { requestId: 'req-123' };
      error.$fault = 'client';
      error.requestId = 'req-456';
      error.retryAfterSeconds = 10;
      
      const response = toErrorResponse(error);
      expect(response.details?.name).toBe('TestError');
      expect(response.details?.metadata).toEqual({ requestId: 'req-123' });
      expect(response.details?.fault).toBe('client');
      expect(response.details?.requestId).toBe('req-456');
      expect(response.details?.retryAfterSeconds).toBe(10);
    });

    it('should default to 500 when no HTTP status', () => {
      const error = new Error('Error');
      const response = toErrorResponse(error);
      expect(response.code).toBe(500);
    });
  });

  describe('createEnhancedError', () => {
    it('should create enhanced error with all fields', () => {
      const error = new Error('Test error');
      error.name = 'ThrottlingException';
      
      const enhanced = createEnhancedError(error, ErrorType.THROTTLING, 'model-123', 'Custom message');
      
      expect(enhanced.errorType).toBe(ErrorType.THROTTLING);
      expect(enhanced.retryable).toBe(true);
      expect(enhanced.modelId).toBe('model-123');
      expect(enhanced.message).toBe('Custom message');
      expect(enhanced.recoverySuggestions).toBeDefined();
      expect(enhanced.recoverySuggestions?.length).toBeGreaterThan(0);
    });

    it('should auto-detect error type if not provided', () => {
      const error = new Error();
      error.name = 'ValidationException';
      
      const enhanced = createEnhancedError(error);
      expect(enhanced.errorType).toBe(ErrorType.VALIDATION);
      expect(enhanced.retryable).toBe(false);
    });

    it('should include retryAfterMs for retryable errors', () => {
      const error = new Error();
      error.name = 'ThrottlingException';
      
      const enhanced = createEnhancedError(error);
      expect(enhanced.retryAfterMs).toBeDefined();
      expect(enhanced.retryAfterMs).toBeGreaterThan(0);
    });

    it('should include requestId from metadata', () => {
      const error: any = new Error();
      error.$metadata = { requestId: 'req-123' };
      
      const enhanced = createEnhancedError(error);
      expect(enhanced.requestId).toBe('req-123');
    });
  });

  describe('getRecoverySuggestions', () => {
    it('should return suggestions for THROTTLING', () => {
      const suggestions = getRecoverySuggestions(ErrorType.THROTTLING);
      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions.some(s => s.includes('rate'))).toBe(true);
    });

    it('should return suggestions for VALIDATION', () => {
      const suggestions = getRecoverySuggestions(ErrorType.VALIDATION);
      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions.some(s => s.includes('parameter'))).toBe(true);
    });

    it('should return suggestions for AUTHENTICATION', () => {
      const suggestions = getRecoverySuggestions(ErrorType.AUTHENTICATION);
      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions.some(s => s.includes('credentials'))).toBe(true);
    });

    it('should return suggestions for TIMEOUT', () => {
      const suggestions = getRecoverySuggestions(ErrorType.TIMEOUT);
      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions.some(s => s.includes('timeout'))).toBe(true);
    });

    it('should return suggestions for CANCELLED', () => {
      const suggestions = getRecoverySuggestions(ErrorType.CANCELLED);
      expect(suggestions.length).toBeGreaterThan(0);
    });

    it('should return suggestions for CIRCUIT_OPEN', () => {
      const suggestions = getRecoverySuggestions(ErrorType.CIRCUIT_OPEN);
      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions.some(s => s.includes('circuit'))).toBe(true);
    });

    it('should return suggestions for MODEL_UNAVAILABLE', () => {
      const suggestions = getRecoverySuggestions(ErrorType.MODEL_UNAVAILABLE);
      expect(suggestions.length).toBeGreaterThan(0);
    });

    it('should return suggestions for NETWORK', () => {
      const suggestions = getRecoverySuggestions(ErrorType.NETWORK);
      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions.some(s => s.includes('network'))).toBe(true);
    });

    it('should return suggestions for INTERNAL', () => {
      const suggestions = getRecoverySuggestions(ErrorType.INTERNAL);
      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions.some(s => s.includes('retry') || s.includes('Retry'))).toBe(true);
    });

    it('should return generic suggestions for UNKNOWN', () => {
      const suggestions = getRecoverySuggestions(ErrorType.UNKNOWN);
      expect(suggestions.length).toBeGreaterThan(0);
    });
  });

  describe('getErrorMessage', () => {
    it('should return default message for null error', () => {
      expect(getErrorMessage(null)).toBe('Unknown error occurred');
    });

    it('should return specific message for ThrottlingException', () => {
      const error = new Error();
      error.name = 'ThrottlingException';
      expect(getErrorMessage(error)).toContain('throttled');
    });

    it('should return specific message for ValidationException', () => {
      const error = new Error();
      error.name = 'ValidationException';
      expect(getErrorMessage(error)).toContain('validation');
    });

    it('should return specific message for AccessDeniedException', () => {
      const error = new Error();
      error.name = 'AccessDeniedException';
      expect(getErrorMessage(error)).toContain('Access denied');
    });

    it('should return specific message for InternalServerException', () => {
      const error = new Error();
      error.name = 'InternalServerException';
      expect(getErrorMessage(error)).toContain('Internal server error');
    });

    it('should return specific message for ModelNotReadyException', () => {
      const error = new Error();
      error.name = 'ModelNotReadyException';
      expect(getErrorMessage(error)).toContain('not ready');
    });

    it('should return specific message for ModelTimeoutException', () => {
      const error = new Error();
      error.name = 'ModelTimeoutException';
      expect(getErrorMessage(error)).toContain('timed out');
    });

    it('should return specific message for ServiceUnavailableException', () => {
      const error = new Error();
      error.name = 'ServiceUnavailableException';
      expect(getErrorMessage(error)).toContain('unavailable');
    });

    it('should return specific message for ResourceNotFoundException', () => {
      const error = new Error();
      error.name = 'ResourceNotFoundException';
      expect(getErrorMessage(error)).toContain('not found');
    });

    it('should return specific message for TimeoutError', () => {
      const error = new Error();
      error.name = 'TimeoutError';
      expect(getErrorMessage(error)).toContain('timed out');
    });

    it('should return specific message for AbortError', () => {
      const error = new Error();
      error.name = 'AbortError';
      expect(getErrorMessage(error)).toContain('cancelled');
    });

    it('should return specific message for CircuitOpenError', () => {
      const error = new Error();
      error.name = 'CircuitOpenError';
      expect(getErrorMessage(error)).toContain('Circuit breaker');
    });

    it('should return error message for unknown errors', () => {
      const error = new Error('Custom error message');
      error.name = 'CustomError';
      expect(getErrorMessage(error)).toBe('Custom error message');
    });

    it('should return error name when no message', () => {
      const error = new Error();
      error.name = 'SomeError';
      expect(getErrorMessage(error)).toContain('SomeError');
    });
  });
});
