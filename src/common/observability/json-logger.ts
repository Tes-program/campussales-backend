import { ConsoleLogger, LoggerService, LogLevel } from '@nestjs/common';
import { currentContext } from './request-context';
import { hashUserId, redact } from './redact';

type Level = 'error' | 'warn' | 'info' | 'debug' | 'verbose' | 'fatal';

/**
 * One JSON object per line on stdout, which Railway (and most log tools)
 * index by field: { t, level, context, msg, requestId, user, ...fields }.
 * The user id is an HMAC (see hashUserId) and every message goes through
 * redact() so tokens, emails and reset links never reach the log store.
 */
export function jsonFormat(): boolean {
  return (
    (process.env.LOG_FORMAT ||
      (process.env.NODE_ENV === 'production' ? 'json' : 'pretty')) === 'json'
  );
}

export function writeJson(
  level: Level,
  msg: string,
  fields: Record<string, unknown> = {},
  context?: string,
): void {
  const ctx = currentContext();
  const line: Record<string, unknown> = {
    t: new Date().toISOString(),
    level,
    ...(context ? { context } : {}),
    msg: redact(msg),
    ...(ctx?.requestId ? { requestId: ctx.requestId } : {}),
    ...(ctx?.userId ? { user: hashUserId(ctx.userId) } : {}),
    ...fields,
  };
  const out = jsonFormat()
    ? JSON.stringify(line)
    : `${String(line.t)} ${level.toUpperCase()} [${context ?? 'App'}] ${String(line.msg)} ${Object.entries(
        line,
      )
        .filter(([k]) => !['t', 'level', 'context', 'msg'].includes(k))
        .map(
          ([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`,
        )
        .join(' ')}`;
  if (level === 'error' || level === 'fatal') process.stderr.write(out + '\n');
  else process.stdout.write(out + '\n');
}

export class JsonLogger implements LoggerService {
  constructor(private readonly levels: LogLevel[] = ['log', 'warn', 'error']) {}

  private on(level: LogLevel) {
    return this.levels.includes(level);
  }

  log(message: unknown, context?: string) {
    if (this.on('log')) writeJson('info', String(message), {}, context);
  }
  warn(message: unknown, context?: string) {
    if (this.on('warn')) writeJson('warn', String(message), {}, context);
  }
  error(message: unknown, stack?: string, context?: string) {
    if (!this.on('error')) return;
    // Nest calls error(message, context) when there is no stack.
    if (context === undefined && stack && !stack.includes('\n')) {
      writeJson('error', String(message), {}, stack);
      return;
    }
    writeJson(
      'error',
      String(message),
      stack ? { stack: redact(stack) } : {},
      context,
    );
  }
  debug(message: unknown, context?: string) {
    if (this.on('debug')) writeJson('debug', String(message), {}, context);
  }
  verbose(message: unknown, context?: string) {
    if (this.on('verbose')) writeJson('verbose', String(message), {}, context);
  }
  fatal(message: unknown, context?: string) {
    writeJson('fatal', String(message), {}, context);
  }
  setLogLevels(levels: LogLevel[]) {
    this.levels.splice(0, this.levels.length, ...levels);
  }
}

/**
 * Pretty console output for local development, still redacted so a habit of
 * logging secrets locally can't leak into production by copy-paste.
 */
export class RedactingConsoleLogger extends ConsoleLogger {
  protected formatMessage(
    logLevel: LogLevel,
    message: unknown,
    pidMessage: string,
    formattedLogLevel: string,
    contextMessage: string,
    timestampDiff: string,
  ): string {
    const text =
      typeof message === 'string' ? redact(message) : (message as string);
    return super.formatMessage(
      logLevel,
      text,
      pidMessage,
      formattedLogLevel,
      contextMessage,
      timestampDiff,
    );
  }
}

export function createAppLogger(): LoggerService {
  const env = process.env.NODE_ENV;
  const levels: LogLevel[] =
    env === 'development'
      ? ['log', 'warn', 'error', 'debug']
      : ['log', 'warn', 'error'];
  return jsonFormat()
    ? new JsonLogger(levels)
    : new RedactingConsoleLogger({ logLevels: levels });
}
