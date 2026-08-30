/**
 * `install.sh`'s pre-pull list must name the same images the runtime pulls.
 *
 * Two copies of the same fact, in two languages, that cannot import from each
 * other: `IMAGE_DIGESTS` here and a hard-coded `docker pull` loop in a
 * standalone bash installer. Nothing else makes them agree.
 *
 * Drift is SILENT, which is why this test exists rather than a comment. If the
 * installer pre-pulls `node:20-slim` while the runtime pulls
 * `node:20-slim@sha256:…`, both succeed: the warm image is simply the wrong
 * one, and every first deploy on a fresh box pulls again over the network. That
 * shows up as "the first deploy is slow", on a box nobody is watching, weeks
 * after the digest was refreshed.
 *
 * It also fails the other way, which matters more: an installer still pinning
 * an OLD digest pre-pulls an image with known CVEs and leaves it on disk.
 */

import * as fs from 'fs';
import * as path from 'path';
import { pinnedImages } from './container-config';

describe('install.sh pre-pull parity', () => {
  const installScript = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'install.sh'),
    'utf-8'
  );

  /**
   * The images `ensure_docker` warms, read out of the script itself. Anchored on
   * the `docker pull "$img"` loop rather than on any `sha256:` in the file, so
   * an unrelated digest elsewhere in the installer cannot satisfy this.
   */
  const prePulledImages = (): string[] => {
    const loop = installScript.match(
      /Pre-pulling DROP base images[\s\S]*?docker pull "\$img"/
    );
    if (!loop) return [];
    return [...loop[0].matchAll(/"([a-z0-9.\-/]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64})"/g)].map(
      m => m[1]
    );
  };

  it('warms exactly the references the runtime will pull', () => {
    // Set comparison, not array: the installer's order is a shell loop and
    // carries no meaning, so pinning it would make this test fail on a
    // reordering that changes nothing.
    expect(new Set(prePulledImages())).toEqual(new Set(pinnedImages()));
  });

  it('pins every pre-pulled image by digest, never by bare tag', () => {
    // A bare tag in the installer is the exact silent-drift case above: the
    // pull succeeds, warms a different image, and nothing reports it.
    const pulled = prePulledImages();
    expect(pulled.length).toBeGreaterThan(0);
    for (const ref of pulled) {
      expect(ref).toMatch(/@sha256:[0-9a-f]{64}$/);
    }
  });
});
