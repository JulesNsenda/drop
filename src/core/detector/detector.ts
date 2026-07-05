/**
 * Detector Service Implementation
 *
 * Coordinates multiple detectors to identify application types
 * and generate suggested configurations.
 */

import * as fs from 'fs/promises';
import { eventBus } from '../event-bus';
import {
  DetectionResult,
  DetectorConfig,
  AppDetector,
  AppType,
} from './detector.types';

// Import individual detectors
import { manifestDetector } from './detectors/manifest';
import { nodejsDetector } from './detectors/nodejs';
import { pythonDetector } from './detectors/python';
import { goDetector } from './detectors/go';
import { staticDetector } from './detectors/static';
import { dockerDetector } from './detectors/docker';

const DEFAULT_CONFIG: DetectorConfig = {
  confidenceThreshold: 0.5,
  enableManifestDetection: true,
  customDetectors: [],
};

export class DetectorService {
  private readonly config: DetectorConfig;
  private readonly detectors: AppDetector[] = [];

  constructor(config: Partial<DetectorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Register built-in detectors in priority order
    this.registerBuiltinDetectors();

    // Register custom detectors
    for (const detector of this.config.customDetectors) {
      this.registerDetector(detector);
    }
  }

  /**
   * Detect the application type for a given path
   */
  async detect(appPath: string, options?: { silent?: boolean }): Promise<DetectionResult> {
    // Verify path exists
    try {
      const stat = await fs.stat(appPath);
      if (!stat.isDirectory()) {
        throw new Error(`Path is not a directory: ${appPath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Path does not exist: ${appPath}`);
      }
      throw error;
    }

    // Sort detectors by priority (highest first)
    const sortedDetectors = [...this.detectors].sort((a, b) => b.priority - a.priority);

    const results: DetectionResult[] = [];

    // Run detectors
    for (const detector of sortedDetectors) {
      try {
        const result = await detector.detect(appPath);

        if (result) {
          results.push(result);

          // If we have high confidence, we can stop early
          if (result.confidence >= 0.95) {
            break;
          }
        }
      } catch (error) {
        console.warn(`Detector ${detector.name} failed:`, error);
      }
    }

    // Select best result
    const bestResult = this.selectBestResult(results);

    // Emit detection event — unless the caller is re-detecting an
    // already-onboarded app (build/start/hot-reload). Re-publishing there
    // re-triggers registerApp and flickers the app's status back to 'pending'.
    if (!options?.silent) {
      eventBus.publish('app:detected', {
        name: appPath.split(/[/\\]/).pop() || 'unknown',
        path: appPath,
        type: bestResult.type,
      });
    }

    return bestResult;
  }

  /**
   * Register a custom detector
   */
  registerDetector(detector: AppDetector): void {
    // Remove existing detector with same name
    const existingIndex = this.detectors.findIndex(d => d.name === detector.name);
    if (existingIndex >= 0) {
      this.detectors.splice(existingIndex, 1);
    }

    this.detectors.push(detector);
  }

  /**
   * Get list of registered detectors
   */
  getDetectors(): AppDetector[] {
    return [...this.detectors];
  }

  /**
   * Get configuration
   */
  getConfig(): DetectorConfig {
    return { ...this.config };
  }

  private registerBuiltinDetectors(): void {
    // Manifest detector has highest priority
    if (this.config.enableManifestDetection) {
      this.detectors.push(manifestDetector);
    }

    // Framework-specific detectors
    this.detectors.push(nodejsDetector);
    this.detectors.push(pythonDetector);
    this.detectors.push(goDetector);
    this.detectors.push(dockerDetector);

    // Static site detector as fallback
    this.detectors.push(staticDetector);
  }

  private selectBestResult(results: DetectionResult[]): DetectionResult {
    if (results.length === 0) {
      return this.createUnknownResult();
    }

    // Filter by confidence threshold
    const validResults = results.filter(r => r.confidence >= this.config.confidenceThreshold);

    if (validResults.length === 0) {
      // Return the best result even if below threshold, but add warning
      const best = results.reduce((a, b) => (a.confidence > b.confidence ? a : b));
      best.warnings.push(
        `Low confidence detection (${(best.confidence * 100).toFixed(0)}%) - consider adding a drop.yaml manifest`
      );
      return best;
    }

    // Return highest confidence result
    return validResults.reduce((a, b) => (a.confidence > b.confidence ? a : b));
  }

  private createUnknownResult(): DetectionResult {
    return {
      type: 'unknown',
      framework: null,
      confidence: 0,
      detectedBy: 'none',
      suggestedConfig: {},
      warnings: [
        'Could not detect application type',
        'Consider adding a drop.yaml manifest file',
      ],
      metadata: {},
    };
  }
}

// Factory function
export function createDetectorService(config?: Partial<DetectorConfig>): DetectorService {
  return new DetectorService(config);
}

// Singleton instance
let detectorInstance: DetectorService | null = null;

export function getDetector(config?: Partial<DetectorConfig>): DetectorService {
  if (!detectorInstance) {
    detectorInstance = new DetectorService(config);
  }
  return detectorInstance;
}

export function resetDetector(): void {
  detectorInstance = null;
}

// Re-export types
export type { DetectionResult, DetectorConfig, AppDetector, AppType };
