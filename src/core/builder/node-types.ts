/**
 * Which app types install a node_modules tree, and which run on node.
 *
 * A leaf module on purpose: it imports no strategy, so the strategies, the
 * toolchain id producer and the container-config test can all read the same
 * lists without an import cycle.
 */

import type { AppType } from '../detector/detector.types';

/** Types the nodejs build strategy builds, and the types that RUN in a node image. */
export const NODE_RUNTIME_TYPES: readonly AppType[] = [
  'nodejs',
  'nextjs',
  'nuxt',
  'sveltekit',
  'remix',
  'astro',
  'express',
  'fastify',
  'hono',
  'nest',
];

/**
 * Types whose build installs and stamps node_modules: every node runtime type,
 * plus static/spa, which are served by nginx but built (source SPAs) in a node
 * image.
 */
export const NODE_MODULES_BUILD_TYPES: readonly AppType[] = [
  ...NODE_RUNTIME_TYPES,
  'static',
  'spa',
];
