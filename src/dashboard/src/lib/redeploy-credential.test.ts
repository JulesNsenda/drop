import {
  CREDENTIAL_CLEAR,
  CREDENTIAL_UNCHANGED,
  credentialChoiceToTokenId,
  redeployBody,
} from './redeploy-credential';

/**
 * The route's own validator, copied verbatim from
 * `src/api/routes/git-deploy.ts`. Used to prove the sentinel can never be
 * mistaken for a token id — if the route ever widens its pattern, the
 * assertion below is what notices.
 */
const ROUTE_TOKEN_ID_RE = /^git_[A-Za-z0-9]+$/;

describe('redeploy credential choice (DROP-142)', () => {
  describe('credentialChoiceToTokenId', () => {
    it('maps the neutral choice to undefined — NOT null, so the key is omitted', () => {
      const result = credentialChoiceToTokenId(CREDENTIAL_UNCHANGED);
      // toBeUndefined() and toBeNull() are the whole point of this test: an
      // ordinary redeploy of a private-repo app must not clear its credential.
      expect(result).toBeUndefined();
      expect(result).not.toBeNull();
    });

    it('maps the explicit clear choice to null', () => {
      expect(credentialChoiceToTokenId(CREDENTIAL_CLEAR)).toBeNull();
    });

    it('passes a token id through unchanged', () => {
      expect(credentialChoiceToTokenId('git_abc123')).toBe('git_abc123');
    });
  });

  describe('redeployBody', () => {
    it('returns undefined for undefined — the request carries no body', () => {
      expect(redeployBody(undefined)).toBeUndefined();
    });

    it('puts an explicit null on the wire rather than omitting it', () => {
      const body = redeployBody(null);
      expect(body).toEqual({ tokenId: null });
      // Serialized, because that is what the server parses: an omitted key and
      // a null value are different documents, and the route branches on
      // hasOwnProperty.
      expect(JSON.stringify(body)).toBe('{"tokenId":null}');
    });

    it('puts a token id on the wire', () => {
      expect(redeployBody('git_abc123')).toEqual({ tokenId: 'git_abc123' });
    });
  });

  describe('the sentinels cannot collide with a real token id', () => {
    it('the clear sentinel is rejected by the route pattern', () => {
      expect(ROUTE_TOKEN_ID_RE.test(CREDENTIAL_CLEAR)).toBe(false);
    });

    it('the neutral sentinel is rejected by the route pattern', () => {
      expect(ROUTE_TOKEN_ID_RE.test(CREDENTIAL_UNCHANGED)).toBe(false);
    });

    it('a real id shaped like the store issues them is accepted', () => {
      expect(ROUTE_TOKEN_ID_RE.test('git_abc123')).toBe(true);
    });
  });

  it('the full choice → wire path never turns "leave as is" into a clear', () => {
    // The end-to-end property, stated once: whatever the neutral choice is
    // called, it must reach fetch() as "no body".
    expect(redeployBody(credentialChoiceToTokenId(CREDENTIAL_UNCHANGED))).toBeUndefined();
    expect(redeployBody(credentialChoiceToTokenId(CREDENTIAL_CLEAR))).toEqual({ tokenId: null });
    expect(redeployBody(credentialChoiceToTokenId('git_zz9'))).toEqual({ tokenId: 'git_zz9' });
  });
});
