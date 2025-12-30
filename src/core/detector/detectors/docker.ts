/**
 * Docker Detector
 *
 * Detects applications that use Docker/containers.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { AppDetector, DetectionResult, SuggestedConfig } from '../detector.types';

const DOCKER_FILES = ['Dockerfile', 'dockerfile', 'Containerfile'];
const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

export const dockerDetector: AppDetector = {
  name: 'docker',
  priority: 60,

  async detect(appPath: string): Promise<DetectionResult | null> {
    const warnings: string[] = [];
    let confidence = 0.85;
    let detectedBy = 'Dockerfile';

    // Check for Dockerfile
    let dockerfilePath: string | null = null;
    for (const file of DOCKER_FILES) {
      const filePath = path.join(appPath, file);
      if (await fileExists(filePath)) {
        dockerfilePath = filePath;
        detectedBy = file;
        break;
      }
    }

    // Check for docker-compose
    let composeFile: string | null = null;
    for (const file of COMPOSE_FILES) {
      const filePath = path.join(appPath, file);
      if (await fileExists(filePath)) {
        composeFile = file;
        break;
      }
    }

    if (!dockerfilePath && !composeFile) {
      return null;
    }

    // Parse Dockerfile for additional info
    let exposedPort: number | null = null;
    let baseImage: string | null = null;

    if (dockerfilePath) {
      const dockerfileInfo = await parseDockerfile(dockerfilePath);
      exposedPort = dockerfileInfo.exposedPort;
      baseImage = dockerfileInfo.baseImage;

      if (!exposedPort) {
        warnings.push('No EXPOSE directive found in Dockerfile');
      }
    }

    // If only compose file, lower confidence
    if (!dockerfilePath && composeFile) {
      confidence = 0.75;
      detectedBy = composeFile;
      warnings.push('Only docker-compose found, no Dockerfile - may need multi-container setup');
    }

    // Generate suggested config
    const suggestedConfig = generateDockerConfig(exposedPort, composeFile);

    return {
      type: 'docker',
      framework: composeFile ? 'docker-compose' : 'docker',
      confidence,
      detectedBy,
      suggestedConfig,
      warnings,
      metadata: {
        hasDockerfile: !!dockerfilePath,
        hasCompose: !!composeFile,
        composeFile,
        baseImage,
        exposedPort,
      },
    };
  },
};

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

interface DockerfileInfo {
  exposedPort: number | null;
  baseImage: string | null;
}

async function parseDockerfile(filePath: string): Promise<DockerfileInfo> {
  const info: DockerfileInfo = {
    exposedPort: null,
    baseImage: null,
  };

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();

      // Parse FROM instruction
      if (trimmed.toUpperCase().startsWith('FROM ')) {
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 2) {
          info.baseImage = parts[1];
        }
      }

      // Parse EXPOSE instruction
      if (trimmed.toUpperCase().startsWith('EXPOSE ')) {
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 2) {
          const port = parseInt(parts[1], 10);
          if (!isNaN(port) && port > 0 && port <= 65535) {
            info.exposedPort = port;
          }
        }
      }
    }
  } catch {
    // Ignore parsing errors
  }

  return info;
}

function generateDockerConfig(
  exposedPort: number | null,
  composeFile: string | null
): SuggestedConfig {
  const config: SuggestedConfig = {};

  // Build command
  config.buildCommand = 'docker build -t app .';

  // Start command
  if (composeFile) {
    config.startCommand = `docker-compose -f ${composeFile} up`;
  } else {
    const portMapping = exposedPort ? `-p ${exposedPort}:${exposedPort}` : '-P';
    config.startCommand = `docker run ${portMapping} app`;
  }

  // Port
  if (exposedPort) {
    config.port = exposedPort;
  }

  return config;
}
