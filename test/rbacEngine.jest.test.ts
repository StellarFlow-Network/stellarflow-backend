import {
  enforceRoleMatrix,
  requireAdmin,
  requireAuditor,
  requireKeyManagement,
  requireOperator,
} from "../src/middleware/roleMatrixMiddleware";
import { logAdminPermissionEvaluation } from "../src/services/adminAuditService";

jest.mock("../src/services/adminAuditService", () => ({
  logAdminPermissionEvaluation: jest.fn(() => Promise.resolve()),
}));

const mockedAudit = logAdminPermissionEvaluation as jest.MockedFunction<
  typeof logAdminPermissionEvaluation
>;

function createRes() {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  return { json, status } as unknown as import("express").Response;
}

function createReq(
  role?: string,
  path = "/admin/reports/summary",
  method = "GET",
): any {
  return {
    path,
    method,
    ip: "127.0.0.1",
    headers: { "user-agent": "jest" },
    ...(role
      ? { user: { userId: 1, email: "a@b.c", role } }
      : {}),
  };
}

beforeEach(() => {
  mockedAudit.mockClear();
});

describe("RBAC engine (Issue #1063)", () => {
  test("rejects unauthenticated requests with 401 and audits the denial", async () => {
    const req = createReq(undefined);
    const res = createRes();
    const next = jest.fn();

    await enforceRoleMatrix("read:config")(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(mockedAudit).toHaveBeenCalledWith(
      expect.objectContaining({ granted: false, reason: "UNAUTHENTICATED" }),
    );
  });

  test("ADMIN is granted access and the evaluation is audited", async () => {
    const req = createReq("ADMIN");
    const res = createRes();
    const next = jest.fn();

    await enforceRoleMatrix("read:config")(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(mockedAudit).toHaveBeenCalledWith(
      expect.objectContaining({ granted: true, role: "ADMIN" }),
    );
  });

  test("AUDITOR can read audit data but cannot write", async () => {
    const next = jest.fn();
    await requireAuditor(createReq("AUDITOR"), createRes(), next);
    expect(next).toHaveBeenCalled();

    const deniedNext = jest.fn();
    const res = createRes();
    await enforceRoleMatrix("write:oracle")(createReq("AUDITOR"), res, deniedNext);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(deniedNext).not.toHaveBeenCalled();
  });

  test("OPERATOR can operate the oracle but is denied admin-only routes", async () => {
    const next = jest.fn();
    await requireOperator(createReq("OPERATOR"), createRes(), next);
    expect(next).toHaveBeenCalled();

    const deniedNext = jest.fn();
    const res = createRes();
    await requireAdmin(createReq("OPERATOR"), res, deniedNext);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(deniedNext).not.toHaveBeenCalled();
  });

  test("key management is restricted to ADMIN sessions", async () => {
    for (const role of ["OPERATOR", "AUDITOR", "OBSERVER"]) {
      const res = createRes();
      const next = jest.fn();

      await requireKeyManagement(
        createReq(role, "/relayers/keys", "GET"),
        res,
        next,
      );

      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
      expect(mockedAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          granted: false,
          keyOperation: true,
          reason: "KEY_MANAGEMENT_REQUIRES_ADMIN",
        }),
      );
    }

    const adminNext = jest.fn();
    await requireKeyManagement(
      createReq("ADMIN", "/relayers/keys", "GET"),
      createRes(),
      adminNext,
    );
    expect(adminNext).toHaveBeenCalled();
  });

  test("OBSERVER is blocked from sensitive paths", async () => {
    const res = createRes();
    const next = jest.fn();

    await enforceRoleMatrix()(createReq("OBSERVER", "/admin/dlq"), res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
