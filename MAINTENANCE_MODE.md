# Maintenance Mode Implementation

## Overview
This project now supports a Maintenance Mode feature, allowing the API to return HTTP 503 Service Unavailable during upgrades or maintenance windows.

## How It Works
- **Toggle Location:** The maintenance flag is controlled via the `MAINTENANCE_MODE` environment variable in the `.env` file.
- **Behavior:**
  - When `MAINTENANCE_MODE=true`, all API endpoints (except those explicitly allowlisted) will return a 503 status with a maintenance message.
  - When `MAINTENANCE_MODE=false`, the API operates normally.
- **Middleware:** A new middleware (`maintenanceMiddleware.ts`) checks the flag and enforces maintenance mode.
- **Allowlist:** Health check and status endpoints are allowlisted and remain accessible during maintenance.

## Usage
1. **Enable Maintenance Mode:**
   - Set `MAINTENANCE_MODE=true` in the `.env` file.
   - Restart the server (if using process.env directly).
2. **Disable Maintenance Mode:**
   - Set `MAINTENANCE_MODE=false` in the `.env` file.
   - Restart the server.

## Allowlisted Endpoints
- `/status`
- `/health` (if present)

## Extending Functionality
- To make the flag dynamic (e.g., toggle via DB or admin API), refactor the middleware to check the DB or cache instead of process.env.
- To allow more endpoints, add their paths to the allowlist in the middleware.

## Testing
- With maintenance mode enabled, all non-allowlisted endpoints should return 503.
- With maintenance mode disabled, all endpoints should function normally.

## Files Changed/Added
- `.env` (added/updated)
- `src/middleware/maintenanceMiddleware.ts` (added)
- `src/app.ts` or `src/index.ts` (middleware integrated)
- `MAINTENANCE_MODE.md` (this documentation)

---

For further customization or questions, see the comments in the middleware or contact the maintainers.
