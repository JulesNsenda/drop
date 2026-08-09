/**
 * The drop.yaml samples we publish must actually validate.
 *
 * This exists because they did not. The landing page shipped a sample using
 * `runtime:` and `persist:` — neither is in ALLOWED_TOP_KEYS, and the parser
 * rejects unknown top-level keys outright, so copying the marketing page's own
 * example produced a hard validation failure. The README had the same class of
 * bug, nesting `build:`/`start:` under a `command:` key when both must be
 * plain strings.
 *
 * Each sample below is a copy of one we publish. If you change a sample on a
 * public surface, change it here too — a rendering test proves the string
 * appears on the page, not that a reader can use it.
 *
 * DROP-139 moved the marketing site and docs to their own repository, so four
 * of these sources are no longer in this tree and no build here can fail when
 * one of them drifts. The copies below are therefore the only mechanism left:
 * keep them, and treat a change in drop-site as requiring a change here.
 *
 * Sources:
 *   - drop-site: src/components/landing/DocsContent.tsx  (dropkit.sh/docs)
 *   - drop-site: src/components/landing/LandingSections.tsx  (dropkit.sh/)
 *   - drop-site: public/llms.txt  (dropkit.sh/llms.txt — read by agents)
 *   - README.md
 *   - docs/AGENT-DEPLOY.md
 */

import * as os from 'os';
import * as yaml from 'yaml';
import { validateDropYamlConfig } from './drop-yaml-parser';

/** Samples exactly as a reader would copy them off each public surface. */
const PUBLISHED_SAMPLES: Record<string, string> = {
  'docs: main drop.yaml example': `
name: my-app
domains:
  - app.example.com
database: postgres
redis: true
env:
  NODE_ENV: production
build_env:
  VITE_API_BASE: /api
secrets:
  JWT_SECRET: generate
  STRIPE_KEY:
    required: true
    description: Live secret key from the Stripe dashboard
depends_on:
  - name: api
    env: API_URL
port: 4001
build: npm run build
start: node dist/server.js
healthCheck: /healthz
maxBodySize: 100MB
timeout: 30
`,

  'docs: monorepo group/services example': `
group: ezsign
services:
  frontend:
    path: frontend
    build: npm run build
    route:
      path: /
  backend:
    path: backend
    database: postgres
    route:
      path: /api
      strip: false
`,

  'docs: mcp server declaration': `
mcp:
  path: /mcp
  auth: drop
`,

  'AGENT-DEPLOY: mcp server declaration': `
mcp:
  path: /mcp
  auth: drop
`,

  'landing: escape-hatch drop.yaml': `
name: myapp
type: nodejs
domains:
  - app.example.com
database: postgres
env:
  NODE_ENV: production
secrets:
  JWT_SECRET: generate
`,

  // llms.txt is fetched and acted on by agents rather than read by a person,
  // so an invalid sample here becomes a failed deploy attempt, not a puzzled
  // reader who tries something else.
  'llms.txt: quickstart drop.yaml': `
name: my-app
type: nodejs
domains:
  - app.example.com
port: 4001
build: npm run build
start: node dist/server.js
database: postgres
env:
  NODE_ENV: production
secrets:
  JWT_SECRET: generate
healthCheck: /healthz
`,

  'README: configuration example': `
name: my-app
type: nodejs
domains:
  - app.example.com
database: postgres
redis: true

build: npm run build
start: node dist/server.js

env:
  NODE_ENV: production

secrets:
  JWT_SECRET: generate
`,
};

describe('published drop.yaml samples', () => {
  const appPath = os.tmpdir();

  it.each(Object.entries(PUBLISHED_SAMPLES))('%s validates', (_label, sample) => {
    const parsed = yaml.parse(sample) as unknown;
    const result = validateDropYamlConfig(parsed, appPath);
    // Surface the parser's own message rather than a bare `false`.
    expect(result.error ?? null).toBeNull();
    expect(result.valid).toBe(true);
  });

  // Guard the specific shapes that used to be published and are invalid, so a
  // future edit cannot quietly reintroduce them.
  it('rejects the `runtime:` key the landing page used to publish', () => {
    const result = validateDropYamlConfig(yaml.parse('name: myapp\nruntime: node\n'), appPath);
    expect(result.valid).toBe(false);
  });

  it('rejects the `persist:` key the landing page used to publish', () => {
    const result = validateDropYamlConfig(
      yaml.parse('name: myapp\npersist:\n  - ./uploads\n'),
      appPath
    );
    expect(result.valid).toBe(false);
  });

  it('rejects the nested `build: command:` form the README used to publish', () => {
    const result = validateDropYamlConfig(
      yaml.parse('name: my-app\nbuild:\n  command: npm run build\n'),
      appPath
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/build must be a string/);
  });
});
