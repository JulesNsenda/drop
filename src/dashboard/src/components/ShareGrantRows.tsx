import { X } from 'lucide-react';
import type { OwnGrant, OwnGuest } from '../lib/app-share';

/**
 * The two row shapes of `/apps/:name/share`, shared by `ShareCard` (owner)
 * and `AccessTab` (admin).
 *
 * Only the ROW is shared. The list around it is not: each host labels its own
 * ("Who you've shared it with" vs "Shared by you"), and `AccessTab` wraps
 * both in a three-state read where an unreadable list must never render as an
 * empty one — an affirmative "nobody has access" on the one screen whose
 * subject is who may open the app.
 */

/** A DROP account the caller granted. Revoking is a policy write, hence the confirm in the host. */
export function AccountGrantRow({
  grant,
  disabled,
  onRevoke,
}: {
  grant: OwnGrant;
  disabled: boolean;
  onRevoke: (userId: string, label: string) => void;
}) {
  const label = grant.username ?? grant.userId;
  return (
    <div className="flex items-center justify-between gap-2 py-1 text-sm">
      <span>{label}</span>
      <button
        onClick={() => onRevoke(grant.userId, label)}
        className="transition-opacity hover:opacity-70 text-faint"
        disabled={disabled}
        aria-label={`Revoke access for ${label}`}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

/**
 * A guest the caller invited by email.
 *
 * Resend is the SAME call as the first invite: the address resolves to the
 * same guest record and a fresh single-use link is minted. It is the only
 * recovery path for a lost or expired invitation, because the secret is never
 * stored. Not offered for a disabled guest — that record is an
 * administrator's decision — and not offered when the address is empty, which
 * is a stale policy entry whose guest record the boot sweep has not reaped.
 */
export function GuestGrantRow({
  guest,
  disabled,
  onResend,
  onRevoke,
}: {
  guest: OwnGuest;
  disabled: boolean;
  onResend: (email: string) => void;
  onRevoke: (guestId: string, label: string) => void;
}) {
  const label = guest.email || guest.guestId;
  return (
    <div className="flex items-center justify-between gap-2 py-1 text-sm">
      <span className={guest.disabled ? 'opacity-50 line-through' : undefined}>
        {label}
        {guest.disabled && (
          <span className="ml-2 text-xs opacity-70 no-underline">disabled by an administrator</span>
        )}
      </span>
      <span className="flex items-center gap-2">
        {!guest.disabled && (
          <button
            onClick={() => onResend(guest.email)}
            className="text-xs transition-opacity hover:opacity-70 text-faint"
            disabled={disabled || !guest.email}
            aria-label={`Resend invitation to ${label}`}
          >
            Resend
          </button>
        )}
        <button
          onClick={() => onRevoke(guest.guestId, label)}
          className="transition-opacity hover:opacity-70 text-faint"
          disabled={disabled}
          aria-label={`Revoke access for ${label}`}
        >
          <X className="h-4 w-4" />
        </button>
      </span>
    </div>
  );
}
