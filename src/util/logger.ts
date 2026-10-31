export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Small structured logger. Callers pass only safe, non-secret fields: this
 * module never inspects request bodies, headers, or Pagey tokens.
 */
export class Logger {
  private readonly stderr: boolean;

  constructor(
    private readonly level: LogLevel = "info",
    stderr = process.env.LOG_TO_STDERR === "1",
  ) {
    this.stderr = stderr;
  }

  child(level: LogLevel): Logger {
    return new Logger(level, this.stderr);
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.write("debug", message, fields);
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.write("info", message, fields);
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.write("warn", message, fields);
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.write("error", message, fields);
  }

  private write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (ORDER[level] < ORDER[this.level]) return;
    const suffix = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : "";
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}${suffix}`;
    if (this.stderr || level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }
}
