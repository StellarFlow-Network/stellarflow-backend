import { toStroops } from "../src/utils/stroops";

describe("Normalizer math (toStroops) for NGN vs XLM decimal scenarios", () => {
  test("XLM: whole unit converts to 10,000,000 stroops", () => {
    expect(toStroops(1)).toBe(10_000_000);
  });

  test("XLM: 7-decimal minimum unit converts to 1 stroop", () => {
    expect(toStroops(0.0000001)).toBe(1);
  });

  test("XLM: string input preserves precision for common decimals", () => {
    expect(toStroops("0.1")).toBe(1_000_000);
  });

  test("XLM: 1.5 converts exactly", () => {
    expect(toStroops(1.5)).toBe(15_000_000);
  });

  test("XLM: rounding half-up at 8th decimal place (0.00000005 -> 1 stroop)", () => {
    expect(toStroops(0.00000005)).toBe(1);
  });

  test("XLM: rounding down below half at 8th decimal place (0.00000004 -> 0 stroops)", () => {
    expect(toStroops(0.00000004)).toBe(0);
  });

  test("NGN-style: 2-decimal value converts deterministically (1500.00)", () => {
    expect(toStroops(1500.0)).toBe(15_000_000_000);
  });

  test("NGN-style: fractional cents still round correctly (1500.005)", () => {
    expect(toStroops(1500.005)).toBe(15_000_050_000);
  });

  test("NGN-style: typical FX rate with many decimals rounds correctly", () => {
    expect(toStroops(1532.1234567)).toBe(15_321_234_567);
  });

  test("XLM: large values remain safe within JS integer range for realistic prices", () => {
    // 9,000 XLM in stroops = 90,000,000,000 (< Number.MAX_SAFE_INTEGER)
    expect(toStroops(9000)).toBe(90_000_000_000);
  });
});

