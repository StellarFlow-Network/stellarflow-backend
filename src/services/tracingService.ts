import { Request } from 'express';
import Tracing, { Span, TraceContext } from '../lib/tracing';
import { createChildSpan } from '../middleware/tracingMiddleware';

/**
 * Service for adding custom tracing to business operations
 */
export class TracingService {
  /**
   * Trace relayer request processing
   */
  static traceRelayerRequest(req: Request, relayerName: string, operation: string) {
    const span = createChildSpan(req, `relayer.${operation}`, {
      'relayer.name': relayerName,
      'operation.type': 'relayer_request',
      'request.path': req.path,
      'request.method': req.method
    });

    Tracing.getInstance().log(span, 'info', `Processing relayer request: ${operation}`, {
      relayerName,
      operation,
      path: req.path,
      method: req.method
    });

    return span;
  }

  /**
   * Trace API provider request
   */
  static traceApiProviderRequest(req: Request, providerName: string, endpoint: string) {
    const span = createChildSpan(req, `api_provider.${providerName}`, {
      'api_provider.name': providerName,
      'api_provider.endpoint': endpoint,
      'operation.type': 'api_request'
    });

    Tracing.getInstance().log(span, 'info', `Making API request to ${providerName}`, {
      providerName,
      endpoint
    });

    return span;
  }

  /**
   * Trace on-chain submission process
   */
  static traceOnChainSubmission(req: Request, currency: string, rate: number) {
    const span = createChildSpan(req, 'stellar.on_chain_submission', {
      'currency': currency,
      'rate': rate,
      'operation.type': 'on_chain_submission',
      'stellar.network': process.env.STELLAR_NETWORK || 'TESTNET'
    });

    Tracing.getInstance().log(span, 'info', 'Starting on-chain submission', {
      currency,
      rate,
      network: process.env.STELLAR_NETWORK || 'TESTNET'
    });

    return span;
  }

  /**
   * Trace multi-sig operation
   */
  static traceMultiSigOperation(req: Request, operation: string, multiSigPriceId: number) {
    const span = createChildSpan(req, `multi_sig.${operation}`, {
      'multi_sig.operation': operation,
      'multi_sig.price_id': multiSigPriceId,
      'operation.type': 'multi_sig'
    });

    Tracing.getInstance().log(span, 'info', `Multi-sig operation: ${operation}`, {
      operation,
      multiSigPriceId
    });

    return span;
  }

  /**
   * Trace price validation
   */
  static tracePriceValidation(req: Request, currency: string, rate: number, source: string) {
    const span = createChildSpan(req, 'price_validation', {
      'price.currency': currency,
      'price.rate': rate,
      'price.source': source,
      'operation.type': 'validation'
    });

    Tracing.getInstance().log(span, 'info', 'Validating price data', {
      currency,
      rate,
      source
    });

    return span;
  }

  /**
   * Trace database operation
   */
  static traceDatabaseOperation(req: Request, operation: string, table: string) {
    const span = createChildSpan(req, `database.${operation}`, {
      'database.operation': operation,
      'database.table': table,
      'operation.type': 'database'
    });

    Tracing.getInstance().log(span, 'debug', `Database operation: ${operation} on ${table}`, {
      operation,
      table
    });

    return span;
  }

  /**
   * Trace cache operation
   */
  static traceCacheOperation(req: Request, operation: string, key: string) {
    const span = createChildSpan(req, `cache.${operation}`, {
      'cache.operation': operation,
      'cache.key': key,
      'operation.type': 'cache'
    });

    Tracing.getInstance().log(span, 'debug', `Cache operation: ${operation} for key: ${key}`, {
      operation,
      key
    });

    return span;
  }

  /**
   * Trace webhook delivery
   */
  static traceWebhookDelivery(req: Request, webhookUrl: string, eventType: string) {
    const span = createChildSpan(req, 'webhook.delivery', {
      'webhook.url': webhookUrl,
      'webhook.event_type': eventType,
      'operation.type': 'webhook'
    });

    Tracing.getInstance().log(span, 'info', `Delivering webhook: ${eventType}`, {
      webhookUrl,
      eventType
    });

    return span;
  }

  /**
   * Trace error handling
   */
  static traceErrorHandling(req: Request, error: Error, context: string) {
    const span = createChildSpan(req, 'error_handling', {
      'error.context': context,
      'error.type': error.constructor.name,
      'error.message': error.message,
      'operation.type': 'error_handling'
    });

    Tracing.getInstance().log(span, 'error', `Error in ${context}: ${error.message}`, {
      context,
      errorName: error.constructor.name,
      errorMessage: error.message,
      stackTrace: error.stack
    });

    Tracing.getInstance().setTag(span, 'error', true);
    Tracing.getInstance().setTag(span, 'error.stack_trace', error.stack || '');

    return span;
  }

  /**
   * Trace background job execution
   */
  static traceBackgroundJob(jobName: string, jobId?: string) {
    const tracing = Tracing.getInstance();
    const span = tracing.startSpan(`background_job.${jobName}`, undefined, {
      'job.name': jobName,
      'job.id': jobId || 'unknown',
      'operation.type': 'background_job'
    });

    Tracing.getInstance().log(span, 'info', `Starting background job: ${jobName}`, {
      jobName,
      jobId
    });

    return span;
  }

  /**
   * Add custom tags to a span
   */
  static addTags(span: Span, tags: Record<string, any>) {
    const tracing = Tracing.getInstance();
    Object.entries(tags).forEach(([key, value]) => {
      tracing.setTag(span, key, value);
    });
  }

  /**
   * Add log entry to span
   */
  static addLog(span: Span, level: string, message: string, fields?: Record<string, any>) {
    const tracing = Tracing.getInstance();
    tracing.log(span, level, message, fields);
  }

  /**
   * Finish span with optional error
   */
  static finishSpan(span: Span, error?: Error) {
    const tracing = Tracing.getInstance();
    if (error) {
      tracing.finishSpan(span, error);
    } else {
      tracing.finishSpan(span);
    }
  }
}

/**
 * Higher-order function to wrap async functions with tracing
 */
export function withTracing(
  operationName: string,
  tags?: Record<string, any>
) {
  return function(target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;

    descriptor.value = async function(...args: any[]) {
      const tracing = Tracing.getInstance();
      const span = tracing.startSpan(operationName, undefined, {
        'function.name': propertyKey,
        'class.name': target.constructor.name,
        'arguments.count': args.length,
        ...tags
      });

      try {
        TracingService.addLog(span, 'info', `Starting ${operationName}`, {
          function: propertyKey,
          class: target.constructor.name
        });

        const result = await originalMethod.apply(this, args);
        
        TracingService.finishSpan(span);
        return result;
      } catch (error) {
        TracingService.finishSpan(span, error as Error);
        throw error;
      }
    };

    return descriptor;
  };
}

/**
 * Execute a function within a trace span
 */
export async function executeWithTrace<T>(
  operationName: string,
  fn: () => Promise<T>,
  tags?: Record<string, any>,
  parentContext?: TraceContext
): Promise<T> {
  const tracing = Tracing.getInstance();
  const span = tracing.startSpan(operationName, parentContext, tags);

  try {
    TracingService.addLog(span, 'info', `Starting ${operationName}`, tags);
    const result = await fn();
    TracingService.finishSpan(span);
    return result;
  } catch (error) {
    TracingService.finishSpan(span, error as Error);
    throw error;
  }
}

export default TracingService;
