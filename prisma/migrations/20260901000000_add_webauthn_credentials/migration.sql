-- WebAuthn / Passkey authentication for relayer wallet administration.
-- Stores passkey credential public keys and short-lived challenge seeds.

-- Registered WebAuthn credentials (passkeys) bound to an administrator.
CREATE TABLE "WebAuthnCredential" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "deviceType" TEXT NOT NULL,
    "backedUp" BOOLEAN NOT NULL DEFAULT FALSE,
    "createdAt" TIMESTAMPZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMPZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPZ NULL,
    CONSTRAINT "WebAuthnCredential_pk" PRIMARY KEY ("id"),
    CONSTRAINT "WebAuthnCredential_credentialId_key" UNIQUE ("credentialId")
);

CREATE INDEX "WebAuthnCredential_adminId_idx" ON "WebAuthnCredential" ("adminId");

-- Single-use, expiring challenge seeds issued for registration and assertion.
CREATE TABLE "WebAuthnChallenge" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "challenge" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "rp"ID TEXT NOT NULL,
    "expiresAt" TIMESTAMPZ NOT NULL,
    "consumedAt" TIMESTAMPZ NULL,
    "createdAt" TIMESTAMPZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebAuthnChallenge_pk" PRIMARY KEY ("id"),
    CONSTRAINT "WebAuthnChallenge_type_check" CHECK ("type" IN ('registration', 'authentication'))
);

CREATE UNIQUE INDEX "WebAuthnChallenge_challenge_key" ON "WebAuthnChallenge" ("challenge");

CREATE INDEX "WebAuthnChallenge_adminId_expiresAt_idx" ON "WebAuthnChallenge" ("adminId", "expiresAt");

-- Audit trail of WebAuthn-attested administrative actions (e.g. wallet transfers).
CREATE TABLE "WebAuthnAuditLog" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "failureReason" TEXT NULL,
    "createdAt" TIMESTAMPZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebAuthnAuditLog_pk" PRIMARY KEY ("id")
);

CREATE INDEX "WebAuthnAuditLog_adminId_createdAt_idx" ON "WebAuthnAuditLog" ("adminId", "createdAt");
CREATE INDEX "WebAuthnAuditLog_credentialId_idx" ON "WebAuthnAuditLog" ("credentialId");
