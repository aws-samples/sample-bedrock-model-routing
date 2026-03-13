/**
 * Health check functionality for the Amazon Bedrock Model Multiplexer
 * Provides model status monitoring and system health endpoints
 */

import {
  ModelHealthStatus,
  SystemHealthStatus,
  CircuitBreakerState,
  ModelStats
} from '../types/index.js';
import { CircuitBreakerManager } from './circuit-breaker.js';

/**
 * Request metrics tracker for a model
 */
interface ModelMetrics {
  requestTimestamps: Date[];
  responseTimes: number[];
  successCount: number;
  failureCount: number;
  lastSuccessAt?: Date;
  lastFailureAt?: Date;
}

/**
 * Health check manager for the multiplexer
 */
export class HealthCheckManager {
  private readonly modelMetrics: Map<string, ModelMetrics> = new Map();
  private readonly circuitBreakerManager: CircuitBreakerManager;
  private readonly metricsWindowMs: number;
  private readonly maxMetricsHistory: number;

  /**
   * Create a new HealthCheckManager
   * @param circuitBreakerManager Circuit breaker manager instance
   * @param metricsWindowMs Time window for calculating metrics (default: 60000ms = 1 minute)
   * @param maxMetricsHistory Maximum number of metrics to keep per model (default: 1000)
   */
  constructor(
    circuitBreakerManager: CircuitBreakerManager,
    metricsWindowMs: number = 60000,
    maxMetricsHistory: number = 1000
  ) {
    this.circuitBreakerManager = circuitBreakerManager;
    this.metricsWindowMs = metricsWindowMs;
    this.maxMetricsHistory = maxMetricsHistory;
  }

  /**
   * Record a successful request for a model
   * @param modelId Model identifier
   * @param responseTimeMs Response time in milliseconds
   */
  public recordSuccess(modelId: string, responseTimeMs: number): void {
    const metrics = this.getOrCreateMetrics(modelId);
    const now = new Date();
    
    metrics.requestTimestamps.push(now);
    metrics.responseTimes.push(responseTimeMs);
    metrics.successCount++;
    metrics.lastSuccessAt = now;
    
    this.trimMetrics(metrics);
  }

  /**
   * Record a failed request for a model
   * @param modelId Model identifier
   * @param responseTimeMs Response time in milliseconds
   */
  public recordFailure(modelId: string, responseTimeMs: number): void {
    const metrics = this.getOrCreateMetrics(modelId);
    const now = new Date();
    
    metrics.requestTimestamps.push(now);
    metrics.responseTimes.push(responseTimeMs);
    metrics.failureCount++;
    metrics.lastFailureAt = now;
    
    this.trimMetrics(metrics);
  }

  /**
   * Get health status for a specific model
   * @param modelId Model identifier
   * @param modelStats Optional model stats from the multiplexer
   */
  public getModelHealth(
    modelId: string,
    modelStats?: ModelStats
  ): ModelHealthStatus {
    const metrics = this.modelMetrics.get(modelId);
    const circuitStatus = this.circuitBreakerManager.getBreaker(modelId).getStatus();
    
    // Calculate metrics from recent data
    const recentTimestamps = this.getRecentTimestamps(metrics);
    const recentResponseTimes = this.getRecentResponseTimes(metrics);
    
    const totalRequests = metrics ? (metrics.successCount + metrics.failureCount) : 0;
    const errorRate = totalRequests > 0
      ? (metrics?.failureCount ?? 0) / totalRequests
      : 0;
    
    const avgResponseTimeMs = recentResponseTimes.length > 0
      ? recentResponseTimes.reduce((sum, t) => sum + t, 0) / recentResponseTimes.length
      : (modelStats?.averageLatency ?? 0);
    
    const isHealthy = circuitStatus.state !== CircuitBreakerState.OPEN &&
      errorRate < 0.5;

    return {
      modelId,
      isHealthy,
      circuitState: circuitStatus.state,
      lastSuccessAt: metrics?.lastSuccessAt,
      lastFailureAt: metrics?.lastFailureAt,
      avgResponseTimeMs,
      errorRate,
      requestsPerMinute: recentTimestamps.length
    };
  }

  /**
   * Get overall system health status
   * @param modelStatsMap Map of model IDs to model stats
   */
  public getSystemHealth(
    modelStatsMap: Record<string, ModelStats> = {}
  ): SystemHealthStatus {
    const modelIds = new Set([
      ...Object.keys(modelStatsMap),
      ...Array.from(this.modelMetrics.keys())
    ]);
    
    const models: Record<string, ModelHealthStatus> = {};
    let healthyCount = 0;
    let degradedCount = 0;
    let unhealthyCount = 0;
    let totalRequests = 0;
    let totalSuccesses = 0;
    let totalLatencySum = 0;
    let totalLatencyCount = 0;
    const allResponseTimes: number[] = [];
    
    modelIds.forEach(modelId => {
      const modelStats = modelStatsMap[modelId];
      const health = this.getModelHealth(modelId, modelStats);
      models[modelId] = health;
      
      if (health.isHealthy && health.circuitState === CircuitBreakerState.CLOSED) {
        healthyCount++;
      } else if (health.isHealthy) {
        degradedCount++; // Half-open or other transitional states
      } else {
        unhealthyCount++;
      }
      
      // Aggregate metrics
      const metrics = this.modelMetrics.get(modelId);
      if (metrics) {
        totalRequests += metrics.successCount + metrics.failureCount;
        totalSuccesses += metrics.successCount;
        const recentTimes = this.getRecentResponseTimes(metrics);
        allResponseTimes.push(...recentTimes);
        totalLatencySum += recentTimes.reduce((sum, t) => sum + t, 0);
        totalLatencyCount += recentTimes.length;
      }
    });
    
    // Calculate p99 latency
    let p99LatencyMs = 0;
    if (allResponseTimes.length > 0) {
      allResponseTimes.sort((a, b) => a - b);
      const p99Index = Math.floor(allResponseTimes.length * 0.99);
      p99LatencyMs = allResponseTimes[p99Index] || allResponseTimes[allResponseTimes.length - 1];
    }
    
    const totalModels = modelIds.size;
    // Math.max(1, ...) provides that a single healthy model reports healthy:
    // floor(1/2)=0 would make "0 < 0" false in all cases, but max(1, 0)=1 gives "0 < 1" = true.
    // For totalModels >= 2, max(1, floor(n/2)) === floor(n/2), so no behavioral change.
    const isHealthy = unhealthyCount < Math.max(1, Math.floor(totalModels / 2)) && healthyCount > 0;
    
    return {
      isHealthy,
      timestamp: new Date(),
      totalModels,
      healthyModels: healthyCount,
      degradedModels: degradedCount,
      unhealthyModels: unhealthyCount,
      models,
      metrics: {
        totalRequests,
        successRate: totalRequests > 0 ? totalSuccesses / totalRequests : 1,
        averageLatencyMs: totalLatencyCount > 0 ? totalLatencySum / totalLatencyCount : 0,
        p99LatencyMs
      }
    };
  }

  /**
   * Reset metrics for a model
   * @param modelId Model identifier
   */
  public resetModelMetrics(modelId: string): void {
    this.modelMetrics.delete(modelId);
  }

  /**
   * Reset all metrics
   */
  public resetAllMetrics(): void {
    this.modelMetrics.clear();
  }

  /**
   * Register a model with the health checker
   * @param modelId Model identifier
   */
  public registerModel(modelId: string): void {
    if (!this.modelMetrics.has(modelId)) {
      this.modelMetrics.set(modelId, {
        requestTimestamps: [],
        responseTimes: [],
        successCount: 0,
        failureCount: 0
      });
    }
  }

  /**
   * Unregister a model from the health checker
   * @param modelId Model identifier
   */
  public unregisterModel(modelId: string): void {
    this.modelMetrics.delete(modelId);
  }

  /**
   * Check if the system is healthy enough to accept requests
   */
  public isSystemAcceptingRequests(
    modelStatsMap: Record<string, ModelStats> = {}
  ): boolean {
    const health = this.getSystemHealth(modelStatsMap);
    return health.isHealthy && health.healthyModels > 0;
  }

  /**
   * Get or create metrics for a model
   */
  private getOrCreateMetrics(modelId: string): ModelMetrics {
    let metrics = this.modelMetrics.get(modelId);
    if (!metrics) {
      metrics = {
        requestTimestamps: [],
        responseTimes: [],
        successCount: 0,
        failureCount: 0
      };
      this.modelMetrics.set(modelId, metrics);
    }
    return metrics;
  }

  /**
   * Get timestamps within the metrics window
   */
  private getRecentTimestamps(metrics?: ModelMetrics): Date[] {
    if (!metrics) return [];
    const cutoff = Date.now() - this.metricsWindowMs;
    return metrics.requestTimestamps.filter(ts => ts.getTime() > cutoff);
  }

  /**
   * Get response times for recent requests
   */
  private getRecentResponseTimes(metrics?: ModelMetrics): number[] {
    if (!metrics) return [];
    const cutoff = Date.now() - this.metricsWindowMs;
    const recentIndices = metrics.requestTimestamps
      .map((ts, i) => ts.getTime() > cutoff ? i : -1)
      .filter(i => i >= 0);
    return recentIndices.map(i => metrics.responseTimes[i]);
  }

  /**
   * Trim old metrics to prevent memory growth
   */
  private trimMetrics(metrics: ModelMetrics): void {
    if (metrics.requestTimestamps.length > this.maxMetricsHistory) {
      const excess = metrics.requestTimestamps.length - this.maxMetricsHistory;
      metrics.requestTimestamps = metrics.requestTimestamps.slice(excess);
      metrics.responseTimes = metrics.responseTimes.slice(excess);
    }
  }
}

/**
 * Health check endpoint response formatter
 */
export class HealthCheckEndpoint {
  private readonly healthManager: HealthCheckManager;

  constructor(healthManager: HealthCheckManager) {
    this.healthManager = healthManager;
  }

  /**
   * Get a simple health check response (suitable for load balancer)
   * @param modelStatsMap Model stats from multiplexer
   */
  public getSimpleHealth(
    modelStatsMap: Record<string, ModelStats> = {}
  ): { status: 'healthy' | 'unhealthy'; code: number } {
    const isHealthy = this.healthManager.isSystemAcceptingRequests(modelStatsMap);
    return {
      status: isHealthy ? 'healthy' : 'unhealthy',
      code: isHealthy ? 200 : 503
    };
  }

  /**
   * Get detailed health check response
   * @param modelStatsMap Model stats from multiplexer
   */
  public getDetailedHealth(
    modelStatsMap: Record<string, ModelStats> = {}
  ): SystemHealthStatus {
    return this.healthManager.getSystemHealth(modelStatsMap);
  }

  /**
   * Get health for a specific model
   * @param modelId Model identifier
   * @param modelStats Model stats
   */
  public getModelHealth(
    modelId: string,
    modelStats?: ModelStats
  ): ModelHealthStatus {
    return this.healthManager.getModelHealth(modelId, modelStats);
  }
}
