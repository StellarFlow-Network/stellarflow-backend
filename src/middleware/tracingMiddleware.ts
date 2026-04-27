import { Request, Response, NextFunction } from 'express';
import { trace, context, propagation, SpanStatusCode } from '@opentelemetry/api';
import Tracing, { TraceContext, Span } from '../lib/tracing';

/**
 * Extend Express Request interface to include tracing information
 */
declare global {
  namespace Express {
    interface Request {
      traceContext?: TraceContext;
      currentSpan?: any;
    }
  }
}

/**
 * Express middleware for automatic request tracing
 * Uses OpenTelemetry auto-instrumentation for HTTP layer,
 * plus custom spans for application-level operations
 */
export function tracingMiddleware(req: Request, res: Response, next: NextFunction): void {
  const tracing = Tracing.getInstance();
  const tracer = trace.getTracer('stellarflow-middleware');

  // Extract trace context from incoming headers (W3C trace context)
  const getter = {
    get: (carrier: any, key: string) => carrier[key],
    keys: () => Object.keys(req.headers)
  };
  const parentContext = propagation.extract(context.active(), req.headers, getter);
  
  // Start a new span for this request within the OpenTelemetry context
  const span = tracer.startSpan(
    `${req.method} ${req.path}`,
    {},
    parentContext
  );

  // Set span attributes
  span.setAttribute('http.method', req.method);
  span.setAttribute('http.url', req.url);
  span.setAttribute('http.host', req.headers.host || '');
  span.setAttribute('user_agent', req.headers['user-agent'] || '');
  span.setAttribute('remote_addr', req.ip || req.connection.remoteAddress || '');

  // Create trace context for backward compatibility
  const spanContext = span.spanContext();
  const traceContext: TraceContext = {
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    traceFlags: spanContext.traceFlags,
  };

  // Store trace context and span on request
  req.traceContext = traceContext;
  req.currentSpan = span;

  // Add trace headers to response for client-side correlation (W3C format)
  const responseSetter = {
    set: (_carrier: any, key: string, value: string) => {
      res.setHeader(key, value);
    }
  };
  propagation.inject(trace.setSpan(context.active(), span), res as any, responseSetter);

  // Override res.end to finish the span when response is sent
  const originalEnd = res.end.bind(res);
  res.end = function(chunk?: any, encoding?: any, cb?: any): Response {
    // Set response attributes
    span.setAttribute('http.status_code', res.statusCode);
    const contentLength = res.get('content-length');
    if (contentLength) {
      span.setAttribute('http.response_size', contentLength);
    }

    // Set span status based on HTTP status code
    if (res.statusCode >= 500) {
      span.setStatus({ code: SpanStatusCode.ERROR });
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }

    // End the span
    span.end();

    // Call original end
    return originalEnd(chunk, encoding, cb) as Response;
  };

  // Handle errors
  res.on('error', (error: Error) => {
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    span.end();
  });

  // Continue with the span in context
  const ctx = trace.setSpan(context.active(), span);
  context.with(ctx, () => {
    next();
  });
}

/**
 * Middleware to add current span ID to axios requests for trace propagation
 */
export function axiosTracingMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.currentSpan) {
    // Store current span ID for axios interceptor to use
    (req as any).__currentSpanId = req.currentSpan.spanId;
  }
  next();
}

/**
 * Helper function to create child spans within request handlers
 */
export function createChildSpan(req: Request, operationName: string, tags?: Record<string, any>) {
  const tracing = Tracing.getInstance();
  
  if (!req.currentSpan) {
    // Create a new span if no parent exists
    return tracing.startSpan(operationName, undefined, tags);
  }

  // Create child span with current span as parent using OpenTelemetry tracer
  const tracer = trace.getTracer('stellarflow-child-spans');
  const parentOtelSpan = req.currentSpan;
  const parentCtx = trace.setSpan(context.active(), parentOtelSpan);
  
  const childSpan = tracer.startSpan(operationName, {}, parentCtx);
  
  // Set initial attributes
  if (tags) {
    Object.entries(tags).forEach(([key, value]) => {
      childSpan.setAttribute(key, value);
    });
  }
  
  const spanContext = childSpan.spanContext();
  const compatSpan: Span = {
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    parentSpanId: req.currentSpan.spanId,
    operationName,
    startTime: Date.now(),
    tags: tags || {},
    logs: [],
    status: 'ok',
    _otelSpan: childSpan,
  };
  
  return compatSpan;
}

/**
 * Decorator for automatic function tracing
 */
export function traceOperation(operationName?: string) {
  return function(target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    const traceName = operationName || `${target.constructor.name}.${propertyKey}`;

    descriptor.value = function(...args: any[]) {
      const tracing = Tracing.getInstance();
      const span = tracing.startSpan(traceName, undefined, {
        'function.name': propertyKey,
        'class.name': target.constructor.name,
        'arguments.count': args.length
      });

      try {
        const result = originalMethod.apply(this, args);
        
        if (result && typeof result.then === 'function') {
          // Handle async functions
          return result
            .then((res: any) => {
              tracing.finishSpan(span);
              return res;
            })
            .catch((error: any) => {
              tracing.finishSpan(span, error);
              throw error;
            });
        } else {
          // Handle sync functions
          tracing.finishSpan(span);
          return result;
        }
      } catch (error) {
        tracing.finishSpan(span, error as Error);
        throw error;
      }
    };

    return descriptor;
  };
}
