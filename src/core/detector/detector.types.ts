/**
 * Detector Service Type Definitions
 *
 * Defines all types for application detection and configuration.
 */

// Supported application types
export type AppType =
  | 'nodejs'
  | 'nextjs'
  | 'nuxt'
  | 'sveltekit'
  | 'remix'
  | 'astro'
  | 'express'
  | 'fastify'
  | 'hono'
  | 'nest'
  | 'static'
  | 'spa'
  | 'python'
  | 'django'
  | 'flask'
  | 'fastapi'
  | 'go'
  | 'rust'
  | 'php'
  | 'docker'
  | 'proxy'
  | 'unknown';

// Suggested configuration for an app
export interface SuggestedConfig {
  buildCommand?: string;
  startCommand?: string;
  installCommand?: string;
  outputDirectory?: string;
  port?: number;
  env?: Record<string, string>;
  nodeVersion?: string;
  pythonVersion?: string;
  /** Database requirement detected from manifest or ORM config files */
  database?: DatabaseType;
}

// Detection result
export interface DetectionResult {
  type: AppType;
  framework: string | null;
  confidence: number;
  detectedBy: string;
  suggestedConfig: SuggestedConfig;
  warnings: string[];
  metadata: Record<string, unknown>;
}

// Individual detector interface
export interface AppDetector {
  name: string;
  priority: number;
  detect(appPath: string): Promise<DetectionResult | null>;
}

// Detector service configuration
export interface DetectorConfig {
  confidenceThreshold: number;
  enableManifestDetection: boolean;
  customDetectors: AppDetector[];
}

// Database configuration in manifest
export type DatabaseType = 'postgres' | 'sqlite' | boolean;

// Drop manifest schema (drop.yaml / drop.json)
export interface DropManifest {
  name?: string;
  type?: AppType;
  framework?: string;
  build?: {
    command?: string;
    output?: string;
  };
  start?: {
    command?: string;
  };
  install?: {
    command?: string;
  };
  env?: Record<string, string>;
  port?: number;
  /** Database configuration - set to 'postgres', 'sqlite', or true for auto-provisioning */
  database?: DatabaseType;
  healthCheck?: {
    path?: string;
    interval?: number;
  };
  domains?: string[];
}

// Package.json structure (partial)
export interface PackageJson {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: {
    node?: string;
  };
  main?: string;
  type?: 'module' | 'commonjs';
}

// requirements.txt parsed entry
export interface PythonRequirement {
  name: string;
  version?: string;
  extras?: string[];
}

// go.mod structure (partial)
export interface GoMod {
  module: string;
  goVersion: string;
  require: Array<{ path: string; version: string }>;
}

// Cargo.toml structure (partial)
export interface CargoToml {
  package?: {
    name?: string;
    version?: string;
    edition?: string;
  };
  dependencies?: Record<string, unknown>;
  bin?: Array<{ name: string; path: string }>;
}
