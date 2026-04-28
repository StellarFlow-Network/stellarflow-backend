# End-to-End Tracing Implementation

This document describes the comprehensive end-to-end tracing implementation for data packets as they move from external API providers, through the relayers, to on-chain submission.

## Overview

The tracing system provides full visibility into the data flow through the StellarFlow backend, enabling:

- **Request Flow Tracking**: Trace data packets from API ingestion to on-chain submission
- **Performance Monitoring**: Identify bottlenecks and latency issues
- **Error Tracking**: Pinpoint where failures occur in the pipeline
- **Distributed Tracing**: Correlate requests across multiple services

## Architecture

### Core Components

1. **Tracing Library** (`src/lib/tracing.ts`)
   - Custom OpenTelemetry-compatible tracing implementation
   - W3C trace context support
   - Multiple exporters (Console, Jaeger, Honeycomb)

2. **Middleware** (`src/middleware/tracingMiddleware.ts`)
   - Express middleware for automatic request tracing
   - Axios interceptors for HTTP request propagation
   - Child span creation utilities

3. **Configuration** (`src/config/tracingConfig.ts`)
   - Environment-based configuration
   - Exporter setup and validation
   - Service initialization

4. **Service Integration** (`src/services/tracingService.ts`)
   - Business operation tracing helpers
   - Decorators for automatic function tracing
   - Custom span creation for specific operations

## Trace Flow

### 1. Incoming Request
```
External API → Relayer → Express App → Tracing Middleware → Business Logic
```

- Traceparent header extraction from incoming requests
- Root span creation with HTTP metadata
- Request context propagation

### 2. API Provider Integration
```
Business Logic → External API Call → Response Processing → Validation
```

- Child span creation for API requests
- Automatic traceparent header injection
- Response and error tracking

### 3. Relayer Processing
```
Validation → Multi-sig Operations → Signature Collection → Submission
```

- Relayer-specific span creation
- Authorization and validation tracking
- Multi-sig operation tracing

### 4. On-Chain Submission
```
Stellar Network → Transaction Submission → Confirmation → Recording
```

- Stellar transaction span creation
- Network interaction tracking
- Success/failure monitoring

## Configuration

### Environment Variables

```bash
# Enable/disable tracing
TRACING_ENABLED=true

# Service identification
TRACING_SERVICE_NAME=stellarflow-backend

# Console exporter (development)
TRACING_CONSOLE_EXPORTER=true

# Jaeger exporter
TRACING_JAEGER_ENDPOINT=http://localhost:14268/api/traces

# Honeycomb exporter
TRACING_HONEYCOMB_ENDPOINT=https://api.honeycomb.io/v1/events
TRACING_HONEYCOMB_API_KEY=your_api_key
TRACING_HONEYCOMB_DATASET=stellarflow

# Export configuration
TRACING_EXPORT_INTERVAL_MS=5000
TRACING_SAMPLING_RATE=1.0
```

### Exporter Setup

#### Console Exporter (Development)
- Outputs traces to console for local development
- Always enabled by default in development mode

#### Jaeger Exporter (Production)
- Sends traces to Jaeger collector
- Requires Jaeger instance running
- Recommended for on-premises deployments

#### Honeycomb Exporter (Cloud)
- Sends traces to Honeycomb.io
- Requires API key and dataset configuration
- Recommended for cloud deployments

## Implementation Details

### Trace Context Propagation

The system uses W3C trace context headers:

```
traceparent: 00-traceId-parentSpanId-traceFlags
tracestate: key1=value1,key2=value2
```

### Span Types

1. **HTTP Spans**: Track incoming/outgoing HTTP requests
2. **Business Spans**: Track application logic operations
3. **Database Spans**: Track database operations
4. **External API Spans**: Track third-party API calls
5. **Blockchain Spans**: Track Stellar network interactions

### Key Operations Traced

- **Relayer Request Processing**: From receipt to validation
- **API Provider Requests**: External data fetching
- **Price Validation**: Data quality checks
- **Multi-sig Operations**: Signature collection and validation
- **On-Chain Submission**: Stellar transaction submission
- **Database Operations**: Read/write operations
- **Cache Operations**: Redis interactions
- **Webhook Deliveries**: External notifications

## Usage Examples

### Manual Span Creation

```typescript
import { TracingService } from '../services/tracingService';

// Create child span for custom operation
const span = TracingService.traceRelayerRequest(req, 'relayer-name', 'price-update');

try {
  // Business logic here
  TracingService.addLog(span, 'info', 'Processing complete');
} catch (error) {
  TracingService.finishSpan(span, error);
  throw error;
} finally {
  TracingService.finishSpan(span);
}
```

### Decorator Usage

```typescript
import { withTracing } from '../services/tracingService';

class PriceService {
  @withTracing('price_validation', { 'operation.type': 'validation' })
  async validatePrice(currency: string, rate: number) {
    // Function automatically traced
  }
}
```

### Function Wrapper

```typescript
import { executeWithTrace } from '../services/tracingService';

const result = await executeWithTrace(
  'api_request.fetch_rates',
  async () => {
    return await axios.get('https://api.example.com/rates');
  },
  { 'api.provider': 'example' }
);
```

## Monitoring and Debugging

### Trace Analysis

1. **Request Flow**: Follow trace ID through the system
2. **Latency Analysis**: Identify slow operations
3. **Error Correlation**: Find root cause of failures
4. **Service Dependencies**: Understand service interactions

### Key Metrics

- Request duration by endpoint
- API provider response times
- Database operation latency
- Cache hit/miss ratios
- On-chain submission times
- Error rates by operation type

## Performance Considerations

### Sampling

- Configurable sampling rate to reduce overhead
- Default: 100% sampling for development
- Production: Recommended 10-20% sampling

### Export Batching

- Traces exported in batches every 5 seconds
- Configurable via `TRACING_EXPORT_INTERVAL_MS`
- Graceful shutdown ensures all traces exported

### Memory Management

- Active spans tracked in memory
- Automatic cleanup on span completion
- Configurable retention policies

## Security Considerations

### Sensitive Data

- Automatic log masking applied to trace data
- Configurable field redaction
- PII filtering in headers and payloads

### Network Security

- Secure connections to trace collectors
- API key protection for cloud services
- Network access control for Jaeger

## Troubleshooting

### Common Issues

1. **Missing Traces**: Check `TRACING_ENABLED` setting
2. **Export Failures**: Verify collector endpoints and credentials
3. **High Memory**: Reduce sampling rate or export interval
4. **Missing Context**: Ensure middleware order is correct

### Debug Mode

Enable console logging for debugging:
```bash
TRACING_CONSOLE_EXPORTER=true
TRACING_ENABLED=true
```

### Health Checks

Monitor tracing system health:
- Check exporter connectivity
- Monitor export queue sizes
- Validate trace context propagation

## Migration Path

### From OpenTelemetry SDK

The current implementation is compatible with OpenTelemetry standards and can be easily migrated:

```typescript
// Future migration to OpenTelemetry SDK
import { NodeSDK } from '@opentelemetry/sdk-node';
const sdk = new NodeSDK({
  serviceName: process.env.TRACING_SERVICE_NAME,
  traceExporter: new JaegerExporter({...})
});
sdk.start();
```

### Custom Extensions

The tracing system supports custom extensions:

1. **Custom Exporters**: Implement `TraceExporter` interface
2. **Custom Decorators**: Extend tracing decorators
3. **Custom Middleware**: Add domain-specific tracing

## Best Practices

1. **Early Instrumentation**: Add tracing at application entry points
2. **Consistent Naming**: Use standardized span names and tags
3. **Error Handling**: Always finish spans, even on errors
4. **Performance**: Monitor tracing overhead and adjust sampling
5. **Security**: Review trace data for sensitive information

## Future Enhancements

1. **OpenTelemetry SDK Integration**: Full OpenTelemetry compatibility
2. **Automatic Instrumentation**: Code-based auto-instrumentation
3. **Advanced Sampling**: Adaptive sampling algorithms
4. **Trace Aggregation**: Real-time trace analytics
5. **Alerting Integration**: Trace-based alerting rules

This implementation provides comprehensive end-to-end tracing for the StellarFlow backend, enabling full visibility into data packet flow from external APIs through relayers to on-chain submission.
