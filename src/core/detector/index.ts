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
export { staticDetector } from './detectors/static';
export { dockerDetector } from './detectors/docker';

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
