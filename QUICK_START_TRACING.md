# Quick Start Guide: End-to-End Tracing

## Overview

This guide helps you quickly set up and use the end-to-end tracing system for monitoring data packets as they flow from external API providers through relayers to on-chain submission.

## 1. Enable Tracing

Add these environment variables to your `.env` file:

```bash
# Enable tracing
TRACING_ENABLED=true
TRACING_SERVICE_NAME=stellarflow-backend

# Console exporter (for development)
TRACING_CONSOLE_EXPORTER=true

# Optional: Jaeger exporter
TRACING_JAEGER_ENDPOINT=http://localhost:14268/api/traces

# Optional: Honeycomb exporter
TRACING_HONEYCOMB_ENDPOINT=https://api.honeycomb.io/v1/events
TRACING_HONEYCOMB_API_KEY=your_api_key_here
TRACING_HONEYCOMB_DATASET=stellarflow
```

## 2. Start the Application

```bash
npm run dev
```

You should see tracing initialization messages:
```
[Tracing] Console exporter enabled
[Tracing] Initialized with service name: stellarflow-backend
[Tracing] Export interval: 5000ms
```

## 3. Make a Test Request

Send a request to any API endpoint:

```bash
curl -H "Authorization: Bearer your_api_key" \
     http://localhost:3000/api/v1/market-rates/rates
```

## 4. View Traces

### Console Output (Development)

You'll see trace output in your console:
```
[Trace] GET /api/v1/market-rates/rates - 45ms - a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6:a1b2c3d4e5f6g7h8
[Trace] Tags: { http.method: 'GET', http.url: '/api/v1/market-rates/rates', ... }
[Trace] database.query - 12ms - a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6:b2c3d4e5f6g7h8i9j0
[Trace] api_request.external_api - 89ms - a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6:c3d4e5f6g7h8i9j0k
```

### Jaeger UI (If configured)

1. Open Jaeger UI: http://localhost:16686
2. Select service: `stellarflow-backend`
3. Click "Find Traces" to see recent requests
4. Click on any trace to see the full span tree

### Honeycomb (If configured)

1. Log into Honeycomb.io
2. Select your dataset: `stellarflow`
3. View traces and create queries

## 5. Understanding Trace Flow

A typical trace shows the complete data flow:

```
├── GET /api/v1/market-rates/rates (Root Span)
│   ├── relayer.request_validation
│   ├── api_request.external_provider
│   │   ├── HTTP GET https://api.example.com/rates
│   │   └── response_processing
│   ├── price_validation
│   ├── database.query
│   └── cache.set
```

## 6. Common Trace Patterns

### Successful Request Flow
```
HTTP Request → Relayer Validation → API Call → Data Processing → Storage → Response
```

### Error Flow
```
HTTP Request → API Call → Error → Error Handling → Error Response
```

### Multi-sig Flow
```
Request → Multi-sig Creation → Signature Collection → On-chain Submission → Confirmation
```

## 7. Adding Custom Tracing

### Manual Span Creation

```typescript
import { TracingService } from '../services/tracingService';

// In your route handler
router.post('/process', async (req, res) => {
  const span = TracingService.traceRelayerRequest(req, 'my-relayer', 'process-data');
  
  try {
    // Your business logic
    TracingService.addLog(span, 'info', 'Processing started');
    
    const result = await processData(req.body);
    
    TracingService.addLog(span, 'info', 'Processing completed');
    TracingService.finishSpan(span);
    
    res.json({ success: true, data: result });
  } catch (error) {
    TracingService.finishSpan(span, error);
    res.status(500).json({ error: error.message });
  }
});
```

### Decorator Usage

```typescript
import { withTracing } from '../services/tracingService';

class PriceService {
  @withTracing('price_fetch', { 'provider': 'external_api' })
  async fetchPrice(currency: string) {
    // Automatically traced
    return await axios.get(`https://api.example.com/rates/${currency}`);
  }
}
```

## 8. Troubleshooting

### No Traces Visible

1. Check `TRACING_ENABLED=true`
2. Verify middleware is loaded in `app.ts`
3. Check console for initialization errors

### Missing Context in HTTP Requests

1. Ensure `tracingMiddleware` is loaded before other middleware
2. Check `axiosTracingMiddleware` is loaded
3. Verify axios interceptors are set up

### Export Failures

1. Check collector endpoint URLs
2. Verify network connectivity
3. Check API keys for cloud services

### High Memory Usage

1. Reduce `TRACING_SAMPLING_RATE`
2. Decrease `TRACING_EXPORT_INTERVAL_MS`
3. Check for unfinished spans

## 9. Production Setup

### Jaeger Setup

```bash
# Using Docker
docker run -d --name jaeger \
  -e COLLECTOR_OTLP_ENABLED=true \
  -p 16686:16686 \
  -p 14268:14268 \
  jaegertracing/all-in-one:latest
```

### Environment Configuration

```bash
# Production settings
TRACING_ENABLED=true
TRACING_CONSOLE_EXPORTER=false
TRACING_JAEGER_ENDPOINT=http://jaeger:14268/api/traces
TRACING_SAMPLING_RATE=0.1  # 10% sampling
TRACING_EXPORT_INTERVAL_MS=10000
```

## 10. Key Metrics to Monitor

- **Request Duration**: Average time per endpoint
- **API Provider Latency**: External API response times
- **Database Query Time**: Database operation performance
- **Cache Hit Rate**: Cache effectiveness
- **Error Rates**: Failure frequency by operation
- **On-chain Submission Time**: Stellar transaction speed

## 11. Best Practices

1. **Use Consistent Naming**: Standardize span names and tags
2. **Add Context**: Include relevant business context in tags
3. **Handle Errors**: Always finish spans, even on errors
4. **Monitor Performance**: Watch tracing overhead
5. **Sample Appropriately**: Adjust sampling based on traffic

## 12. Next Steps

1. **Set up Dashboards**: Create monitoring dashboards
2. **Configure Alerts**: Set up trace-based alerts
3. **Analyze Performance**: Identify optimization opportunities
4. **Extend Coverage**: Add tracing to more operations
5. **Integrate with Monitoring**: Connect to existing monitoring tools

This quick start guide should help you get the tracing system running and understand the data flow through your application. For more detailed information, see the full implementation documentation.
