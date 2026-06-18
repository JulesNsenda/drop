/**
 * Logger Utility
 *
 * Provides file-based and console logging for the DROP platform.
 */

import * as fs from 'fs';
import * as path from 'path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LoggerConfig {
  /** Minimum log level to output */
  level: LogLevel;
  /** Directory for log files */
  logDir?: string;
  /** Log to console */
  console: boolean;
  /** Log to file */
  file: boolean;
  /** Log file name (without path) */
  filename?: string;
  /** Error log file name (without path) */
  errorFilename?: string;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger {
  private config: LoggerConfig;
  private logStream: fs.WriteStream | null = null;
  private errorStream: fs.WriteStream | null = null;

  constructor(config: Partial<LoggerConfig> = {}) {
    this.config = {
      level: config.level ?? 'info',
      logDir: config.logDir,
      console: config.console ?? true,
      file: config.file ?? false,
      filename: config.filename ?? 'drop-svc.log',
      errorFilename: config.errorFilename ?? 'drop-svc-error.log',
    };

    if (this.config.file && this.config.logDir) {
      this.initFileStreams();
    }
  }

  private initFileStreams(): void {
    if (!this.config.logDir) return;

    try {
      // Ensure log directory exists
      fs.mkdirSync(this.config.logDir, { recursive: true });

      const logPath = path.join(this.config.logDir, this.config.filename!);
      const errorPath = path.join(this.config.logDir, this.config.errorFilename!);

      this.logStream = fs.createWriteStream(logPath, { flags: 'a' });
      this.errorStream = fs.createWriteStream(errorPath, { flags: 'a' });
    } catch (error) {
      console.error('Failed to initialize log streams:', error);
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.config.level];
  }

  private formatMessage(level: LogLevel, message: string, context?: string): string {
    const timestamp = new Date().toISOString();
    const contextStr = context ? ` [${context}]` : '';
    return `[${timestamp}] [${level.toUpperCase()}]${contextStr} ${message}`;
  }

  private writeToFile(formatted: string, level: LogLevel): void {
    if (!this.config.file) return;

    // Write to main log
    if (this.logStream) {
      this.logStream.write(formatted + '\n');
    }

    // Also write errors to error log
    if (level === 'error' && this.errorStream) {
      this.errorStream.write(formatted + '\n');
    }
  }

  private writeToConsole(formatted: string, level: LogLevel): void {
    if (!this.config.console) return;

    switch (level) {
      case 'error':
        console.error(formatted);
        break;
      case 'warn':
        console.warn(formatted);
        break;
      default:
        console.log(formatted);
    }
  }

  log(level: LogLevel, message: string, context?: string, error?: unknown): void {
    if (!this.shouldLog(level)) return;

    let formatted = this.formatMessage(level, message, context);

    if (error) {
      if (error instanceof Error) {
        formatted += `\n  Error: ${error.message}`;
        if (error.stack && this.config.level === 'debug') {
          formatted += `\n  Stack: ${error.stack}`;
        }
      } else {
        formatted += `\n  Error: ${String(error)}`;
      }
    }

    this.writeToConsole(formatted, level);
    this.writeToFile(formatted, level);
  }

  debug(message: string, context?: string): void {
    this.log('debug', message, context);
  }

  info(message: string, context?: string): void {
    this.log('info', message, context);
  }

  warn(message: string, context?: string, error?: unknown): void {
    this.log('warn', message, context, error);
  }

  error(message: string, context?: string, error?: unknown): void {
    this.log('error', message, context, error);
  }

  /**
   * Log an application lifecycle event
   */
  appEvent(event: 'detected' | 'building' | 'built' | 'starting' | 'started' | 'stopping' | 'stopped' | 'error', appName: string, details?: string): void {
    const messages: Record<string, string> = {
      detected: `App detected: ${appName}`,
      building: `Building app: ${appName}`,
      built: `Build completed: ${appName}`,
      starting: `Starting app: ${appName}`,
      started: `App started: ${appName}`,
      stopping: `Stopping app: ${appName}`,
      stopped: `App stopped: ${appName}`,
      error: `App error: ${appName}`,
    };

    const message = details ? `${messages[event]} - ${details}` : messages[event];
    const level = event === 'error' ? 'error' : 'info';
    this.log(level, message, 'APP');
  }

  /**
   * Log a platform lifecycle event
   */
  platformEvent(event: 'starting' | 'started' | 'stopping' | 'stopped' | 'error', details?: string): void {
    const messages: Record<string, string> = {
      starting: 'DROP platform starting',
      started: 'DROP platform started',
      stopping: 'DROP platform stopping',
      stopped: 'DROP platform stopped',
      error: 'DROP platform error',
    };

    const message = details ? `${messages[event]} - ${details}` : messages[event];
    const level = event === 'error' ? 'error' : 'info';
    this.log(level, message, 'PLATFORM');
  }

  /**
   * Close log streams
   */
  close(): void {
    if (this.logStream) {
      this.logStream.on('error', () => {});
      this.logStream.end();
      this.logStream = null;
    }
    if (this.errorStream) {
      this.errorStream.on('error', () => {});
      this.errorStream.end();
      this.errorStream = null;
    }
  }

  /**
   * Update configuration
   */
  setLevel(level: LogLevel): void {
    this.config.level = level;
  }

  /**
   * Enable file logging
   */
  enableFileLogging(logDir: string): void {
    this.config.file = true;
    this.config.logDir = logDir;
    this.initFileStreams();
  }
}

// Singleton logger instance
let loggerInstance: Logger | null = null;

export function getLogger(config?: Partial<LoggerConfig>): Logger {
  if (!loggerInstance) {
    loggerInstance = new Logger(config);
  }
  return loggerInstance;
}

export function resetLogger(): void {
  if (loggerInstance) {
    loggerInstance.close();
    loggerInstance = null;
  }
}

export function createLogger(config: Partial<LoggerConfig>): Logger {
  return new Logger(config);
}
