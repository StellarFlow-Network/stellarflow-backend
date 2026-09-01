import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Prisma CLI schema/migration operations use the direct database path;
    // application runtime traffic uses DATABASE_URL through PgBouncer.
    url: process.env.DIRECT_DATABASE_URL || env("DATABASE_URL"),
  },
});
