/**
 * CLI Output Utilities
 *
 * Provides colored output, table formatting, and JSON mode support.
 */

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};

// Global state for output mode
let jsonMode = false;
let quietMode = false;

/**
 * Enable JSON output mode
 */
export function setJsonMode(enabled: boolean): void {
  jsonMode = enabled;
}

/**
 * Enable quiet mode (no output except errors)
 */
export function setQuietMode(enabled: boolean): void {
  quietMode = enabled;
}

/**
 * Check if JSON mode is enabled
 */
export function isJsonMode(): boolean {
  return jsonMode;
}

/**
 * Print colored text
 */
export function color(text: string, colorName: keyof typeof colors): string {
  if (jsonMode) return text;
  return `${colors[colorName]}${text}${colors.reset}`;
}

/**
 * Print success message (green)
 */
export function success(message: string): void {
  if (quietMode) return;
  if (jsonMode) {
    console.log(JSON.stringify({ type: 'success', message }));
  } else {
    console.log(`${colors.green}✓${colors.reset} ${message}`);
  }
}

/**
 * Print error message (red)
 */
export function error(message: string, err?: Error): void {
  if (jsonMode) {
    console.error(JSON.stringify({
      type: 'error',
      message,
      error: err?.message,
      stack: err?.stack,
    }));
  } else {
    console.error(`${colors.red}✗${colors.reset} ${message}`);
    if (err && process.env.DEBUG) {
      console.error(`${colors.dim}${err.stack}${colors.reset}`);
    }
  }
}

/**
 * Print warning message (yellow)
 */
export function warn(message: string): void {
  if (quietMode) return;
  if (jsonMode) {
    console.log(JSON.stringify({ type: 'warning', message }));
  } else {
    console.log(`${colors.yellow}⚠${colors.reset} ${message}`);
  }
}

/**
 * Print info message (blue)
 */
export function info(message: string): void {
  if (quietMode) return;
  if (jsonMode) {
    console.log(JSON.stringify({ type: 'info', message }));
  } else {
    console.log(`${colors.blue}ℹ${colors.reset} ${message}`);
  }
}

/**
 * Print plain message
 */
export function print(message: string): void {
  if (quietMode) return;
  console.log(message);
}

/**
 * Print JSON data (used in JSON mode)
 */
export function json(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Table column definition
 */
export interface TableColumn {
  header: string;
  key: string;
  width?: number;
  align?: 'left' | 'right' | 'center';
  color?: keyof typeof colors;
}

/**
 * Print a formatted table
 */
export function table(
  columns: TableColumn[],
  rows: Record<string, unknown>[]
): void {
  if (jsonMode) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (quietMode) return;

  // Calculate column widths
  const widths = columns.map((col) => {
    const headerLen = col.header.length;
    const maxDataLen = rows.reduce((max, row) => {
      const val = String(row[col.key] ?? '');
      return Math.max(max, val.length);
    }, 0);
    return col.width || Math.max(headerLen, maxDataLen);
  });

  // Print header
  const headerRow = columns
    .map((col, i) => padString(col.header, widths[i], col.align))
    .join('  ');
  console.log(`${colors.bold}${headerRow}${colors.reset}`);

  // Print separator
  const separator = widths.map((w) => '─'.repeat(w)).join('──');
  console.log(`${colors.dim}${separator}${colors.reset}`);

  // Print rows
  for (const row of rows) {
    const rowStr = columns
      .map((col, i) => {
        const val = String(row[col.key] ?? '');
        const padded = padString(val, widths[i], col.align);
        return col.color ? `${colors[col.color]}${padded}${colors.reset}` : padded;
      })
      .join('  ');
    console.log(rowStr);
  }
}

/**
 * Pad string to width with alignment
 */
function padString(str: string, width: number, align: 'left' | 'right' | 'center' = 'left'): string {
  const len = str.length;
  if (len >= width) return str.slice(0, width);

  const padding = width - len;

  switch (align) {
    case 'right':
      return ' '.repeat(padding) + str;
    case 'center': {
      const left = Math.floor(padding / 2);
      const right = padding - left;
      return ' '.repeat(left) + str + ' '.repeat(right);
    }
    default:
      return str + ' '.repeat(padding);
  }
}

/**
 * Format bytes to human readable
 */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unitIndex = 0;
  let value = bytes;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

/**
 * Format duration to human readable
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;

  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  return `${hours}h ${minutes}m`;
}

/**
 * Format status with color
 */
export function formatStatus(status: string): string {
  const statusColors: Record<string, keyof typeof colors> = {
    online: 'green',
    running: 'green',
    active: 'green',
    stopped: 'yellow',
    stopping: 'yellow',
    pending: 'yellow',
    errored: 'red',
    error: 'red',
    failed: 'red',
    launching: 'cyan',
    building: 'cyan',
    // Was up, now restarting repeatedly (post-deploy liveness watch) —
    // distinct from the terminal `errored`/red state.
    'crash-looping': 'yellow',
  };

  const colorName = statusColors[status.toLowerCase()] || 'white';
  return jsonMode ? status : `${colors[colorName]}${status}${colors.reset}`;
}

/**
 * Simple spinner for async operations
 */
export class Spinner {
  private interval: ReturnType<typeof setInterval> | null = null;
  private frameIndex = 0;
  private frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private message: string;

  constructor(message: string) {
    this.message = message;
  }

  start(): void {
    if (jsonMode || quietMode) return;

    process.stdout.write(`${this.frames[0]} ${this.message}`);
    this.interval = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % this.frames.length;
      process.stdout.write(`\r${this.frames[this.frameIndex]} ${this.message}`);
    }, 80);
  }

  stop(finalMessage?: string): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    if (jsonMode || quietMode) return;

    process.stdout.write('\r' + ' '.repeat(this.message.length + 2) + '\r');
    if (finalMessage) {
      console.log(finalMessage);
    }
  }

  succeed(message?: string): void {
    this.stop(`${colors.green}✓${colors.reset} ${message || this.message}`);
  }

  fail(message?: string): void {
    this.stop(`${colors.red}✗${colors.reset} ${message || this.message}`);
  }
}

/**
 * Create a spinner
 */
export function spinner(message: string): Spinner {
  return new Spinner(message);
}
