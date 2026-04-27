import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
import { ApiScope } from "../types/apiKey.types";
 
const prisma = new PrismaClient();
 
// ------------------------------------------------------------------
// createApiKey
// ------------------------------------------------------------------
 
export interface CreateApiKeyOptions {
  label?: string;
  scopes: ApiScope[];         // e.g. ["read"] or ["read", "write"]
  ownerId?: string;
  expiresInDays?: number;     // omit = never expires
}
 
export interface CreatedApiKey {
  rawKey: string;             // shown ONCE — store it securely
  id: string;
  label?: string | null;
  scopes: ApiScope[];
  expiresAt?: Date | null;
}
 
/**
 * Generate a new API key, hash it, and persist it to the database.
 *
 * The **raw key is returned exactly once** — it is never stored in
 * plain text. Give it to the requester immediately and don't log it.
 *
 * @example
 * // Read-only key (for a public dashboard)
 * const key = await createApiKey({ label: "dashboard", scopes: ["read"] });
 *
 * // Full-access key (for the internal oracle submitter)
 * const key = await createApiKey({ label: "oracle-node-1", scopes: ["read", "write"] });
 */
export async function createApiKey(
  opts: CreateApiKeyOptions
): Promise<CreatedApiKey> {
  // 32 random bytes → 64 char hex string
  const rawKey = `sf_${crypto.randomBytes(32).toString("hex")}`;
  const hashed = crypto.createHash("sha256").update(rawKey).digest("hex");
 
  const expiresAt = opts.expiresInDays
    ? new Date(Date.now() + opts.expiresInDays * 86_400_000)
    : null;
 
  const record = await prisma.apiKey.create({
    data: {
      key: hashed,
      label: opts.label ?? null,
      scopes: opts.scopes,
      ownerId: opts.ownerId ?? null,
      isActive: true,
      expiresAt,
    },
  });
 
  return {
    rawKey,               // ← hand this to the user, never log it
    id: record.id,
    label: record.label,
    scopes: record.scopes as ApiScope[],
    expiresAt: record.expiresAt,
  };
}
 
// ------------------------------------------------------------------
// revokeApiKey
// ------------------------------------------------------------------
 
/**
 * Soft-delete an API key by setting isActive = false.
 * The row is kept for audit history.
 */
export async function revokeApiKey(id: string): Promise<void> {
  await prisma.apiKey.update({
    where: { id },
    data: { isActive: false },
  });
}
 
// ------------------------------------------------------------------
// Seed script helper (run via: npx ts-node src/utils/apiKey.utils.ts)
// ------------------------------------------------------------------
 
async function seed() {
  console.log("🔑 Seeding API keys …\n");
 
  const readKey = await createApiKey({
    label: "read-only (dashboard / consumers)",
    scopes: ["read"],
  });
 
  const writeKey = await createApiKey({
    label: "read-write (oracle price submitter)",
    scopes: ["read", "write"],
  });
 
  console.log("✅ Read-only key");
  console.log("   Label  :", readKey.label);
  console.log("   Scopes :", readKey.scopes.join(", "));
  console.log("   Key    :", readKey.rawKey);   // save this!
  console.log();
 
  console.log("✅ Read-write key");
  console.log("   Label  :", writeKey.label);
  console.log("   Scopes :", writeKey.scopes.join(", "));
  console.log("   Key    :", writeKey.rawKey);  // save this!
  console.log();
 
  console.log("⚠️  Keys are shown only once. Copy them now.");
 
  await prisma.$disconnect();
}
 
// Run when executed directly
if (require.main === module) {
  seed().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
