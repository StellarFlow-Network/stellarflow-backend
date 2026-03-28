import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Request, Response } from 'express';
import statsRouter from '../src/routes/stats';

// Mock Prisma
const mockPrisma = {
  priceHistory: {
    count: vi.fn(),
    findMany: vi.fn(),
  },
  onChainPrice: {
    count: vi.fn(),
  },
  providerReputation: {
    findMany: vi.fn(),
  },
};

// Mock the prisma module
vi.mock('../src/lib/prisma', () => ({
  default: mockPrisma,
}));

describe('GET /api/v1/stats/volume', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;

  beforeEach(() => {
    mockRequest = {
      query: {},
    };
    mockResponse = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    vi.clearAllMocks();
  });

  it('should return volume statistics for a given date', async () => {
    // Mock data
    mockPrisma.priceHistory.count
      .mockResolvedValueOnce(150) // price history count
      .mockResolvedValueOnce(5);  // active currencies count
    
    mockPrisma.onChainPrice.count.mockResolvedValue(25); // on-chain price count
    
    mockPrisma.providerReputation.findMany.mockResolvedValue([
      {
        providerName: 'CoinGecko',
        totalRequests: 1000,
        successfulRequests: 950,
        failedRequests: 50,
        lastSuccess: new Date(),
        lastFailure: null,
      },
      {
        providerName: 'ExchangeRateAPI',
        totalRequests: 500,
        successfulRequests: 480,
        failedRequests: 20,
        lastSuccess: new Date(),
        lastFailure: null,
      },
    ]);

    mockPrisma.priceHistory.findMany
      .mockResolvedValueOnce([
        { currency: 'NGN' },
        { currency: 'KES' },
        { currency: 'GHS' },
        { currency: 'NGN' },
        { currency: 'KES' },
      ])
      .mockResolvedValueOnce([
        { source: 'CoinGecko' },
        { source: 'ExchangeRateAPI' },
      ]);

    mockRequest.query = { date: '2024-01-15' };

    // Get the volume handler
    const volumeHandler = statsRouter.stack.find(
      (layer: any) => layer.route?.path === '/volume'
    )?.route?.stack[0]?.handle;

    expect(volumeHandler).toBeDefined();

    await volumeHandler(mockRequest as Request, mockResponse as Response);

    expect(mockResponse.json).toHaveBeenCalledWith({
      success: true,
      data: expect.objectContaining({
        date: '2024-01-15',
        dataPoints: {
          priceHistoryEntries: 150,
          onChainConfirmations: 25,
          total: 175,
        },
        apiRequests: {
          total: 1500,
          successful: 1430,
          failed: 70,
          successRate: '95.33%',
        },
        activity: {
          activeCurrencies: 3, // NGN, KES, GHS (unique)
          activeDataSources: 2, // CoinGecko, ExchangeRateAPI
          currencies: ['NGN', 'KES', 'GHS'],
          sources: ['CoinGecko', 'ExchangeRateAPI'],
        },
        providers: expect.arrayContaining([
          expect.objectContaining({
            name: 'CoinGecko',
            totalRequests: 1000,
            successRate: '95.00%',
          }),
          expect.objectContaining({
            name: 'ExchangeRateAPI',
            totalRequests: 500,
            successRate: '96.00%',
          }),
        ]),
      }),
    });
  });

  it('should handle invalid date format', async () => {
    mockRequest.query = { date: 'invalid-date' };

    const volumeHandler = statsRouter.stack.find(
      (layer: any) => layer.route?.path === '/volume'
    )?.route?.stack[0]?.handle;

    await volumeHandler(mockRequest as Request, mockResponse as Response);

    expect(mockResponse.status).toHaveBeenCalledWith(400);
    expect(mockResponse.json).toHaveBeenCalledWith({
      success: false,
      error: "Invalid date format. Use YYYY-MM-DD format.",
    });
  });

  it('should default to today when no date is provided', async () => {
    mockPrisma.priceHistory.count.mockResolvedValue(0);
    mockPrisma.onChainPrice.count.mockResolvedValue(0);
    mockPrisma.providerReputation.findMany.mockResolvedValue([]);
    mockPrisma.priceHistory.findMany.mockResolvedValue([]);

    const volumeHandler = statsRouter.stack.find(
      (layer: any) => layer.route?.path === '/volume'
    )?.route?.stack[0]?.handle;

    await volumeHandler(mockRequest as Request, mockResponse as Response);

    expect(mockResponse.json).toHaveBeenCalledWith({
      success: true,
      data: expect.objectContaining({
        date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), // Today's date
      }),
    });
  });
});
