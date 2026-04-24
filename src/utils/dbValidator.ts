import { execSync } from "child_process";
import prisma from "../lib/prisma";

/**
 * Validates that the database schema is in sync with Prisma schema
 * @throws Error if validation fails or schema is out of sync
 */
export async function validateDatabaseSchema(): Promise<void> {
  console.log("🔍 Validating database schema...");

  try {
    // Step 1: Run prisma validate to check schema syntax
    try {
      execSync("npx prisma validate", {
        stdio: "pipe",
        encoding: "utf-8",
      });
      console.log("Prisma schema validation passed");
    } catch (error) {
      console.error("Prisma schema validation failed");
      throw new Error(
        `Prisma schema validation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Step 2: Check if database is accessible
    try {
      await prisma.$queryRaw`SELECT 1`;
      console.log("Database connection successful");
    } catch (error) {
      console.error("Database connection failed");
      throw new Error(
        `Database connection failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Step 3: Check for pending migrations
    try {
      const result = execSync("npx prisma migrate status", {
        stdio: "pipe",
        encoding: "utf-8",
      });

      const output = result.toString();

      // Check if there are pending migrations or database is out of sync
      if (
        output.includes("Database schema is up to date") ||
        output.includes("No pending migrations")
      ) {
        console.log("Database schema is up to date");
      } else if (
        output.includes("following migration have not yet been applied") ||
        output.includes("Your database schema is not in sync")
      ) {
        console.error("Database has pending migrations");
        console.error("\nMigration status:");
        console.error(output);
        throw new Error(
          "Database schema is out of sync. Please run 'npm run db:migrate' or 'npx prisma migrate deploy' to apply pending migrations.",
        );
      } else {
        console.log("Database migration check completed");
      }
    } catch (error) {
      // If the error is from our throw above, re-throw it
      if (error instanceof Error && error.message.includes("out of sync")) {
        throw error;
      }

      // For other errors (like command not found), log warning but don't fail
      console.warn(
        "⚠️  Could not check migration status:",
        error instanceof Error ? error.message : String(error),
      );
    }

    console.log("Database validation completed successfully\n");
  } catch (error) {
    console.error("\nDatabase validation failed!");
    console.error(
      "The server cannot start because the database schema is not valid or out of sync.",
    );
    console.error("\nTo fix this issue:");
    console.error("  1. Run: npm run db:migrate");
    console.error("  2. Or run: npx prisma migrate deploy");
    console.error("  3. Or run: npm run db:push (for development)\n");
    throw error;
  }
}
