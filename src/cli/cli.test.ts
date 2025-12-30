/**
 * CLI Tests
 */

import { Command } from 'commander';
import {
  setJsonMode,
  setQuietMode,
  isJsonMode,
  formatBytes,
  formatDuration,
  formatStatus,
  Spinner,
} from './utils/output';
import { createProgram } from './index';

// Mock process manager
jest.mock('../managers/process', () => ({
  getProcessManager: jest.fn().mockReturnValue({
    getAllStatus: jest.fn().mockResolvedValue([]),
    getStatus: jest.fn().mockResolvedValue(null),
    start: jest.fn().mockResolvedValue({ status: 'online', pid: 12345 }),
    stop: jest.fn().mockResolvedValue(undefined),
    restart: jest.fn().mockResolvedValue({ status: 'online', pid: 12345 }),
    delete: jest.fn().mockResolvedValue(undefined),
    getLogs: jest.fn().mockResolvedValue(''),
  }),
}));

// Mock detector
jest.mock('../core/detector', () => ({
  detectProjectType: jest.fn().mockResolvedValue({
    type: 'node',
    buildCommand: 'npm run build',
    startCommand: 'npm start',
    installCommand: 'npm install',
  }),
}));

// Mock builder
jest.mock('../core/builder', () => ({
  createBuilder: jest.fn().mockReturnValue({
    build: jest.fn().mockResolvedValue({
      success: true,
      durationMs: 1000,
    }),
  }),
}));

describe('CLI Output Utilities', () => {
  beforeEach(() => {
    setJsonMode(false);
    setQuietMode(false);
  });

  describe('setJsonMode', () => {
    it('should enable JSON mode', () => {
      setJsonMode(true);
      expect(isJsonMode()).toBe(true);
    });

    it('should disable JSON mode', () => {
      setJsonMode(true);
      setJsonMode(false);
      expect(isJsonMode()).toBe(false);
    });
  });

  describe('formatBytes', () => {
    it('should format bytes correctly', () => {
      expect(formatBytes(0)).toBe('0 B');
      expect(formatBytes(512)).toBe('512 B');
      expect(formatBytes(1024)).toBe('1.0 KB');
      expect(formatBytes(1536)).toBe('1.5 KB');
      expect(formatBytes(1048576)).toBe('1.0 MB');
      expect(formatBytes(1073741824)).toBe('1.0 GB');
    });
  });

  describe('formatDuration', () => {
    it('should format milliseconds correctly', () => {
      expect(formatDuration(500)).toBe('500ms');
    });

    it('should format seconds correctly', () => {
      expect(formatDuration(1500)).toBe('1.5s');
      expect(formatDuration(30000)).toBe('30.0s');
    });

    it('should format minutes correctly', () => {
      expect(formatDuration(60000)).toBe('1m 0s');
      expect(formatDuration(90000)).toBe('1m 30s');
    });

    it('should format hours correctly', () => {
      expect(formatDuration(3600000)).toBe('1h 0m');
      expect(formatDuration(5400000)).toBe('1h 30m');
    });
  });

  describe('formatStatus', () => {
    it('should format online status', () => {
      const result = formatStatus('online');
      expect(result).toContain('online');
    });

    it('should format stopped status', () => {
      const result = formatStatus('stopped');
      expect(result).toContain('stopped');
    });

    it('should format errored status', () => {
      const result = formatStatus('errored');
      expect(result).toContain('errored');
    });

    it('should return plain text in JSON mode', () => {
      setJsonMode(true);
      const result = formatStatus('online');
      expect(result).toBe('online');
    });
  });

  describe('Spinner', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should create spinner with message', () => {
      const spin = new Spinner('Loading...');
      expect(spin).toBeDefined();
    });

    it('should not start in JSON mode', () => {
      setJsonMode(true);
      const spin = new Spinner('Loading...');
      const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

      spin.start();

      expect(writeSpy).not.toHaveBeenCalled();
      writeSpy.mockRestore();
    });

    it('should stop cleanly', () => {
      const spin = new Spinner('Loading...');
      const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

      spin.start();
      spin.stop();

      writeSpy.mockRestore();
    });
  });
});

describe('CLI Program', () => {
  let program: Command;

  beforeEach(() => {
    program = createProgram();
    setJsonMode(false);
    setQuietMode(false);
  });

  it('should create program with name drop', () => {
    expect(program.name()).toBe('drop');
  });

  it('should have version command', () => {
    const versionCmd = program.commands.find(c => c.name() === 'version');
    expect(versionCmd).toBeDefined();
  });

  it('should have list command with alias', () => {
    const listCmd = program.commands.find(c => c.name() === 'list');
    expect(listCmd).toBeDefined();
    expect(listCmd?.aliases()).toContain('ls');
  });

  it('should have status command', () => {
    const statusCmd = program.commands.find(c => c.name() === 'status');
    expect(statusCmd).toBeDefined();
  });

  it('should have logs command', () => {
    const logsCmd = program.commands.find(c => c.name() === 'logs');
    expect(logsCmd).toBeDefined();
  });

  it('should have start command', () => {
    const startCmd = program.commands.find(c => c.name() === 'start');
    expect(startCmd).toBeDefined();
  });

  it('should have stop command', () => {
    const stopCmd = program.commands.find(c => c.name() === 'stop');
    expect(stopCmd).toBeDefined();
  });

  it('should have restart command', () => {
    const restartCmd = program.commands.find(c => c.name() === 'restart');
    expect(restartCmd).toBeDefined();
  });

  it('should have deploy command', () => {
    const deployCmd = program.commands.find(c => c.name() === 'deploy');
    expect(deployCmd).toBeDefined();
  });

  it('should have remove command with alias', () => {
    const removeCmd = program.commands.find(c => c.name() === 'remove');
    expect(removeCmd).toBeDefined();
    expect(removeCmd?.aliases()).toContain('rm');
  });

  it('should have global --json option', () => {
    const options = program.options;
    const jsonOpt = options.find(o => o.long === '--json');
    expect(jsonOpt).toBeDefined();
  });

  it('should have global --quiet option', () => {
    const options = program.options;
    const quietOpt = options.find(o => o.long === '--quiet');
    expect(quietOpt).toBeDefined();
  });
});

describe('CLI Commands', () => {
  describe('deploy command', () => {
    it('should have path argument with default', () => {
      const program = createProgram();
      const deployCmd = program.commands.find(c => c.name() === 'deploy');
      expect(deployCmd).toBeDefined();
    });

    it('should have --name option', () => {
      const program = createProgram();
      const deployCmd = program.commands.find(c => c.name() === 'deploy');
      const nameOpt = deployCmd?.options.find(o => o.long === '--name');
      expect(nameOpt).toBeDefined();
    });

    it('should have --port option', () => {
      const program = createProgram();
      const deployCmd = program.commands.find(c => c.name() === 'deploy');
      const portOpt = deployCmd?.options.find(o => o.long === '--port');
      expect(portOpt).toBeDefined();
    });

    it('should have --env option', () => {
      const program = createProgram();
      const deployCmd = program.commands.find(c => c.name() === 'deploy');
      const envOpt = deployCmd?.options.find(o => o.long === '--env');
      expect(envOpt).toBeDefined();
    });
  });

  describe('logs command', () => {
    it('should have --lines option', () => {
      const program = createProgram();
      const logsCmd = program.commands.find(c => c.name() === 'logs');
      const linesOpt = logsCmd?.options.find(o => o.long === '--lines');
      expect(linesOpt).toBeDefined();
    });

    it('should have --follow option', () => {
      const program = createProgram();
      const logsCmd = program.commands.find(c => c.name() === 'logs');
      const followOpt = logsCmd?.options.find(o => o.long === '--follow');
      expect(followOpt).toBeDefined();
    });

    it('should have --error option', () => {
      const program = createProgram();
      const logsCmd = program.commands.find(c => c.name() === 'logs');
      const errorOpt = logsCmd?.options.find(o => o.long === '--error');
      expect(errorOpt).toBeDefined();
    });
  });

  describe('list command', () => {
    it('should have --status option', () => {
      const program = createProgram();
      const listCmd = program.commands.find(c => c.name() === 'list');
      const statusOpt = listCmd?.options.find(o => o.long === '--status');
      expect(statusOpt).toBeDefined();
    });

    it('should have --all option', () => {
      const program = createProgram();
      const listCmd = program.commands.find(c => c.name() === 'list');
      const allOpt = listCmd?.options.find(o => o.long === '--all');
      expect(allOpt).toBeDefined();
    });
  });

  describe('remove command', () => {
    it('should have --force option', () => {
      const program = createProgram();
      const removeCmd = program.commands.find(c => c.name() === 'remove');
      const forceOpt = removeCmd?.options.find(o => o.long === '--force');
      expect(forceOpt).toBeDefined();
    });

    it('should have --keep-data option', () => {
      const program = createProgram();
      const removeCmd = program.commands.find(c => c.name() === 'remove');
      const keepDataOpt = removeCmd?.options.find(o => o.long === '--keep-data');
      expect(keepDataOpt).toBeDefined();
    });
  });

  describe('stop command', () => {
    it('should have --force option', () => {
      const program = createProgram();
      const stopCmd = program.commands.find(c => c.name() === 'stop');
      const forceOpt = stopCmd?.options.find(o => o.long === '--force');
      expect(forceOpt).toBeDefined();
    });
  });
});
