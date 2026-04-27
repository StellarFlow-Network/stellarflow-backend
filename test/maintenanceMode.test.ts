import request from 'supertest';
import app from '../src/app';

describe('Maintenance Mode', () => {
  const originalEnv = process.env.MAINTENANCE_MODE;

  afterEach(() => {
    process.env.MAINTENANCE_MODE = originalEnv;
  });

  it('should return 503 for non-allowlisted endpoints when maintenance mode is enabled', async () => {
    process.env.MAINTENANCE_MODE = 'true';
    const res = await request(app).get('/api/v1/market-rates/rates');
    expect(res.status).toBe(503);
    expect(res.body).toHaveProperty('maintenance', true);
  });

  it('should allow allowlisted endpoints during maintenance', async () => {
    process.env.MAINTENANCE_MODE = 'true';
    const res = await request(app).get('/status');
    expect(res.status).not.toBe(503);
  });

  it('should allow all endpoints when maintenance mode is disabled', async () => {
    process.env.MAINTENANCE_MODE = 'false';
    const res = await request(app).get('/api/v1/market-rates/rates');
    expect(res.status).not.toBe(503);
  });
});
