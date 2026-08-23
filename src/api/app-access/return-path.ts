/**
 * Validates the "return to" path for the DROP-152 browser access gate.
 *
 * The gate's redirect-back flow rebuilds a `Location` header from
 * `X-Forwarded-Uri` — the URI of the request Caddy's `forward_auth` is
 * gating, which is entirely client-controlled. If that value is echoed into
 * a `Location` header unchecked, a visitor can be sent off the platform's
 * own origin right after "successfully" signing in: the textbook
 * open-redirect phishing setup, made worse here because the victim has just
 * authenticated and the link looks like it belongs to the app they were
 * trying to reach. This module is the only thing standing between that
 * header and the response.
 *
 * Percent-encoding, decided deliberately: the value this function returns is
 * always exactly the trimmed RAW input, or `null` — never a decoded or
 * otherwise reconstructed string. Returning a decoded reconstruction is the
 * classic bypass, because a raw value can look innocuous while decoding to
 * something dangerous (`/%2f%2fevil.tld` has a single leading slash, but
 * decodes to `//evil.tld`, which is protocol-relative). So validation runs
 * TWICE: once against the raw string, matching what a literal-minded
 * consumer (an HTTP header, a naive string check) sees, and once against a
 * throwaway decoded copy, to catch a hazard smuggled in via percent-encoding
 * before it can reach anything that *does* decode. The decoded copy is used
 * only to say no; what gets returned is always the untouched raw string.
 */

/** Hard ceiling on an already-generous path; anything past it is not a normal navigation target. */
const MAX_LENGTH = 2048;

/** CR, LF, NUL and other C0/DEL control bytes — response/header-splitting material either raw or once decoded. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

/**
 * A scheme prefix (`javascript:`, `https:`, `data:`, ...). Redundant with the
 * leading-slash check below for anything reaching this point, but kept as an
 * explicit, independent check — belt-and-suspenders against a future change
 * to the leading-slash logic silently reopening scheme injection.
 */
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** A `..` segment anywhere in the path — `/../`, a leading `../`, or a trailing `/..`. */
const TRAVERSAL_RE = /(^|\/)\.\.(\/|$)/;

/**
 * Structural red flags that make a string unsafe to redirect to, checked
 * identically whether the string is the raw input or a decoded copy of it.
 */
function hasStructuralHazard(value: string): boolean {
  if (CONTROL_CHAR_RE.test(value)) return true;
  // Browsers normalise backslash to forward slash inconsistently across
  // contexts, so a `\` anywhere can turn an apparently same-origin path into
  // a protocol-relative one downstream even where it isn't one here.
  if (value.includes('\\')) return true;
  if (SCHEME_RE.test(value)) return true;
  if (TRAVERSAL_RE.test(value)) return true;
  return false;
}

/**
 * Whether `value[1]` starts an authority component — i.e. the string is
 * protocol-relative (`//host/...`) rather than an absolute-path reference.
 * Only meaningful when `value[0] === '/'`, which every caller here has
 * already established.
 */
function startsWithAuthority(value: string): boolean {
  return value[1] === '/' || value[1] === '\\';
}

/**
 * Validate a browser-supplied return path.
 *
 * Returns the path unchanged if it is safe to place in a `Location` header
 * pointing back at this origin, or `null` if it must be refused — the
 * caller substitutes `/` in that case.
 */
export function validateReturnPath(raw: string | undefined): string | null {
  if (raw === undefined) return null;

  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_LENGTH) return null;

  // Must be an absolute-path reference: exactly one leading '/'. A second
  // '/' or '\' immediately after the first turns this into a
  // protocol-relative reference, which browsers resolve against a NEW
  // origin taken from the value itself, not the current one. Anything that
  // doesn't even start with '/' (a bare host, or a scheme like
  // `javascript:`) is rejected here too.
  if (trimmed[0] !== '/') return null;
  if (startsWithAuthority(trimmed)) return null;

  if (hasStructuralHazard(trimmed)) return null;

  // Decode a throwaway copy to catch a scheme/authority/traversal/control
  // byte smuggled in via percent-encoding (e.g. `/%2f%2fevil.tld` decodes to
  // `//evil.tld`). This copy is used ONLY for validation — the function
  // still returns `trimmed` below, never `decoded`, so nothing a downstream
  // consumer might later decode can differ from what was actually checked.
  let decoded: string;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    // Malformed percent-encoding: refuse rather than guess at intent.
    return null;
  }
  if (decoded !== trimmed) {
    if (startsWithAuthority(decoded)) return null;
    if (hasStructuralHazard(decoded)) return null;
  }

  return trimmed;
}
