import { describe, expect, it, jest } from "@jest/globals";
import { orderAnomalyThrottleMiddleware } from "../src/middleware/orderAnomalyThrottleMiddleware";

const makeReq = (overrides: Record<string, unknown> = {}) =>
  ({
    headers: {},
    ip: "1.2.3.4",
    socket: { remoteAddress: "1.2.3.4" },
    ...overrides,
  }) as never;

const makeRes = () => {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockReturnValue(res as never);
  res.json.mockReturnValue(res as never);
  return res as unknown as {
    status: jest.Mock;
    json: jest.Mock;
  };
};

describe("orderAnomalyThrottleMiddleware", () => {
  it("rejects throttled accounts with 429", async () => {
    const detector = { isThrottled: jest.fn(async () => true) };
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await orderAnomalyThrottleMiddleware(detector)(req, res as never, next);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: "ORDER_ANOMALY_THROTTLED" }),
      }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("lets unthrottled accounts through", async () => {
    const detector = { isThrottled: jest.fn(async () => false) };
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await orderAnomalyThrottleMiddleware(detector)(req, res as never, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("uses the Stellar public key header as the account identifier", async () => {
    const isThrottled = jest.fn(async () => false);
    const req = makeReq({ headers: { "x-stellar-publickey": "GPUBKEY" } });
    const res = makeRes();
    const next = jest.fn();

    await orderAnomalyThrottleMiddleware({ isThrottled })(
      req,
      res as never,
      next,
    );

    expect(isThrottled).toHaveBeenCalledWith("GPUBKEY");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("skips the check when no identifier can be resolved", async () => {
    const isThrottled = jest.fn(async () => true);
    const req = makeReq({ ip: undefined, socket: {} });
    const res = makeRes();
    const next = jest.fn();

    await orderAnomalyThrottleMiddleware({ isThrottled })(
      req,
      res as never,
      next,
    );

    expect(isThrottled).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
