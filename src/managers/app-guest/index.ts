/**
 * Public surface of the guest module (DROP-155). See `app-guest-manager.ts`'s
 * own doc for the design; this file is only the barrel other modules import
 * through (`from '../../managers/app-guest'`), matching the directory-import
 * shape `src/api/app-access/session-token.ts` already depends on for
 * `getAppGuestById`.
 */

export {
  AppGuestManager,
  getAppGuestManager,
  resetAppGuests,
  getAppGuestById,
  emailHeldByAnyGuest,
  createAppGuest,
  setAppGuestDisabled,
  reapGuest,
  deleteAppGuest,
  inviteBoundToApp,
  normalizeEmail,
  GuestStoreCorruptError,
  InviteStoreCorruptError,
  InviteCapacityError,
  INVITE_TTL_HOURS,
  INVITE_TTL_MS,
  MAX_LIVE_INVITE_TOKENS,
  MAX_LIVE_INVITE_TOKENS_PER_CREATOR,
} from './app-guest-manager';
export type { AppGuestManagerConfig, ReapGuestDeps } from './app-guest-manager';

export type { GuestRecord, InviteTokenRecord, InviteRedemption, MintedInvite } from './types';
export { GUEST_ID_PREFIX } from './types';
