/**
 * Which git or upload deploy is CREATING or uploading into an app name right now.
 *
 * Git deploy's create path and upload deploy each used to guard only against
 * THEMSELVES and peek at the other, so a git deploy and an upload to one new
 * name could both pass their checks and land into the same folder. One map,
 * claimed with a synchronous check-and-insert (no await between them),
 * serializes the two WITHIN THIS SERVER PROCESS. It does not see the CLI
 * process, a folder dropped into the webapps directory, a git redeploy (that
 * stays with the platform's own `appsInProgress` dedup), or the children a
 * monorepo expansion writes: none of those reserve.
 *
 * Distinct from `activeClones` / `activeUploads`, which still mean only "files
 * are being written into this tree" and are what the watcher-facing guards
 * read. A reservation also spans the quota, auth and disk awaits before the
 * write, which must not hold the watcher off the name.
 *
 * Keys are lower-cased: hostnames are case-insensitive, so `Blog` and `blog`
 * are one name here.
 */

const holders = new Map<string, string>();

const keyOf = (appName: string): string => appName.toLowerCase();

/** The identity a reservation is held under: the account, else the credential, else a shared sentinel. */
export function reservationPrincipal(userId?: string, principalId?: string): string {
  return userId ?? principalId ?? '__single_user__';
}

/** Claim `appName` for `principal`. False if anyone (including them) already holds it. */
export function tryReserve(appName: string, principal: string): boolean {
  const key = keyOf(appName);
  if (holders.has(key)) return false;
  holders.set(key, principal);
  return true;
}

/** Release `appName`, but only if `principal` is the holder: never another call's claim. */
export function release(appName: string, principal: string): void {
  const key = keyOf(appName);
  if (holders.get(key) === principal) holders.delete(key);
}

export function isReserved(appName: string): boolean {
  return holders.has(keyOf(appName));
}

export function ownerOf(appName: string): string | undefined {
  return holders.get(keyOf(appName));
}

/**
 * Drop every reservation. `platform.stop()` calls this so a stopped platform
 * cannot leave a name held by a deploy that will never finish; tests call it in
 * teardown.
 */
export function resetDeployReservations(): void {
  holders.clear();
}
