import { tryReserve, release, isReserved, ownerOf, reservationPrincipal, resetDeployReservations } from './deploy-reservations';

describe('deploy reservations', () => {
  afterEach(() => resetDeployReservations());

  it('grants one holder per name, whoever asks again', () => {
    expect(tryReserve('app', 'alice')).toBe(true);
    expect(tryReserve('app', 'alice')).toBe(false);
    expect(tryReserve('app', 'bob')).toBe(false);
    expect(ownerOf('app')).toBe('alice');
  });

  it('treats names case-insensitively', () => {
    tryReserve('Blog', 'alice');
    expect(isReserved('blog')).toBe(true);
    expect(tryReserve('BLOG', 'bob')).toBe(false);
  });

  it("releases only the holder's own claim", () => {
    tryReserve('app', 'alice');
    release('app', 'bob');
    expect(isReserved('app')).toBe(true);
    release('app', 'alice');
    expect(isReserved('app')).toBe(false);
    expect(tryReserve('app', 'bob')).toBe(true);
  });

  it('keys a principal on the account, else the credential, else a shared sentinel', () => {
    expect(reservationPrincipal('u1', 'key:1')).toBe('u1');
    expect(reservationPrincipal(undefined, 'key:1')).toBe('key:1');
    expect(reservationPrincipal()).toBe('__single_user__');
  });
});

