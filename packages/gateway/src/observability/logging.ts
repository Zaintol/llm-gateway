import type { LoggerOptions } from 'pino';
import { activeTraceIds } from './tracing.js';

/**
 * Fields that must never reach a log line: credentials anywhere, and request/response content
 * (messages, completions, tool arguments). Paths are pino redaction paths.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'req.headers.cookie',
  'headers.authorization',
  'headers["x-api-key"]',
  'authorization',
  '*.authorization',
  'secret',
  '*.secret',
  '*.*.secret',
  'apiKey',
  '*.apiKey',
  'key',
  'credential',
  '*.credential',
  'messages',
  '*.messages',
  'body.messages',
  'choices',
  '*.choices',
  'content',
  '*.content',
  'prompt',
  '*.prompt',
  'tools',
  '*.tools',
];

export function loggerOptions(level: string): LoggerOptions {
  return {
    level,
    base: { service: 'llm-gateway' },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    // Every line inside a request carries the active trace and span ids.
    mixin: () => activeTraceIds(),
  };
}

/** Prompt logging is a development-only debugging aid; it can never be switched on in production. */
export function promptLoggingAllowed(logPrompts: boolean, nodeEnv: string): boolean {
  return logPrompts && nodeEnv === 'development';
}
