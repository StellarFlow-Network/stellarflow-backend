import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Request, Response } from 'express';
import historyRouter from '../src/routes/history';

// Mock Prisma
const mockPrisma = {
  priceHistory: {
    findMany: vi.fn(),
  },
};

// Mock the prisma module
vi.mock('../src/lib/prisma', () => ({
  default: mockPrisma,
}));

describe('GET /api/v1/history/:asset', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;

  beforeEach(() => {
    mockRequest = {
      params: { asset: 'NGN' },
      query: {},
    };
    mockResponse = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    vi.clearAllMocks();
  });

  it('should filter by from and to dates', async () => {
    const from = '2024-01-01T00:00:00Z';
    const to = '2024-01-07T23:59:59Z';
    mockRequest.query = { from, to };

    mockPrisma.priceHistory.findMany.mockResolvedValue([
      { timestamp: new Date(from), rate: 100, source: 'test' }
    ]);

    const handler = historyRouter.stack.find(
      (layer: any) => layer.route?.path === '/:asset'
    )?.route?.stack[0]?.handle;

    await handler(mockRequest as Request, mockResponse as Response);

    expect(mockPrisma.priceHistory.findMany).toHaveBeenCalledWith({
      where: {
        currency: 'NGN',
        timestamp: {
          gte: new Date(from),
          lte: new Date(to),
        },
      },
      orderBy: { timestamp: "asc" },
      select: { timestamp: true, rate: true, source: true },
    });

    expect(mockResponse.json).toHaveBeenCalledWith({
      success: true,
      asset: 'NGN',
      range: 'custom',
      data: [{
        timestamp: new Date(from).toISOString(),
        rate: 100,
        source: 'test'
      }]
    });
  });

  it('should use range if from/to are not provided', async () => {
    mockRequest.query = { range: '1d' };

    mockPrisma.priceHistory.findMany.mockResolvedValue([
      { timestamp: new Date(), rate: 100, source: 'test' }
    ]);

    const handler = historyRouter.stack.find(
      (layer: any) => layer.route?.path === '/:asset'
    )?.route?.stack[0]?.handle;

    await handler(mockRequest as Request, mockResponse as Response);

    expect(mockPrisma.priceHistory.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        currency: 'NGN',
        timestamp: expect.objectContaining({
          gte: expect.any(Date),
        }),
      }),
    }));
  });

  it('should return 400 for invalid dates', async () => {
    mockRequest.query = { from: 'invalid-date' };

    const handler = historyRouter.stack.find(
      (layer: any) => layer.route?.path === '/:asset'
    )?.route?.stack[0]?.handle;

    await handler(mockRequest as Request, mockResponse as Response);

    expect(mockResponse.status).toHaveBeenCalledWith(400);
    expect(mockResponse.json).toHaveBeenCalledWith({
      success: false,
      error: "Invalid 'from' date"
    });
  });

  it('should return 404 when no records found', async () => {
    mockRequest.query = { from: '2024-01-01', to: '2024-01-07' };
    mockPrisma.priceHistory.findMany.mockResolvedValue([]);

    const handler = historyRouter.stack.find(
      (layer: any) => layer.route?.path === '/:asset'
    )?.route?.stack[0]?.handle;

    await handler(mockRequest as Request, mockResponse as Response);

    expect(mockResponse.status).toHaveBeenCalledWith(404);
    expect(mockResponse.json).toHaveBeenCalledWith({
      success: false,
      error: "No history found for NGN in the specified timeframe"
    });
  });
});
