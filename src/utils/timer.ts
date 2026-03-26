import { MultiplexerTimer } from '../types/index';

/**
 * Timer implementation for managing model re-enabling timeouts
 * Provides a clean interface over Node.js setTimeout/clearTimeout
 */
export class Timer implements MultiplexerTimer {
  private timerId: NodeJS.Timeout | null = null;
  private readonly callback: () => void;

  /**
   * Create a new timer with a callback function
   * @param callback Function to call when timer expires
   */
  constructor(callback: () => void) {
    this.callback = callback;
  }

  /**
   * Start the timer with specified duration
   * @param durationMs Duration in milliseconds
   */
  public start(durationMs: number): void {
    // Cancel any existing timer first
    this.cancel();
    
    this.timerId = setTimeout(() => {
      this.timerId = null;
      this.callback();
    }, durationMs);
  }

  /**
   * Cancel the timer if it's running
   */
  public cancel(): void {
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  /**
   * Check if the timer is currently running
   * @returns True if timer is active, false otherwise
   */
  public isRunning(): boolean {
    return this.timerId !== null;
  }
} 