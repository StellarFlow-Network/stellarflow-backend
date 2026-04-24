import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import dotenv from "dotenv";
// Ensure environment variables are loaded
dotenv.config();
const globalForPrisma = globalThis;
// Lazy initialization using a Proxy to prevent crashes during imports in test environments
export const prisma = new Proxy({}, {
    get(target, prop, receiver) {
        if (!globalForPrisma.prisma) {
            // Ensure environment variables are loaded before initialization
            dotenv.config();
            const connectionString = process.env.DATABASE_URL;
            if (!connectionString) {
                throw new Error("DATABASE_URL must be defined");
            }
            const pool = new pg.Pool({ connectionString });
            const adapter = new PrismaPg(pool);
            globalForPrisma.prisma = new PrismaClient({ adapter });
        }
        const value = globalForPrisma.prisma[prop];
        if (typeof value === "function") {
            return value.bind(globalForPrisma.prisma);
        }
        return value;
    },
});
export default prisma;
//# sourceMappingURL=prisma.js.map