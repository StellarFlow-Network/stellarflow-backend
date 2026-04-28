import { initializeOpenTelemetry } from '../lib/tracing';

/**
 * Tracing configuration interface
 */
export interface TracingConfig {
  enabled: boolean;
  serviceName: string;
  exporters: {
    console?: boolean;
    jaeger?: {
      endpoint: string;
    };
    honeycomb?: {
      endpoint: string;
      apiKey: string;
      dataset: string;
    };
  };
  exportIntervalMs: number;
  samplingRate?: number;
}

/**
 * Default tracing configuration
 */
const DEFAULT_CONFIG: TracingConfig = {
  enabled: process.env.TRACING_ENABLED === 'true',
  serviceName: process.env.TRACING_SERVICE_NAME || 'stellarflow-backend',
  exporters: {
    console: process.env.TRACING_CONSOLE_EXPORTER === 'true',
    ...(process.env.TRACING_JAEGER_ENDPOINT && {
      jaeger: {
        endpoint: process.env.TRACING_JAEGER_ENDPOINT
      }
    }),
    ...(process.env.TRACING_HONEYCOMB_ENDPOINT && process.env.TRACING_HONEYCOMB_API_KEY && {
      honeycomb: {
        endpoint: process.env.TRACING_HONEYCOMB_ENDPOINT,
        apiKey: process.env.TRACING_HONEYCOMB_API_KEY,
        dataset: process.env.TRACING_HONEYCOMB_DATASET || 'stellarflow'
      }
    })
  },
  exportIntervalMs: parseInt(process.env.TRACING_EXPORT_INTERVAL_MS || '5000'),
  samplingRate: parseFloat(process.env.TRACING_SAMPLING_RATE || '1.0')
};

/**
 * Initialize OpenTelemetry tracing based on environment configuration
 */
export function initializeTracing(): void {
  const config = { ...DEFAULT_CONFIG };

  if (!config.enabled) {
    console.log('[Tracing] Tracing is disabled');
    return;
  }

  // Map legacy config to OpenTelemetry config
  const otelConfig = {
    serviceName: config.serviceName,
    consoleExporter: config.exporters.console,
    jaegerEndpoint: config.exporters.jaeger?.endpoint,
    honeycombEndpoint: config.exporters.honeycomb?.endpoint,
    honeycombApiKey: config.exporters.honeycomb?.apiKey,
    honeycombDataset: config.exporters.honeycomb?.dataset,
  };

  initializeOpenTelemetry(otelConfig);

  console.log(`[Tracing] OpenTelemetry SDK initialized with service name: ${config.serviceName}`);
  
  if (config.samplingRate && config.samplingRate < 1.0) {
    console.log(`[Tracing] Sampling rate: ${(config.samplingRate * 100).toFixed(1)}%`);
  }
}

/**
 * Get current tracing configuration
 */
export function getTracingConfig(): TracingConfig {
  return { ...DEFAULT_CONFIG };
}

/**
 * Validate tracing configuration
 */
export function validateTracingConfig(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const config = getTracingConfig();

  if (!config.enabled) {
    return { valid: true, errors: [] };
  }

  // Validate service name
  if (!config.serviceName || config.serviceName.trim().length === 0) {
    errors.push('TRACING_SERVICE_NAME is required when tracing is enabled');
  }

  // Validate Jaeger configuration
  if (config.exporters.jaeger) {
    try {
      new URL(config.exporters.jaeger.endpoint);
    } catch {
      errors.push('TRACING_JAEGER_ENDPOINT must be a valid URL');
    }
  }

  // Validate Honeycomb configuration
  if (config.exporters.honeycomb) {
    if (!config.exporters.honeycomb.apiKey || config.exporters.honeycomb.apiKey.trim().length === 0) {
      errors.push('TRACING_HONEYCOMB_API_KEY is required when Honeycomb exporter is enabled');
    }

    try {
      new URL(config.exporters.honeycomb.endpoint);
    } catch {
      errors.push('TRACING_HONEYCOMB_ENDPOINT must be a valid URL');
    }
  }

  // Validate export interval
  if (config.exportIntervalMs < 1000) {
    errors.push('TRACING_EXPORT_INTERVAL_MS must be at least 1000ms');
  }

  // Validate sampling rate
  if (config.samplingRate !== undefined && (config.samplingRate < 0 || config.samplingRate > 1)) {
    errors.push('TRACING_SAMPLING_RATE must be between 0.0 and 1.0');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Environment variable documentation
 */
export const TRACING_ENV_DOCS = {
  TRACING_ENABLED: 'Enable/disable tracing (true/false)',
  TRACING_SERVICE_NAME: 'Name of the service for tracing identification',
  TRACING_CONSOLE_EXPORTER: 'Enable console exporter for development (true/false)',
  TRACING_JAEGER_ENDPOINT: 'Jaeger collector endpoint URL (e.g., http://localhost:14268/api/traces)',
  TRACING_HONEYCOMB_ENDPOINT: 'Honeycomb API endpoint URL (e.g., https://api.honeycomb.io/v1/events)',
  TRACING_HONEYCOMB_API_KEY: 'Honeycomb API key for authentication',
  TRACING_HONEYCOMB_DATASET: 'Honeycomb dataset name (default: stellarflow)',
  TRACING_EXPORT_INTERVAL_MS: 'Interval in milliseconds for exporting traces (default: 5000)',
  TRACING_SAMPLING_RATE: 'Sampling rate for traces (0.0-1.0, default: 1.0)'
};
