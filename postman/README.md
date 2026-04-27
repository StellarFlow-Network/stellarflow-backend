# StellarFlow Backend API Postman Collection

This directory contains a comprehensive Postman collection for testing and interacting with the StellarFlow Backend API.

## Files

- `StellarFlow_Backend_API.postman_collection.json` - Complete Postman collection with all API endpoints

## Setup Instructions

### 1. Import the Collection

1. Open Postman
2. Click "Import" in the top left
3. Select "File" tab
4. Choose `StellarFlow_Backend_API.postman_collection.json`
5. Click "Import"

### 2. Configure Environment Variables

Create a new environment in Postman with the following variables:

| Variable      | Description                          | Example Value           |
| ------------- | ------------------------------------ | ----------------------- |
| `base_url`    | Base URL of your StellarFlow backend | `http://localhost:3000` |
| `api_key`     | API key for authentication           | `your-api-key-here`     |
| `admin_token` | Admin authentication token           | `your-admin-token-here` |

### 3. Authentication

Most endpoints require API key authentication. The collection is pre-configured with:

- **API Key Auth**: Automatically included in headers for most requests
- **Admin Token**: Required for administrative endpoints (passed in Authorization header)

## API Endpoint Categories

### 🔍 Health & Status

- Health checks and system status monitoring
- Database connectivity and sync status

### 💰 Market Rates

- Retrieve current and historical price data
- Currency-specific rate queries
- Price review and approval workflows
- Cache management

### 📊 Price History

- Historical price data with flexible date ranges
- Support for 1d, 7d, 30d, 90d ranges
- Custom date range queries

### 🔐 Price Updates (Multi-Sig)

- Multi-signature price update workflows
- Signature collection and validation
- Remote server coordination
- Stellar network submission tracking

### 📈 Statistics

- Relayer performance metrics
- Volume statistics and activity reports
- Uptime and success rate tracking

### 🧠 Intelligence

- Price volatility analysis
- 24-hour price change calculations
- Stale currency detection

### 🪙 Assets

- Active currency listings
- Asset metadata and information

### 🔄 Derived Assets

- Synthetic cross-currency rates
- NGN/GHS specific calculations

### ✅ Sanity Check

- Price validation against external sources
- Deviation threshold monitoring
- Multi-currency sanity checks

### 💾 Cache Management

- Cache performance metrics
- Cache clearing operations
- Health status monitoring

### ⚙️ System Control (Admin)

- System halt and upgrade consensus workflows
- Administrative signature collection
- Consensus request management

### 🔄 System Failover

- Regional backend switching
- Failover status monitoring
- Manual override controls

### 👑 Admin Operations

- Monthly report generation
- Secret key management
- Relayer registry management
- Rate limiting configuration

### 📚 Documentation

- Swagger/OpenAPI documentation access

## Usage Tips

### Authentication

- Set your API key in the environment variables
- Admin endpoints require additional Bearer token authentication
- Some endpoints may require specific permissions

### Variables

- Use collection variables for common values like currency codes
- Update path variables in requests (e.g., `:currency`, `:asset`)
- Query parameters are pre-configured with sensible defaults

### Testing Workflows

1. Start with health checks to verify system status
2. Test basic market rate queries
3. Explore historical data and statistics
4. Try admin operations (with proper authentication)

### Error Handling

- Check response status codes and error messages
- Some endpoints return structured error responses
- Authentication failures return 403/401 status codes

## Environment Examples

### Local Development

```
base_url: http://localhost:3000
api_key: dev-api-key-123
admin_token: dev-admin-token-456
```

### Staging

```
base_url: https://staging-api.stellarflow.network
api_key: staging-api-key
admin_token: staging-admin-token
```

### Production

```
base_url: https://api.stellarflow.network
api_key: prod-api-key
admin_token: prod-admin-token
```

## Contributing

When the API changes:

1. Update the relevant route files in the codebase
2. Regenerate this collection by running the collection generation script
3. Test all endpoints in the updated collection
4. Update this README if new categories are added

## Support

For API documentation and support, refer to:

- `/api/v1/docs` - Interactive API documentation
- Backend logs for detailed error information
- Team documentation for authentication and permissions
