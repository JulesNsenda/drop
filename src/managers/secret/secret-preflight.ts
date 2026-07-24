/**
 * Secret preflight (PRD-051)
 *
 * Pure, side-effect-free logic for the "required secrets" gate. Given an app's
 * declared `secrets:` (from drop.yaml) and the set of env keys already available
 * to it (set secrets + platform-injected vars + drop.yaml `env`), it decides:
 *   - which declared secrets DROP should auto-generate (required + `generate`
 *     + not already provided), and
 *   - which are still missing (required, human-supplied, not provided) — the
 *     ones that force a prompt (interactive) or park the app in `needs-config`.
 *
 * The platform performs the actual side effects (generate → SecretManager.set,
 * park vs. start); this module stays pure so it is trivially unit-testable.
 */

import * as crypto from 'crypto';
import type {
  AppSecretsConfig,
  SecretDecl,
  SecretGenerateStrategy,
} from '@core/detector/drop-yaml-parser';

/** A declared secret in normalized form (shorthands expanded). */
export interface NormalizedSecretDecl {
  /** Env var name. */
  name: string;
  /** The app cannot start without this secret. */
  required: boolean;
  /** Auto-generation strategy, if any (implies `required`). */
  generate?: SecretGenerateStrategy;
  /** Human-facing hint for the prompt / dashboard. */
  description?: string;
}

/** The plan produced from a declaration + the keys already available. */
export interface SecretPreflightPlan {
  /** Required + generatable + not already provided — DROP should generate these. */
  toGenerate: NormalizedSecretDecl[];
  /** Required + human-supplied + not provided — block start until set. */
  missing: NormalizedSecretDecl[];
  /**
   * True when nothing human-supplied is missing, i.e. the app is startable once
   * `toGenerate` has been generated and injected. Generatable secrets never
   * count as missing.
   */
  satisfied: boolean;
}

/**
 * Expand one declaration (boolean / string shorthand / object) into normalized
 * form. `generate` always implies `required`.
 */
export function normalizeSecretDecl(name: string, decl: SecretDecl): NormalizedSecretDecl {
  if (decl === true) {
    return { name, required: true };
  }
  if (decl === false) {
    return { name, required: false };
  }
  if (decl === 'required') {
    return { name, required: true };
  }
  if (decl === 'generate') {
    return { name, required: true, generate: 'random' };
  }
  // object form
  const generate = decl.generate;
  return {
    name,
    // `generate` implies required even if `required` was omitted/false.
    required: decl.required === true || generate !== undefined,
    ...(generate ? { generate } : {}),
    ...(decl.description !== undefined ? { description: decl.description } : {}),
  };
}

/** Normalize an entire `secrets:` map, preserving declaration order. */
export function normalizeSecrets(declared?: AppSecretsConfig): NormalizedSecretDecl[] {
  if (!declared) {
    return [];
  }
  return Object.entries(declared).map(([name, decl]) => normalizeSecretDecl(name, decl));
}

/**
 * Generate a strong random secret value. `random` → 32 bytes of CSPRNG output
 * encoded as URL-safe base64 (no padding) — safe to place in a URL, a header,
 * or a shell env without escaping.
 */
export function generateSecretValue(_strategy: SecretGenerateStrategy = 'random'): string {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Compute the preflight plan. `providedKeys` is every env key already available
 * to the app BEFORE generation (set secrets ∪ platform-injected ∪ drop.yaml
 * `env`). A declared-required secret is:
 *   - satisfied if its key is provided,
 *   - else queued for generation if it declares `generate`,
 *   - else reported missing (human must supply it).
 * Non-required declarations are advisory only and never block.
 */
export function planSecretPreflight(
  declared: AppSecretsConfig | undefined,
  providedKeys: Iterable<string>,
): SecretPreflightPlan {
  const provided = providedKeys instanceof Set ? providedKeys : new Set(providedKeys);
  const toGenerate: NormalizedSecretDecl[] = [];
  const missing: NormalizedSecretDecl[] = [];

  for (const decl of normalizeSecrets(declared)) {
    if (!decl.required || provided.has(decl.name)) {
      continue;
    }
    if (decl.generate) {
      toGenerate.push(decl);
    } else {
      missing.push(decl);
    }
  }

  return { toGenerate, missing, satisfied: missing.length === 0 };
}
