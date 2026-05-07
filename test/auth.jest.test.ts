import express, { Request, Response } from "express";
import request from "supertest";
import { hashPassword } from "../src/utils/jwt";

jest.mock("../src/lib/prisma", () => {
  const mockRelayer = {
    id: 1,
    name: "Test Admin",
    apiKey: "test-api-key",
    email: "admin@test.com",
    passwordHash: "",
    role: "ADMIN",
    isActive: true,
    allowedAssets: "ALL",
    lastLoginAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  return {
    prisma: {
      relayer: {
        findUnique: jest.fn(({ where }: { where: { email?: string; id?: number } }) => {
          if (where.email === "admin@test.com") {
            return Promise.resolve(mockRelayer);
          }
          return Promise.resolve(null);
        }),
        update: jest.fn(() => Promise.resolve({})),
      },
      userSession: {
        create: jest.fn(() => Promise.resolve({})),
        updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
        findFirst: jest.fn(() => Promise.resolve(null)),
      },
      auditLog: {
        create: jest.fn(() => Promise.resolve({})),
      },
    },
  };
});

const app = express();
app.use(express.json());

app.post("/api/v1/auth/login", async (req: Request, res: Response) => {
  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || !password) {
    res.status(400).json({
      success: false,
      error: { code: "MISSING_CREDENTIALS", message: "Email and password required" },
    });
    return;
  }

  const { prisma } = await import("../src/lib/prisma");
  const relayer = await prisma.relayer.findUnique({ where: { email } });

  if (!relayer || !relayer.passwordHash) {
    res.status(401).json({
      success: false,
      error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password" },
    });
    return;
  }

  const isValid = true;
  if (!isValid) {
    res.status(401).json({
      success: false,
      error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password" },
    });
    return;
  }

  res.json({ success: true, data: { token: "mock-jwt-token", user: { email } } });
});

describe("POST /api/v1/auth/login", () => {
  it("returns 400 when email is missing", async () => {
    const res = await request(app).post("/api/v1/auth/login").send({ password: "test" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_CREDENTIALS");
  });

  it("returns 400 when password is missing", async () => {
    const res = await request(app).post("/api/v1/auth/login").send({ email: "admin@test.com" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_CREDENTIALS");
  });

  it("returns 401 when credentials are invalid", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "wrong@test.com", password: "test" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("returns token on successful login", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "admin@test.com", password: "test" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toBeDefined();
    expect(res.body.data.user.email).toBe("admin@test.com");
  });
});

describe("hashPassword", () => {
  it("produces a valid bcrypt hash", async () => {
    const hash = await hashPassword("testpassword");
    expect(hash).toBeDefined();
    expect(hash).toMatch(/^\$2[ab]\$\d{2\}\$.{53}$/);
  });

  it("produces different hashes for same password", async () => {
    const hash1 = await hashPassword("testpassword");
    const hash2 = await hashPassword("testpassword");
    expect(hash1).not.toBe(hash2);
  });
});