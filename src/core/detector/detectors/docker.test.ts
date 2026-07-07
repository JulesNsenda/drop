/**
 * Docker Detector Tests
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { dockerDetector } from './docker';

describe('dockerDetector', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-docker-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('returns null when there is no Dockerfile or compose file', async () => {
    await fs.writeFile(path.join(tmpDir, 'readme.md'), '# no docker here');

    const result = await dockerDetector.detect(tmpDir);

    expect(result).toBeNull();
  });

  it('detects a Dockerfile and parses its base image and exposed port', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'Dockerfile'),
      'FROM node:18\nEXPOSE 3000\nCMD ["node", "index.js"]'
    );

    const result = await dockerDetector.detect(tmpDir);

    expect(result?.type).toBe('docker');
    expect(result?.framework).toBe('docker');
    expect(result?.confidence).toBe(0.85);
    expect(result?.detectedBy).toBe('Dockerfile');
    expect(result?.metadata.baseImage).toBe('node:18');
    expect(result?.metadata.exposedPort).toBe(3000);
    expect(result?.suggestedConfig.port).toBe(3000);
    expect(result?.suggestedConfig.startCommand).toBe('docker run -p 3000:3000 app');
    expect(result?.warnings).toHaveLength(0);
  });

  it('warns when the Dockerfile has no EXPOSE directive', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'Dockerfile'),
      'FROM node:18\nCMD ["node", "index.js"]'
    );

    const result = await dockerDetector.detect(tmpDir);

    expect(result?.metadata.exposedPort).toBeNull();
    expect(result?.warnings).toContainEqual(expect.stringContaining('No EXPOSE directive'));
    expect(result?.suggestedConfig.startCommand).toBe('docker run -P app');
  });

  it('detects a Containerfile as an alternative Dockerfile name', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'Containerfile'),
      'FROM alpine:3.18\nEXPOSE 8080'
    );

    const result = await dockerDetector.detect(tmpDir);

    expect(result?.type).toBe('docker');
    expect(result?.detectedBy).toBe('Containerfile');
    expect(result?.metadata.baseImage).toBe('alpine:3.18');
  });

  it('falls back to docker-compose with lower confidence when there is no Dockerfile', async () => {
    await fs.writeFile(path.join(tmpDir, 'docker-compose.yml'), 'version: "3"');

    const result = await dockerDetector.detect(tmpDir);

    expect(result?.type).toBe('docker');
    expect(result?.framework).toBe('docker-compose');
    expect(result?.confidence).toBe(0.75);
    expect(result?.detectedBy).toBe('docker-compose.yml');
    expect(result?.suggestedConfig.startCommand).toBe(
      'docker-compose -f docker-compose.yml up'
    );
    expect(result?.warnings).toContainEqual(
      expect.stringContaining('Only docker-compose found')
    );
  });

  it('reports framework "docker-compose" when both a Dockerfile and a compose file exist', async () => {
    // Confidence/detectedBy are driven off the Dockerfile branch (unaffected by
    // the compose file), but `framework` is computed independently from
    // `composeFile` alone - so it flips to 'docker-compose' even though a
    // Dockerfile is present too.
    await fs.writeFile(path.join(tmpDir, 'Dockerfile'), 'FROM node:18\nEXPOSE 3000');
    await fs.writeFile(path.join(tmpDir, 'docker-compose.yml'), 'version: "3"');

    const result = await dockerDetector.detect(tmpDir);

    expect(result?.detectedBy).toBe('Dockerfile');
    expect(result?.confidence).toBe(0.85);
    expect(result?.framework).toBe('docker-compose');
  });
});
