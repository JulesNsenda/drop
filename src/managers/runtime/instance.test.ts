/**
 * Runtime instance naming (#298 step 4). The separator must be one no real app
 * name can contain, or an app could be mistaken for another app's slot b.
 */

import { instanceName, instanceRef, appNameOfInstance, isInstanceName, LiveInstances } from './instance';
import { isValidAppName } from '../../api/middleware/validate';

describe('runtime instances', () => {
  it('slot a is the bare app name; slot b is <app>.b', () => {
    expect(instanceName('web', 'a')).toBe('web');
    expect(instanceName('web', 'b')).toBe('web.b');
    expect(appNameOfInstance('web.b')).toBe('web');
    expect(appNameOfInstance('web')).toBe('web');
  });

  it('no valid app name can look like an instance name', () => {
    expect(isValidAppName('web.b')).toBe(false);
    expect(isInstanceName('web')).toBe(false);
    expect(isInstanceName('my-app_2')).toBe(false);
  });

  it('resolves an app name to its live instance, and passes an instance name through', () => {
    const live = new LiveInstances();
    expect(live.resolve('web')).toBe('web');

    live.set('web', 'b');
    expect(live.resolve('web')).toBe('web.b');
    expect(live.slotOf('web')).toBe('b');
    // The cutover addresses the OTHER instance explicitly.
    expect(live.resolve('web.b')).toBe('web.b');
    // Other apps are untouched.
    expect(live.resolve('api')).toBe('api');

    live.set('web', 'a');
    expect(live.resolve('web')).toBe('web');
  });

  it('an explicit reference hits exactly one slot, whichever is live', () => {
    const live = new LiveInstances();
    live.set('web', 'b');
    // The trap: slot a's runtime name IS the bare app name, which now means b.
    expect(live.resolve(instanceName('web', 'a'))).toBe('web.b');
    expect(live.resolve(instanceRef('web', 'a'))).toBe('web');
    expect(live.resolve(instanceRef('web', 'b'))).toBe('web.b');
    expect(appNameOfInstance(instanceRef('web', 'a'))).toBe('web');
  });
});
