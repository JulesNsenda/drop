/**
 * Logger Utility Tests
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Logger, getLogger, resetLogger, createLogger } from './logger';

describe('Logger', () => {
  let tempDir: string;
  let logger: Logger;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-logger-test-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    if (logger) {
      logger.close();
    }
    resetLogger();
    jest.restoreAllMocks();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('constructor', () => {
    it('should create logger with default config', () => {
      logger = new Logger();
      expect(logger).toBeInstanceOf(Logger);
    });

    it('should create logger with custom config', () => {
      logger = new Logger({
        level: 'debug',
        console: true,
        file: false,
      });
      expect(logger).toBeInstanceOf(Logger);
    });

    it('should initialize file streams when file logging is enabled', async () => {
      logger = new Logger({
        level: 'info',
        console: false,
        file: true,
        logDir: tempDir,
      });

      logger.info('test message');
      logger.close();

      // Give the stream time to flush
      await new Promise(resolve => setTimeout(resolve, 100));

      const logFile = path.join(tempDir, 'drop-svc.log');
      expect(fs.existsSync(logFile)).toBe(true);
    });
  });

  describe('log levels', () => {
    it('should respect log level filtering', () => {
      logger = new Logger({ level: 'warn', console: true });

      logger.debug('debug message');
      logger.info('info message');
      logger.warn('warn message');
      logger.error('error message');

      expect(console.log).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalledTimes(1);
    });

    it('should log all levels when set to debug', () => {
      logger = new Logger({ level: 'debug', console: true });

      logger.debug('debug message');
      logger.info('info message');
      logger.warn('warn message');
      logger.error('error message');

      expect(console.log).toHaveBeenCalledTimes(2); // debug and info
      expect(console.warn).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalledTimes(1);
    });

    it('should only log errors when set to error level', () => {
      logger = new Logger({ level: 'error', console: true });

      logger.debug('debug message');
      logger.info('info message');
      logger.warn('warn message');
      logger.error('error message');

      expect(console.log).not.toHaveBeenCalled();
      expect(console.warn).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledTimes(1);
    });
  });

  describe('log formatting', () => {
    it('should include timestamp in log messages', () => {
      logger = new Logger({ level: 'info', console: true });
      logger.info('test message');

      const call = (console.log as jest.Mock).mock.calls[0][0];
      expect(call).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z\]/);
    });

    it('should include log level in messages', () => {
      logger = new Logger({ level: 'info', console: true });
      logger.info('test message');

      const call = (console.log as jest.Mock).mock.calls[0][0];
      expect(call).toContain('[INFO]');
    });

    it('should include context when provided', () => {
      logger = new Logger({ level: 'info', console: true });
      logger.info('test message', 'TEST_CONTEXT');

      const call = (console.log as jest.Mock).mock.calls[0][0];
      expect(call).toContain('[TEST_CONTEXT]');
    });

    it('should include error details when provided', () => {
      logger = new Logger({ level: 'info', console: true });
      const error = new Error('Test error');
      logger.error('something went wrong', 'CONTEXT', error);

      const call = (console.error as jest.Mock).mock.calls[0][0];
      expect(call).toContain('Test error');
    });

    it('should include error stack in debug mode', () => {
      logger = new Logger({ level: 'debug', console: true });
      const error = new Error('Test error');
      logger.error('something went wrong', 'CONTEXT', error);

      const call = (console.error as jest.Mock).mock.calls[0][0];
      expect(call).toContain('Stack:');
    });

    it('should handle non-Error objects as errors', () => {
      logger = new Logger({ level: 'info', console: true });
      logger.error('something went wrong', 'CONTEXT', 'string error');

      const call = (console.error as jest.Mock).mock.calls[0][0];
      expect(call).toContain('string error');
    });
  });

  describe('file logging', () => {
    it('should write to log file', async () => {
      logger = new Logger({
        level: 'info',
        console: false,
        file: true,
        logDir: tempDir,
      });

      logger.info('file log message');
      logger.close();

      // Give the stream time to flush
      await new Promise(resolve => setTimeout(resolve, 100));

      const logFile = path.join(tempDir, 'drop-svc.log');
      const content = fs.readFileSync(logFile, 'utf-8');
      expect(content).toContain('file log message');
    });

    it('should write errors to both main log and error log', async () => {
      logger = new Logger({
        level: 'info',
        console: false,
        file: true,
        logDir: tempDir,
      });

      logger.error('error message');
      logger.close();

      // Give the stream time to flush
      await new Promise(resolve => setTimeout(resolve, 100));

      const mainLog = fs.readFileSync(path.join(tempDir, 'drop-svc.log'), 'utf-8');
      const errorLog = fs.readFileSync(path.join(tempDir, 'drop-svc-error.log'), 'utf-8');

      expect(mainLog).toContain('error message');
      expect(errorLog).toContain('error message');
    });

    it('should use custom filenames when provided', async () => {
      logger = new Logger({
        level: 'info',
        console: false,
        file: true,
        logDir: tempDir,
        filename: 'custom.log',
        errorFilename: 'custom-error.log',
      });

      logger.info('custom file message');
      logger.close();

      // Give the stream time to flush
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(fs.existsSync(path.join(tempDir, 'custom.log'))).toBe(true);
    });
  });

  describe('convenience methods', () => {
    beforeEach(() => {
      logger = new Logger({ level: 'debug', console: true });
    });

    it('should have debug method', () => {
      logger.debug('debug message');
      expect(console.log).toHaveBeenCalled();
    });

    it('should have info method', () => {
      logger.info('info message');
      expect(console.log).toHaveBeenCalledTimes(1);
    });

    it('should have warn method', () => {
      logger.warn('warn message');
      expect(console.warn).toHaveBeenCalled();
    });

    it('should have error method', () => {
      logger.error('error message');
      expect(console.error).toHaveBeenCalled();
    });
  });

  describe('appEvent', () => {
    beforeEach(() => {
      logger = new Logger({ level: 'info', console: true });
    });

    it('should log app detected event', () => {
      logger.appEvent('detected', 'my-app');
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('App detected: my-app'));
    });

    it('should log app building event', () => {
      logger.appEvent('building', 'my-app');
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Building app: my-app'));
    });

    it('should log app started event', () => {
      logger.appEvent('started', 'my-app', 'port 3000');
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('App started: my-app - port 3000'));
    });

    it('should log app error as error level', () => {
      logger.appEvent('error', 'my-app', 'Build failed');
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('App error: my-app - Build failed'));
    });

    it('should include APP context', () => {
      logger.appEvent('stopped', 'my-app');
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[APP]'));
    });
  });

  describe('platformEvent', () => {
    beforeEach(() => {
      logger = new Logger({ level: 'info', console: true });
    });

    it('should log platform starting event', () => {
      logger.platformEvent('starting');
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('DROP platform starting'));
    });

    it('should log platform started event with details', () => {
      logger.platformEvent('started', 'listening on port 3000');
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('DROP platform started - listening on port 3000'));
    });

    it('should log platform error as error level', () => {
      logger.platformEvent('error', 'Failed to start');
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('DROP platform error'));
    });

    it('should include PLATFORM context', () => {
      logger.platformEvent('stopped');
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[PLATFORM]'));
    });
  });

  describe('setLevel', () => {
    it('should allow changing log level at runtime', () => {
      logger = new Logger({ level: 'error', console: true });

      logger.info('should not log');
      expect(console.log).not.toHaveBeenCalled();

      logger.setLevel('info');
      logger.info('should log now');
      expect(console.log).toHaveBeenCalledTimes(1);
    });
  });

  describe('enableFileLogging', () => {
    it('should enable file logging after initialization', async () => {
      logger = new Logger({ level: 'info', console: false, file: false });

      logger.enableFileLogging(tempDir);
      logger.info('after enabling');
      logger.close();

      // Give the stream time to flush
      await new Promise(resolve => setTimeout(resolve, 100));

      const logFile = path.join(tempDir, 'drop-svc.log');
      expect(fs.existsSync(logFile)).toBe(true);
    });
  });

  describe('close', () => {
    it('should close log streams', () => {
      logger = new Logger({
        level: 'info',
        console: false,
        file: true,
        logDir: tempDir,
      });

      logger.info('before close');
      logger.close();

      // After close, should not throw when trying to log
      logger.info('after close');
    });

    it('should handle closing when streams are not initialized', () => {
      logger = new Logger({ level: 'info', console: true, file: false });
      expect(() => logger.close()).not.toThrow();
    });
  });
});

describe('getLogger singleton', () => {
  afterEach(() => {
    resetLogger();
  });

  it('should return singleton instance', () => {
    const logger1 = getLogger({ level: 'info' });
    const logger2 = getLogger();

    expect(logger1).toBe(logger2);
  });
});

describe('createLogger factory', () => {
  it('should create new logger instance', () => {
    const logger1 = createLogger({ level: 'debug' });
    const logger2 = createLogger({ level: 'info' });

    expect(logger1).not.toBe(logger2);

    logger1.close();
    logger2.close();
  });
});
