/**
 * Unit tests for Timer utility
 */

import { Timer } from '../utils/timer';

describe('Timer', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('constructor', () => {
    it('should create a timer with a callback', () => {
      const callback = jest.fn();
      const timer = new Timer(callback);
      expect(timer).toBeDefined();
      expect(timer.isRunning()).toBe(false);
    });
  });

  describe('start', () => {
    it('should start the timer', () => {
      const callback = jest.fn();
      const timer = new Timer(callback);
      
      timer.start(1000);
      expect(timer.isRunning()).toBe(true);
      
      jest.advanceTimersByTime(1000);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(timer.isRunning()).toBe(false);
    });

    it('should cancel existing timer when starting a new one', () => {
      const callback = jest.fn();
      const timer = new Timer(callback);
      
      timer.start(1000);
      timer.start(2000);
      
      jest.advanceTimersByTime(1000);
      expect(callback).not.toHaveBeenCalled();
      
      jest.advanceTimersByTime(1000);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('should handle zero duration', () => {
      const callback = jest.fn();
      const timer = new Timer(callback);
      
      timer.start(0);
      expect(timer.isRunning()).toBe(true);
      
      jest.advanceTimersByTime(0);
      expect(callback).toHaveBeenCalledTimes(1);
    });
  });

  describe('cancel', () => {
    it('should cancel a running timer', () => {
      const callback = jest.fn();
      const timer = new Timer(callback);
      
      timer.start(1000);
      timer.cancel();
      
      expect(timer.isRunning()).toBe(false);
      jest.advanceTimersByTime(1000);
      expect(callback).not.toHaveBeenCalled();
    });

    it('should be safe to call cancel on non-running timer', () => {
      const callback = jest.fn();
      const timer = new Timer(callback);
      
      expect(() => timer.cancel()).not.toThrow();
      expect(timer.isRunning()).toBe(false);
    });

    it('should be safe to call cancel multiple times', () => {
      const callback = jest.fn();
      const timer = new Timer(callback);
      
      timer.start(1000);
      timer.cancel();
      timer.cancel();
      
      expect(timer.isRunning()).toBe(false);
    });
  });

  describe('isRunning', () => {
    it('should return false initially', () => {
      const timer = new Timer(jest.fn());
      expect(timer.isRunning()).toBe(false);
    });

    it('should return true when timer is running', () => {
      const timer = new Timer(jest.fn());
      timer.start(1000);
      expect(timer.isRunning()).toBe(true);
    });

    it('should return false after timer completes', () => {
      const timer = new Timer(jest.fn());
      timer.start(1000);
      jest.advanceTimersByTime(1000);
      expect(timer.isRunning()).toBe(false);
    });

    it('should return false after timer is cancelled', () => {
      const timer = new Timer(jest.fn());
      timer.start(1000);
      timer.cancel();
      expect(timer.isRunning()).toBe(false);
    });
  });
});
