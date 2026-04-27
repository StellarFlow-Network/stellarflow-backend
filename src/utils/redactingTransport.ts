/**
 * RedactingTransport — custom Winston transport layer for PII scrubbing.
 *
 * Wraps any inner Winston transport (e.g. DailyRotateFile for file storage,
 * or a remote HTTP transport for external log aggregators) and applies
 * full PII/secret scrubbing via scrubLogInfo() before the log entry is
 * forwarded to the underlying transport.
 *
 * Architecture:
 *
 *   Logger → redactFormat (format-level guard)
 *          → RedactingTransport.log()
 *               └─ scrubLogInfo()    ← second scrub layer (defense-in-depth)
 *               └─ inner.log()       ← DailyRotateFile / HTTP / etc.
 *
 * Using two independent scrubbing layers ensures that even data injected
 * after format processing (e.g. by other middleware) is caught before it
 * reaches disk or an external sink.
 */

import Transport, { TransportStreamOptions } from "winston-transport";
import { scrubLogInfo } from "./logMasker";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RedactingTransportOptions extends TransportStreamOptions {
  /** The underlying transport to write sanitised entries to. */
  inner: Transport;
  /**
   * Optional label included in the [REDACTED] replacement strings for
   * debugging. Defaults to "RedactingTransport".
   */
  label?: string;
}

// ---------------------------------------------------------------------------
// RedactingTransport
// ---------------------------------------------------------------------------

/**
 * A custom Winston Transport that scrubs sensitive data from every log entry
 * before delegating to an inner transport.
 *
 * Usage:
 * ```ts
 * import DailyRotateFile from 'winston-daily-rotate-file';
 * import { RedactingTransport } from './redactingTransport';
 *
 * const fileTransport = new DailyRotateFile({ filename: 'app-%DATE%.log' });
 * const safeFileTransport = new RedactingTransport({ inner: fileTransport });
 * ```
 */
export class RedactingTransport extends Transport {
  private readonly inner: Transport;
  readonly label: string;

  constructor({ inner, label = "RedactingTransport", ...opts }: RedactingTransportOptions) {
    super(opts);
    this.inner = inner;
    this.label = label;
  }

  /**
   * Called by Winston for every log entry directed at this transport.
   *
   * 1. Scrubs the info object (message, metadata, nested objects).
   * 2. Forwards the sanitised copy to the inner transport.
   * 3. Emits 'logged' so Winston can track backpressure correctly.
   */
  log(info: unknown, callback: () => void): void {
    const scrubbed = scrubLogInfo(info);

    if (typeof this.inner.log === "function") {
      this.inner.log(scrubbed, () => {
        this.emit("logged", scrubbed);
        callback();
      });
    } else {
      // Fallback: inner transport doesn't expose log() — emit and proceed.
      this.emit("logged", scrubbed);
      callback();
    }
  }

  /**
   * Propagates close() to the inner transport so file handles are released
   * cleanly on shutdown.
   */
  close(): void {
    if (typeof (this.inner as unknown as { close?: () => void }).close === "function") {
      (this.inner as unknown as { close: () => void }).close();
    }
    // super.close is optional in winston-transport — guard before calling.
    if (typeof super.close === "function") {
      super.close();
    }
  }
}
