/**
 * The three-state git credential contract of `POST /api/v1/git/redeploy/:name`
 * (DROP-142), kept out of the React layer so the root jest suite can pin it.
 *
 * The route distinguishes three cases and collapsing any two of them is a real
 * defect, not a style question:
 *
 * | Wire                  | Meaning                                  |
 * |-----------------------|------------------------------------------|
 * | key absent            | leave the app's stored credential alone  |
 * | `"tokenId": null`     | clear the stored credential              |
 * | `"tokenId": "git_…"`  | attach or replace it                     |
 *
 * The sharp edge is the first row. A `<select>` naturally models "nothing
 * chosen" as the empty string, and the obvious mapping of empty string to
 * `null` would make *every ordinary redeploy* strip the credential from a
 * private-repo app — the exact failure DROP-142 exists to fix, reintroduced on
 * the client where no server test can see it.
 *
 * DOM-free on purpose: root `tsconfig.json` is `lib: ["ES2022"]` with no DOM,
 * which is what lets the root jest suite compile and run the test beside this
 * file. Types ARE checked either way — `build:dashboard` runs the package's
 * own `tsc` and CI runs that — but nothing EXECUTES a component's logic, and
 * root eslint skips `src/dashboard/**` entirely. Same shape and same home as
 * `components/db-format.ts`.
 */

/** Neutral `<select>` value: send no `tokenId` key at all. */
export const CREDENTIAL_UNCHANGED = '';

/**
 * Explicit "clear the stored credential" choice. Deliberately not the empty
 * option — clearing has to be something the operator picks, never the default.
 * Cannot collide with a real id: the route accepts only
 * `/^git_[A-Za-z0-9]+$/`, which this does not match (asserted in the test).
 */
export const CREDENTIAL_CLEAR = '__clear__';

/**
 * Map a `<select>` value to the `tokenId` argument of `gitRedeploy`.
 *
 * `undefined` and `null` are NOT interchangeable here: `undefined` means "omit
 * the key", `null` means "send null".
 */
export function credentialChoiceToTokenId(choice: string): string | null | undefined {
  if (choice === CREDENTIAL_UNCHANGED) return undefined;
  if (choice === CREDENTIAL_CLEAR) return null;
  return choice;
}

/**
 * The JSON body for the redeploy request, or `undefined` when the request must
 * carry no body at all.
 *
 * Separate from the mapping above so the "omit the key" decision is itself
 * testable: it lives one call away from `fetch`, where nothing else can reach
 * it.
 */
export function redeployBody(
  tokenId: string | null | undefined
): { tokenId: string | null } | undefined {
  return tokenId === undefined ? undefined : { tokenId };
}
