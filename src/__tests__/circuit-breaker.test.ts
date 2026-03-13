/**
 * Unit tests for circuit-breaker utility
 */

import {
  CircuitBreaker,
  CircuitBreakerManager,
  DEFAULT_CIRCUIT_BREAKER_CONFIG
} from '../utils/circuit-breaker';
import { CircuitBreakerState, ErrorType } from '../types/index';

describe('CircuitBreaker', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('constructor', () => {
    it('should create circuit breaker with default config', () => {
      const cb = new CircuitBreaker('test-model');
      expect(cb.getState()).toBe(CircuitBreakerState.CLOSED);
    });

    it('should create circuit breaker with custom config', () => {
      const cb = new CircuitBreaker('test-model', {
        failureThreshold: 3,
        recoveryTimeMs: 10000
      });
      expect(cb.getState()).toBe(CircuitBreakerState.CLOSED);
    });
  });

  describe('getState', () => {
    it('should return CLOSED initially', () => {
      const cb = new CircuitBreaker('test-model');
      expect(cb.getState()).toBe(CircuitBreakerState.CLOSED);
    });

    it('should return OPEN after threshold failures', () => {
      const cb = new CircuitBreaker('test-model', { failureThreshold: 3 });
      
      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();
      
      expect(cb.getState()).toBe(CircuitBreakerState.OPEN);
    });

    it('should transition to HALF_OPEN after recovery time', () => {
      const cb = new CircuitBreaker('test-model', {
        failureThreshold: 1,
        recoveryTimeMs: 5000
      });
      
      cb.recordFailure();
      expect(cb.getState()).toBe(CircuitBreakerState.OPEN);
      
      jest.advanceTimersByTime(5000);
      expect(cb.getState()).toBe(CircuitBreakerState.HALF_OPEN);
    });
  });

  describe('getStatus', () => {
    it('should return complete status', () => {
      const cb = new CircuitBreaker('test-model');
      const status = cb.getStatus();
      
      expect(status.state).toBe(CircuitBreakerState.CLOSED);
      expect(status.failureCount).toBe(0);
      expect(status.successCount).toBe(0);
      expect(status.lastOpenedAt).toBeUndefined();
      expect(status.nextRetryAt).toBeUndefined();
    });

    it('should include nextRetryAt when open', () => {
      const cb = new CircuitBreaker('test-model', {
        failureThreshold: 1,
        recoveryTimeMs: 5000
      });
      
      cb.recordFailure();
      const status = cb.getStatus();
      
      expect(status.state).toBe(CircuitBreakerState.OPEN);
      expect(status.lastOpenedAt).toBeDefined();
      expect(status.nextRetryAt).toBeDefined();
    });
  });

  describe('canExecute', () => {
    it('should return true when closed', () => {
      const cb = new CircuitBreaker('test-model');
      expect(cb.canExecute()).toBe(true);
    });

    it('should return false when open', () => {
      const cb = new CircuitBreaker('test-model', { failureThreshold: 1 });
      cb.recordFailure();
      expect(cb.canExecute()).toBe(false);
    });

    it('should return true when half-open', () => {
      const cb = new CircuitBreaker('test-model', {
        failureThreshold: 1,
        recoveryTimeMs: 5000
      });
      
      cb.recordFailure();
      jest.advanceTimersByTime(5000);
      expect(cb.canExecute()).toBe(true);
    });
  });

  describe('recordSuccess', () => {
    it('should clear failures when closed', () => {
      const cb = new CircuitBreaker('test-model', {
        failureThreshold: 3,
        failureWindowMs: 60000
      });
      
      cb.recordFailure();
      cb.recordFailure();
      cb.recordSuccess();
      cb.recordFailure();
      
      // Should not open because failures were cleared
      expect(cb.getState()).toBe(CircuitBreakerState.CLOSED);
    });

    it('should close circuit after enough successes in half-open', () => {
      const cb = new CircuitBreaker('test-model', {
        failureThreshold: 1,
        recoveryTimeMs: 5000,
        successThreshold: 2
      });
      
      cb.recordFailure();
      jest.advanceTimersByTime(5000);
      
      expect(cb.getState()).toBe(CircuitBreakerState.HALF_OPEN);
      
      cb.recordSuccess();
      expect(cb.getState()).toBe(CircuitBreakerState.HALF_OPEN);
      
      cb.recordSuccess();
      expect(cb.getState()).toBe(CircuitBreakerState.CLOSED);
    });
  });

  describe('recordFailure', () => {
    it('should open circuit after threshold failures', () => {
      const cb = new CircuitBreaker('test-model', {
        failureThreshold: 3,
        failureWindowMs: 60000
      });
      
      cb.recordFailure();
      expect(cb.getState()).toBe(CircuitBreakerState.CLOSED);
      
      cb.recordFailure();
      expect(cb.getState()).toBe(CircuitBreakerState.CLOSED);
      
      cb.recordFailure();
      expect(cb.getState()).toBe(CircuitBreakerState.OPEN);
    });

    it('should re-open circuit on failure in half-open state', () => {
      const cb = new CircuitBreaker('test-model', {
        failureThreshold: 1,
        recoveryTimeMs: 5000
      });
      
      cb.recordFailure();
      jest.advanceTimersByTime(5000);
      
      expect(cb.getState()).toBe(CircuitBreakerState.HALF_OPEN);
      
      cb.recordFailure();
      expect(cb.getState()).toBe(CircuitBreakerState.OPEN);
    });

    it('should accept error parameter', () => {
      const cb = new CircuitBreaker('test-model', { failureThreshold: 1 });
      const error = new Error('Test error');
      
      expect(() => cb.recordFailure(error)).not.toThrow();
      expect(cb.getState()).toBe(CircuitBreakerState.OPEN);
    });

    it('should ignore old failures outside the window', () => {
      const cb = new CircuitBreaker('test-model', {
        failureThreshold: 3,
        failureWindowMs: 10000
      });
      
      cb.recordFailure();
      cb.recordFailure();
      
      // Wait longer than the failure window
      jest.advanceTimersByTime(15000);
      
      cb.recordFailure();
      // Old failures should be cleaned up, only 1 recent failure
      expect(cb.getState()).toBe(CircuitBreakerState.CLOSED);
    });
  });

  describe('getCircuitOpenError', () => {
    it('should return enhanced error response', () => {
      const cb = new CircuitBreaker('test-model', {
        failureThreshold: 1,
        recoveryTimeMs: 5000
      });
      
      cb.recordFailure();
      const error = cb.getCircuitOpenError();
      
      expect(error.code).toBe(503);
      expect(error.errorType).toBe(ErrorType.CIRCUIT_OPEN);
      expect(error.retryable).toBe(true);
      expect(error.modelId).toBe('test-model');
      expect(error.retryAfterMs).toBeDefined();
      expect(error.recoverySuggestions).toBeDefined();
      expect(error.details?.circuitState).toBe(CircuitBreakerState.OPEN);
    });
  });

  describe('forceOpen', () => {
    it('should open the circuit', () => {
      const cb = new CircuitBreaker('test-model');
      expect(cb.getState()).toBe(CircuitBreakerState.CLOSED);
      
      cb.forceOpen();
      expect(cb.getState()).toBe(CircuitBreakerState.OPEN);
    });
  });

  describe('forceClose', () => {
    it('should close the circuit', () => {
      const cb = new CircuitBreaker('test-model', { failureThreshold: 1 });
      cb.recordFailure();
      expect(cb.getState()).toBe(CircuitBreakerState.OPEN);
      
      cb.forceClose();
      expect(cb.getState()).toBe(CircuitBreakerState.CLOSED);
    });
  });

  describe('reset', () => {
    it('should reset to initial state', () => {
      const cb = new CircuitBreaker('test-model', { failureThreshold: 1 });
      cb.recordFailure();
      expect(cb.getState()).toBe(CircuitBreakerState.OPEN);
      
      cb.reset();
      
      expect(cb.getState()).toBe(CircuitBreakerState.CLOSED);
      const status = cb.getStatus();
      expect(status.failureCount).toBe(0);
      expect(status.successCount).toBe(0);
      expect(status.lastOpenedAt).toBeUndefined();
    });
  });
});

describe('CircuitBreakerManager', () => {
  describe('constructor', () => {
    it('should create manager with default config', () => {
      const manager = new CircuitBreakerManager();
      expect(manager).toBeDefined();
    });

    it('should create manager with custom config', () => {
      const manager = new CircuitBreakerManager({ failureThreshold: 10 });
      expect(manager).toBeDefined();
    });
  });

  describe('getBreaker', () => {
    it('should create new breaker for unknown model', () => {
      const manager = new CircuitBreakerManager();
      const breaker = manager.getBreaker('model-1');
      
      expect(breaker).toBeDefined();
      expect(breaker.getState()).toBe(CircuitBreakerState.CLOSED);
    });

    it('should return same breaker for same model', () => {
      const manager = new CircuitBreakerManager();
      const breaker1 = manager.getBreaker('model-1');
      const breaker2 = manager.getBreaker('model-1');
      
      expect(breaker1).toBe(breaker2);
    });

    it('should use custom config when provided', () => {
      const manager = new CircuitBreakerManager();
      const breaker = manager.getBreaker('model-1', { failureThreshold: 1 });
      
      breaker.recordFailure();
      expect(breaker.getState()).toBe(CircuitBreakerState.OPEN);
    });
  });

  describe('canExecute', () => {
    it('should return true for unknown model', () => {
      const manager = new CircuitBreakerManager();
      expect(manager.canExecute('unknown-model')).toBe(true);
    });

    it('should delegate to breaker', () => {
      const manager = new CircuitBreakerManager({ failureThreshold: 1 });
      manager.getBreaker('model-1').recordFailure();
      
      expect(manager.canExecute('model-1')).toBe(false);
    });
  });

  describe('recordSuccess', () => {
    it('should delegate to breaker', () => {
      const manager = new CircuitBreakerManager();
      manager.recordSuccess('model-1');
      
      const breaker = manager.getBreaker('model-1');
      expect(breaker.getState()).toBe(CircuitBreakerState.CLOSED);
    });
  });

  describe('recordFailure', () => {
    it('should delegate to breaker', () => {
      const manager = new CircuitBreakerManager({ failureThreshold: 1 });
      manager.recordFailure('model-1');
      
      expect(manager.canExecute('model-1')).toBe(false);
    });

    it('should accept error parameter', () => {
      const manager = new CircuitBreakerManager({ failureThreshold: 1 });
      const error = new Error('Test');
      
      expect(() => manager.recordFailure('model-1', error)).not.toThrow();
    });
  });

  describe('getAllStatus', () => {
    it('should return empty object when no breakers', () => {
      const manager = new CircuitBreakerManager();
      expect(manager.getAllStatus()).toEqual({});
    });

    it('should return status for all breakers', () => {
      const manager = new CircuitBreakerManager();
      manager.getBreaker('model-1');
      manager.getBreaker('model-2');
      
      const status = manager.getAllStatus();
      expect(Object.keys(status)).toHaveLength(2);
      expect(status['model-1']).toBeDefined();
      expect(status['model-2']).toBeDefined();
    });
  });

  describe('resetAll', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should reset all breakers', () => {
      const manager = new CircuitBreakerManager({ failureThreshold: 1 });
      manager.recordFailure('model-1');
      manager.recordFailure('model-2');
      
      expect(manager.canExecute('model-1')).toBe(false);
      expect(manager.canExecute('model-2')).toBe(false);
      
      manager.resetAll();
      
      expect(manager.canExecute('model-1')).toBe(true);
      expect(manager.canExecute('model-2')).toBe(true);
    });
  });

  describe('removeBreaker', () => {
    it('should remove breaker for model', () => {
      const manager = new CircuitBreakerManager();
      const breaker1 = manager.getBreaker('model-1');
      
      manager.removeBreaker('model-1');
      
      const breaker2 = manager.getBreaker('model-1');
      expect(breaker1).not.toBe(breaker2);
    });
  });

  describe('clear', () => {
    it('should clear all breakers', () => {
      const manager = new CircuitBreakerManager();
      manager.getBreaker('model-1');
      manager.getBreaker('model-2');
      
      manager.clear();
      
      expect(manager.getAllStatus()).toEqual({});
    });
  });
});

describe('DEFAULT_CIRCUIT_BREAKER_CONFIG', () => {
  it('should have expected default values', () => {
    expect(DEFAULT_CIRCUIT_BREAKER_CONFIG.failureThreshold).toBe(5);
    expect(DEFAULT_CIRCUIT_BREAKER_CONFIG.recoveryTimeMs).toBe(30000);
    expect(DEFAULT_CIRCUIT_BREAKER_CONFIG.successThreshold).toBe(2);
    expect(DEFAULT_CIRCUIT_BREAKER_CONFIG.failureWindowMs).toBe(60000);
  });
});
