export {
  ObjectStorageProvisioner,
  ObjectStorageUnavailableError,
  ObjectStorageIncarnationError,
  ObjectStorageNotConfiguredError,
  ObjectStorageDetachIncompleteError,
  getObjectStorageProvisioner,
  resetObjectStorageProvisioner,
  configureObjectStorage,
  AWS_REGION_RE,
} from './provisioner';
export type {
  AppIncarnation,
  StorageAvailability,
  StorageEnvironment,
  StorageUnavailableReason,
} from './provisioner';
export { APP_OWNED_AWS_NAMES, blankInheritedAdminEnv } from './env-guard';
export {
  StorageCredentialStore,
  getStorageCredentialStore,
  resetStorageCredentialStore,
} from './credential-store';
export type { StorageAdminCredential } from './credential-store';
export { AllocationStore, AllocationStoreCorruptError } from './allocation-store';
export { AwsObjectStorageProvider, createAwsClients, USER_POLICY_NAME } from './aws-provider';
export { BUCKET_PREFIX_RE, bucketNameFor, iamUserNameFor, bucketOnlyPolicy, newResourceSuffix } from './naming';
export type {
  AppStorageAllocation,
  AppStorageCredentials,
  ObjectStorageProvider,
  RetiredReason,
  StorageDeprovisionResult,
} from './types';
