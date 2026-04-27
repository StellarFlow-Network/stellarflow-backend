import { execSync } from "node:child_process";
import { validateDatabaseSchema } from "../src/utils/dbValidator";
import prisma from "../src/lib/prisma";

// Mock dependencies
jest.mock("node:child_process");
jest.mock("../src/lib/prisma", () => ({
  __esModule: true,
  default: {
    $queryRaw: jest.fn(),
  },
}));

const mockedExecSync = execSync as jest.MockedFunction<typeof execSync>;
const mockedPrisma = prisma as jest.Mocked<typeof prisma>;

describe("Database Validator", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Suppress console output during tests
    jest.spyOn(console, "log").mockImplementation();
    jest.spyOn(console, "error").mockImplementation();
    jest.spyOn(console, "warn").mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("validateDatabaseSchema", () => {
    it("should pass when schema is valid and up to date", async () => {
      // Mock successful prisma validate
      mockedExecSync.mockReturnValueOnce(Buffer.from("Schema is valid"));

      // Mock successful database connection
      mockedPrisma.$queryRaw.mockResolvedValueOnce([{ "?column?": 1 }]);

      // Mock successful migration status
      mockedExecSync.mockReturnValueOnce(
        Buffer.from("Database schema is up to date"),
      );

      await expect(validateDatabaseSchema()).resolves.not.toThrow();
    });

    it("should throw error when prisma validate fails", async () => {
      // Mock failed prisma validate
      mockedExecSync.mockImplementationOnce(() => {
        throw new Error("Invalid schema");
      });

      await expect(validateDatabaseSchema()).rejects.toThrow(
        "Prisma schema validation failed",
      );
    });

    it("should throw error when database connection fails", async () => {
      // Mock successful prisma validate
      mockedExecSync.mockReturnValueOnce(Buffer.from("Schema is valid"));

      // Mock failed database connection
      mockedPrisma.$queryRaw.mockRejectedValueOnce(
        new Error("Connection refused"),
      );

      await expect(validateDatabaseSchema()).rejects.toThrow(
        "Database connection failed",
      );
    });

    it("should throw error when there are pending migrations", async () => {
      // Mock successful prisma validate
      mockedExecSync.mockReturnValueOnce(Buffer.from("Schema is valid"));

      // Mock successful database connection
      mockedPrisma.$queryRaw.mockResolvedValueOnce([{ "?column?": 1 }]);

      // Mock pending migrations
      mockedExecSync.mockReturnValueOnce(
        Buffer.from(
          "Your database schema is not in sync with your migration history",
        ),
      );

      await expect(validateDatabaseSchema()).rejects.toThrow(
        "Database schema is out of sync",
      );
    });

    it("should pass when migration status check fails but other checks pass", async () => {
      // Mock successful prisma validate
      mockedExecSync.mockReturnValueOnce(Buffer.from("Schema is valid"));

      // Mock successful database connection
      mockedPrisma.$queryRaw.mockResolvedValueOnce([{ "?column?": 1 }]);

      // Mock migration status command failure (e.g., command not found)
      mockedExecSync.mockImplementationOnce(() => {
        throw new Error("Command not found");
      });

      // Should not throw, just warn
      await expect(validateDatabaseSchema()).resolves.not.toThrow();
    });

    it("should pass when no pending migrations message is present", async () => {
      // Mock successful prisma validate
      mockedExecSync.mockReturnValueOnce(Buffer.from("Schema is valid"));

      // Mock successful database connection
      mockedPrisma.$queryRaw.mockResolvedValueOnce([{ "?column?": 1 }]);

      // Mock no pending migrations
      mockedExecSync.mockReturnValueOnce(
        Buffer.from("No pending migrations"),
      );

      await expect(validateDatabaseSchema()).resolves.not.toThrow();
    });
  });
});
