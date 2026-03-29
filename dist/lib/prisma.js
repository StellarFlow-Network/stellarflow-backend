// Prisma Client Singleton
// Prevents multiple instances during development hot-reloading
import { PrismaClient } from "@prisma/client";
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
            globalForPrisma.prisma = new PrismaClient();
        }
        const value = globalForPrisma.prisma[prop];
        if (typeof value === "function") {
            return value.bind(globalForPrisma.prisma);
        }
        return value;
    },
});
if (process.env.NODE_ENV !== "production") {
    // We still want to preserve the singleton behavior
    // Note: globalForPrisma.prisma will be populated on first access
}
export default prisma;
//# sourceMappingURL=prisma.js.map