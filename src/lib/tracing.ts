import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { JaegerExporter as OTelJaegerExporter } from '@opentelemetry/exporter-jaeger';
import { ConsoleSpanExporter, BatchSpanProcessor, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { trace, context, Span as OTelSpan, SpanStatusCode, Context, propagation } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';

/**
 * Trace context interface for W3C trace context (backward compatible)
 */
export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  traceFlags: number;
  traceState?: string | undefined;
}

/**
 * Span interface (backward compatible with existing code)
 */
export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  operationName: string;
  startTime: number;
  endTime?: number;
  tags: Record<string, any>;
  logs: Array<{
    timestamp: number;
    level: string;
    message: string;
    fields?: Record<string, any>;
  }>;
  status: 'ok' | 'error';
  error?: Error;
  // Internal OpenTelemetry span reference
  _otelSpan?: OTelSpan;
}

/**
 * Trace exporter interface (backward compatible)
 */
export interface TraceExporter {
  export(spans: Span[]): Promise<void>;
}

/**
 * Legacy Jaeger exporter wrapper (deprecated, use OpenTelemetry Jaeger exporter via config)
 */
export class JaegerExporter implements TraceExporter {
  async export(_spans: Span[]): Promise<void> {
    console.log('[Tracing] JaegerExporter is deprecated. Use initializeTracing() with Jaeger configuration instead.');
  }
}

/**
 * Legacy Honeycomb exporter wrapper (deprecated, use OTLP exporter)
 */
export class HoneycombExporter implements TraceExporter {
  async export(_spans: Span[]): Promise<void> {
    console.log('[Tracing] HoneycombExporter is deprecated. Use initializeTracing() with OTLP/Honeycomb configuration instead.');
  }
}

/**
 * Legacy Console exporter wrapper
 */
export class ConsoleExporter implements TraceExporter {
  async export(spans: Span[]): Promise<void> {
    spans.forEach(span => {
      const duration = span.endTime ? span.endTime - span.startTime : Date.now() - span.startTime;
      console.log(`[Trace] ${span.operationName} - ${duration}ms - ${span.traceId}:${span.spanId}`);
      if (span.tags && Object.keys(span.tags).length > 0) {
        console.log('[Trace] Tags:', span.tags);
      }
      if (span.logs.length > 0) {
        console.log('[Trace] Logs:', span.logs);
      }
    });
  }
}

// OpenTelemetry SDK instance
let otelSDK: NodeSDK | null = null;
let tracer = trace.getTracer('stellarflow-backend');

/**
 * Initialize OpenTelemetry SDK with proper configuration
 */
export function initializeOpenTelemetry(config: {
  serviceName: string;
  jaegerEndpoint?: string | undefined;
  otlpEndpoint?: string | undefined;
  honeycombEndpoint?: string | undefined;
  honeycombApiKey?: string | undefined;
  honeycombDataset?: string | undefined;
  consoleExporter?: boolean | undefined;
}): void {
  const exporters: (ConsoleSpanExporter | OTLPTraceExporter | OTelJaegerExporter)[] = [];

  if (config.consoleExporter) {
    exporters.push(new ConsoleSpanExporter());
  }

  if (config.otlpEndpoint) {
    exporters.push(new OTLPTraceExporter({
      url: config.otlpEndpoint,
    }));
  }

  if (config.honeycombEndpoint && config.honeycombApiKey) {
    exporters.push(new OTLPTraceExporter({
      url: config.honeycombEndpoint,
      headers: {
        'x-honeycomb-team': config.honeycombApiKey,
        'x-honeycomb-dataset': config.honeycombDataset || 'stellarflow'
      }
    }));
  }

  if (config.jaegerEndpoint) {
    exporters.push(new OTelJaegerExporter({
      endpoint: config.jaegerEndpoint,
    }));
  }

  // Default to console if no exporters configured
  if (exporters.length === 0) {
    exporters.push(new ConsoleSpanExporter());
  }

  otelSDK = new NodeSDK({
    resource: resourceFromAttributes({
      [SemanticResourceAttributes.SERVICE_NAME]: config.serviceName,
      [SemanticResourceAttributes.SERVICE_VERSION]: '1.0.0',
    }),
    traceExporter: exporters.length === 1 ? exporters[0]! : new MultiExporter(exporters),
    instrumentations: [getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-http': { enabled: true },
      '@opentelemetry/instrumentation-express': { enabled: true },
    })],
    spanProcessor: new BatchSpanProcessor(exporters.length === 1 ? exporters[0]! : new MultiExporter(exporters)),
    textMapPropagator: new W3CTraceContextPropagator(),
  });

  otelSDK.start();
  tracer = trace.getTracer(config.serviceName);
  console.log(`[OpenTelemetry] SDK initialized for service: ${config.serviceName}`);
}

/**
 * Multi-exporter for sending spans to multiple destinations
 */
class MultiExporter extends ConsoleSpanExporter {
  private exporters: (ConsoleSpanExporter | OTLPTraceExporter | OTelJaegerExporter)[];

  constructor(exporters: (ConsoleSpanExporter | OTLPTraceExporter | OTelJaegerExporter)[]) {
    super();
    this.exporters = exporters;
  }

  export(spans: any, resultCallback: any): void {
    this.exporters.forEach(exporter => {
      try {
        (exporter as any).export(spans, resultCallback);
      } catch (error) {
        console.error('[Tracing] Exporter error:', error);
      }
    });
  }
}

/**
 * Main tracing class (backward compatible API)
 */
export class Tracing {
  private static instance: Tracing;
  private activeSpans: Map<string, Span> = new Map();

  private constructor() {}

  static getInstance(): Tracing {
    if (!Tracing.instance) {
      Tracing.instance = new Tracing();
    }
    return Tracing.instance;
  }

  /**
   * Legacy initialize method (backward compatible)
   * Note: OpenTelemetry SDK should be initialized separately via initializeOpenTelemetry()
   */
  initialize(_config: {
    exporters?: TraceExporter[];
    exportIntervalMs?: number;
  }): void {
    console.log('[Tracing] Legacy initialize() called. Use initializeOpenTelemetry() for proper OTel SDK setup.');
  }

  /**
   * Extract trace context from headers (W3C format)
   */
  extractTraceContext(headers: Record<string, string>): TraceContext | null {
    const getter = {
      get: (carrier: Record<string, string>, key: string) => carrier[key],
      keys: (carrier: Record<string, string>) => Object.keys(carrier)
    };

    const extractedContext = propagation.extract(context.active(), headers, getter);
    const spanContext = trace.getSpanContext(extractedContext);

    if (!spanContext) {
      return null;
    }

    return {
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
      traceFlags: spanContext.traceFlags,
      traceState: spanContext.traceState?.toString() || undefined,
    };
  }

  /**
   * Inject trace context into headers (W3C format)
   */
  injectTraceContext(headers: Record<string, any>, traceContext: TraceContext): void {
    const spanContext = {
      traceId: traceContext.traceId,
      spanId: traceContext.spanId,
      traceFlags: traceContext.traceFlags,
      isRemote: false,
    };

    const setter = {
      set: (carrier: Record<string, any>, key: string, value: string) => {
        carrier[key] = value;
      }
    };

    // Create a context with the span context and inject it
    const ctx = trace.setSpanContext(context.active(), spanContext);
    propagation.inject(ctx, headers, setter);
  }

  /**
   * Start a new span (backward compatible API)
   */
  startSpan(operationName: string, parentContext?: TraceContext, tags?: Record<string, any>): Span {
    const startTime = Date.now();
    let otelParentContext: Context | undefined;

    if (parentContext) {
      const spanContext = {
        traceId: parentContext.traceId,
        spanId: parentContext.parentSpanId || parentContext.spanId,
        traceFlags: parentContext.traceFlags,
        isRemote: true,
      };
      otelParentContext = trace.setSpanContext(context.active(), spanContext);
    }

    const otelSpan = tracer.startSpan(operationName, {}, otelParentContext);
    const spanContext = otelSpan.spanContext();

    // Set initial attributes
    if (tags) {
      Object.entries(tags).forEach(([key, value]) => {
        otelSpan.setAttribute(key, value);
      });
    }

    const span: Span = {
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
      operationName,
      startTime,
      tags: tags || {},
      logs: [],
      status: 'ok',
      _otelSpan: otelSpan,
    };

    this.activeSpans.set(span.spanId, span);
    return span;
  }

  /**
   * Finish a span (backward compatible API)
   */
  finishSpan(span: Span, error?: Error): void {
    if (span._otelSpan) {
      if (error) {
        span._otelSpan.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        span._otelSpan.recordException(error);
      } else {
        span._otelSpan.setStatus({ code: SpanStatusCode.OK });
      }
      span._otelSpan.end();
    }

    span.endTime = Date.now();
    span.status = error ? 'error' : 'ok';
    if (error) {
      span.error = error;
    }

    this.activeSpans.delete(span.spanId);
  }

  /**
   * Add a log entry to a span (backward compatible API)
   */
  log(span: Span, level: string, message: string, fields?: Record<string, any>): void {
    span.logs.push({
      timestamp: Date.now(),
      level,
      message,
      ...(fields && { fields })
    });

    if (span._otelSpan) {
      const attributes: Record<string, any> = { 'log.level': level, 'log.message': message };
      if (fields) {
        Object.entries(fields).forEach(([key, value]) => {
          attributes[`log.field.${key}`] = value;
        });
      }
      span._otelSpan.addEvent('log', attributes);
    }
  }

  /**
   * Set a tag on a span (backward compatible API)
   */
  setTag(span: Span, key: string, value: any): void {
    span.tags[key] = value;
    if (span._otelSpan) {
      span._otelSpan.setAttribute(key, value);
    }
  }

  /**
   * Get current active span by ID
   */
  getActiveSpan(spanId: string): Span | undefined {
    return this.activeSpans.get(spanId);
  }

  /**
   * Shutdown tracing (backward compatible API)
   */
  async shutdown(): Promise<void> {
    if (otelSDK) {
      await otelSDK.shutdown();
    }
    this.activeSpans.clear();
  }
}

/**
 * Axios interceptor for automatic trace propagation (backward compatible)
 * Note: OpenTelemetry auto-instrumentation handles this automatically
 */
export function setupAxiosTracing(axiosInstance = axios): void {
  console.log('[Tracing] setupAxiosTracing() called. Setting up trace context propagation.');
  
  // Add request interceptor to inject traceparent headers
  axiosInstance.interceptors.request.use((config) => {
    const currentSpan = trace.getSpan(context.active());
    if (currentSpan) {
      const spanContext = currentSpan.spanContext();
      
      // Inject W3C trace context headers for explicit propagation
      const carrier: Record<string, string> = {};
      const setter = {
        set: (carrier: Record<string, string>, key: string, value: string) => {
          carrier[key] = value;
        }
      };
      
      // Create context with current span and inject trace headers
      const ctx = trace.setSpan(context.active(), currentSpan);
      propagation.inject(ctx, carrier, setter);
      
      // Merge trace headers into existing config headers
      Object.assign(config.headers || {}, carrier);
      
      // Log in development
      if (process.env.NODE_ENV === 'development') {
        console.log(`[Tracing] HTTP ${config.method?.toUpperCase()} ${config.url} (trace: ${spanContext.traceId})`);
        console.log(`[Tracing] Injected trace headers:`, Object.keys(carrier).filter(k => k.startsWith('trace')));
      }
    }
    return config;
  });
  
  // Add response interceptor for tracing completion
  axiosInstance.interceptors.response.use(
    (response) => {
      const currentSpan = trace.getSpan(context.active());
      if (currentSpan && process.env.NODE_ENV === 'development') {
        console.log(`[Tracing] HTTP Response: ${response.status} ${response.config.url}`);
      }
      return response;
    },
    (error) => {
      const currentSpan = trace.getSpan(context.active());
      if (currentSpan) {
        currentSpan.recordException(error);
        currentSpan.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      }
      return Promise.reject(error);
    }
  );
}

export default Tracing;
