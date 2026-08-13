/**
 * Run Logger Implementation
 * @module lib/engine/logger
 * @see docs/04-decisions.md#adr-0007
 */

import type { RunLogger, LogEntry } from '../harness/types'

export class SimpleRunLogger implements RunLogger {
  private entries_: LogEntry[] = []

  constructor(_runId: string) {
    // runId will be used in M2 for persistent logging
  }

  log(event: string, data?: unknown): void {
    this.entries_.push({
      timestamp: new Date().toISOString(),
      level: 'info',
      event,
      data,
    })
  }

  info(message: string, data?: unknown): void {
    this.entries_.push({
      timestamp: new Date().toISOString(),
      level: 'info',
      event: 'log',
      data: data ? { message, ...data as object } : { message },
    })
  }

  warn(message: string, data?: unknown): void {
    this.entries_.push({
      timestamp: new Date().toISOString(),
      level: 'warn',
      event: 'log',
      data: data ? { message, ...data as object } : { message },
    })
  }

  error(message: string, error?: Error | unknown): void {
    this.entries_.push({
      timestamp: new Date().toISOString(),
      level: 'error',
      event: 'error',
      data: {
        message,
        error: error instanceof Error ? {
          name: error.name,
          message: error.message,
          stack: error.stack,
        } : error,
      },
    })
  }

  async flush(): Promise<void> {
    // TODO: Write to .solidify/runs/<runId>.jsonl in M2
    // For now, just keep in memory
  }

  entries(): LogEntry[] {
    return [...this.entries_]
  }
}
