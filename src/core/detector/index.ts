/**
 * Detector Module
 *
 * Exports the DetectorService and related types.
 */

export {
  DetectorService,
  createDetectorService,
  getDetector,
  resetDetector,
} from './detector';

// Re-export detectors for customization
export { manifestDetector, validateManifest } from './detectors/manifest';
export { nodejsDetector } from './detectors/nodejs';
export { pythonDetector } from './detectors/python';
export { goDetector } from './detectors/go';
export { staticDetector } from './detectors/static';
export { dockerDetector } from './detectors/docker';

// Export drop.yaml parser
export {
  parseDropYaml,
  findDropYaml,
  getCustomDomains,
  getTlsConfig,
  mergeWithDefaults,
  validateDropYamlConfig,
} from './drop-yaml-parser';

export type {
  AppType,
  DetectionResult,
  DetectorConfig,
  AppDetector,
  SuggestedConfig,
  DropManifest,
  PackageJson,
  PythonRequirement,
  GoMod,
  CargoToml,
} from './detector.types';

export type {
  DropYamlConfig,
  DropYamlParseResult,
  AppTlsConfig,
  AppEnvConfig,
  AppDependency,
  AppMcpConfig,
} from './drop-yaml-parser';

export { detectMcp, readMcpInputs, DEFAULT_MCP_PATH } from './mcp-detect';
export type { McpEndpoint, McpDetectInput } from './mcp-detect';
