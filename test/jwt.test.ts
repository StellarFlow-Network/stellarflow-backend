import {
  generateToken,
  verifyToken,
  hashPassword,
  verifyPassword,
  getJwtSecret,
  getJwtExpiryHours,
} from "../src/utils/jwt";

describe("JWT Utilities", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, JWT_SECRET: "test-secret-key-min-32-characters-long!!", JWT_EXPIRY_HOURS: "1" };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("getJwtSecret", () => {
    it("returns secret from environment", () => {
      expect(getJwtSecret()).toBe("test-secret-key-min-32-characters-long!!");
    });

    it("throws when JWT_SECRET not set", () => {
      delete process.env.JWT_SECRET;
      expect(() => getJwtSecret()).toThrow("JWT_SECRET not configured");
    });
  });

  describe("getJwtExpiryHours", () => {
    it("parses JWT_EXPIRY_HOURS from env", () => {
      expect(getJwtExpiryHours()).toBe(1);
    });

    it("defaults to 24 when not set", () => {
      delete process.env.JWT_EXPIRY_HOURS;
      expect(getJwtExpiryHours()).toBe(24);
    });

    it("defaults to 24 when invalid", () => {
      process.env.JWT_EXPIRY_HOURS = "invalid";
      expect(getJwtExpiryHours()).toBe(24);
    });
  });

  describe("generateToken", () => {
    it("generates a valid JWT token", () => {
      const token = generateToken({ userId: 1, email: "test@test.com", role: "ADMIN" });
      expect(token).toBeDefined();
      expect(typeof token).toBe("string");
      expect(token.split(".").length).toBe(3);
    });

    it("contains payload in token", () => {
      const token = generateToken({ userId: 1, email: "test@test.com", role: "ADMIN" });
      const payload = verifyToken(token);
      expect(payload?.userId).toBe(1);
      expect(payload?.email).toBe("test@test.com");
      expect(payload?.role).toBe("ADMIN");
    });
  });

  describe("verifyToken", () => {
    it("returns payload for valid token", () => {
      const token = generateToken({ userId: 1, email: "test@test.com", role: "ADMIN" });
      const payload = verifyToken(token);
      expect(payload?.userId).toBe(1);
    });

    it("returns null for invalid token", () => {
      const payload = verifyToken("invalid.token.here");
      expect(payload).toBeNull();
    });

    it("returns null for tampered token", () => {
      const token = generateToken({ userId: 1, email: "test@test.com", role: "ADMIN" });
      const tampered = token.slice(0, -5) + "xxxxx";
      const payload = verifyToken(tampered);
      expect(payload).toBeNull();
    });
  });

  describe("hashPassword", () => {
    it("produces valid bcrypt hash", async () => {
      const hash = await hashPassword("testpassword");
      expect(hash).toMatch(/^\$2[ab]\$\d{2\}\$.{53}$/);
    });

    it("produces different hashes for same password", async () => {
      const hash1 = await hashPassword("testpassword");
      const hash2 = await hashPassword("testpassword");
      expect(hash1).not.toBe(hash2);
    });
  });

  describe("verifyPassword", () => {
    it("returns true for correct password", async () => {
      const hash = await hashPassword("testpassword");
      const result = await verifyPassword("testpassword", hash);
      expect(result).toBe(true);
    });

    it("returns false for incorrect password", async () => {
      const hash = await hashPassword("testpassword");
      const result = await verifyPassword("wrongpassword", hash);
      expect(result).toBe(false);
    });
  });
});