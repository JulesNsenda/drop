export {
  ObjectStorageProvisioner,
  ObjectStorageUnavailableError,
  getObjectStorageProvisioner,
  resetObjectStorageProvisioner,
  configureObjectStorage,
  AWS_REGION_RE,
} from './provisioner';
export type { StorageAvailability, StorageUnavailableReason } from './provisioner';
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
  StorageDeprovisionResult,
} from './types';
