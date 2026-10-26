/**
 * Runtime instances of one app (#298 step 4).
 *
 * A zero-downtime cutover needs the NEW version of an app running beside the
 * OLD one, and both runtimes key everything on one name: PM2 refuses a second
 * `online` process with the same name, and docker removes an existing
 * `drop-<name>` container before creating one. So each app gets two slots:
 *
 *   slot `a` = the bare app name  (every existing process/container, unchanged)
 *   slot `b` = `<app>.b`
 *
 * `.` is the separator because APP_NAME_RE (api/middleware/validate.ts)
 * rejects it — no real app can ever be named like a slot-b instance — while
 * docker container names and PM2 process names both accept it.
 *
 * WHO RESOLVES. Every name-keyed AppRuntime method accepts an APP name and the
 * adapter maps it to that app's LIVE instance (`LiveInstances.resolve`), so
 * the ~20 platform call sites that stop/restart/inspect/log an app by name need
 * no change.
 *
 * ADDRESSING ONE SLOT. Slot a's runtime name IS the bare app name, so a bare
 * name cannot mean "slot a" — once slot b is live it means slot b. Code that
 * must act on one specific slot (the cutover removing the old instance, boot
 * removing an orphan, teardown) passes `instanceRef(app, slot)`: `<app>.a` or
 * `<app>.b`, which `resolve` maps to exactly that slot's runtime name. Passing
 * `instanceName(app, 'a')` there instead would silently hit the live instance.
 */

export type InstanceSlot = 'a' | 'b';

export const INSTANCE_SLOT_SEPARATOR = '.';

/** The runtime name of `appName`'s instance in `slot`. */
export function instanceName(appName: string, slot: InstanceSlot): string {
  return slot === 'a' ? appName : `${appName}${INSTANCE_SLOT_SEPARATOR}${slot}`;
}

/**
 * An explicit reference to ONE slot, for the name-keyed runtime methods:
 * `<app>.a` or `<app>.b`, never resolved through the live map.
 */
export function instanceRef(appName: string, slot: InstanceSlot): string {
  return `${appName}${INSTANCE_SLOT_SEPARATOR}${slot}`;
}

/** The app an instance name belongs to (a bare app name is its own slot `a`). */
export function appNameOfInstance(instance: string): string {
  const i = instance.indexOf(INSTANCE_SLOT_SEPARATOR);
  return i === -1 ? instance : instance.slice(0, i);
}

/** Whether `name` is an explicit instance name rather than an app name. */
export function isInstanceName(name: string): boolean {
  return name.includes(INSTANCE_SLOT_SEPARATOR);
}

/** Per-adapter record of which slot is live for each app. Default: `a`. */
export class LiveInstances {
  private readonly live = new Map<string, InstanceSlot>();

  set(appName: string, slot: InstanceSlot): void {
    if (slot === 'a') this.live.delete(appName);
    else this.live.set(appName, slot);
  }

  slotOf(appName: string): InstanceSlot {
    return this.live.get(appName) ?? 'a';
  }

  /**
   * To a runtime name: an app name → its LIVE instance; an explicit reference
   * (`instanceRef`) → exactly that slot; a slot-b runtime name → itself.
   */
  resolve(name: string): string {
    if (!isInstanceName(name)) return instanceName(name, this.slotOf(name));
    const app = appNameOfInstance(name);
    const slot = name.slice(app.length + INSTANCE_SLOT_SEPARATOR.length);
    return slot === 'a' ? app : name;
  }
}
