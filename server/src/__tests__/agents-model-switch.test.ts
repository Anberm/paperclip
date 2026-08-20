import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, companyMemberships, createDb } from "@paperclipai/db";
import type { ServerAdapterModule } from "../adapters/index.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  getChainOfCommand: vi.fn(async () => []),
  list: vi.fn(async () => []),
  update: vi.fn(async () => null),
  create: vi.fn(async () => null),
  getByUrlKey: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(async () => ({ allowed: true, reason: "allow_explicit_grant", explanation: "allowed" })),
  hasPermission: vi.fn(),
  getMembership: vi.fn(async () => null),
  listPrincipalGrants: vi.fn(async () => []),
}));

const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
  releaseLease: vi.fn(),
}));

const mockEnvironmentRuntime = vi.hoisted(() => ({
  acquireRunLease: vi.fn(),
  realizeWorkspace: vi.fn(),
  getDriver: vi.fn(() => ({ releaseRunLease: vi.fn(async () => undefined) })),
}));

const mockResolveEnvironmentExecutionTarget = vi.hoisted(() => vi.fn(async () => null));
const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
}));
const mockRunClaudeLogin = vi.hoisted(() => vi.fn(async () => ({ ok: true })));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => ({}),
  accessService: () => mockAccessService,
  approvalService: () => ({}),
  builtInAgentService: () => ({ ensureCompanyDefaultAgentGrants: vi.fn() }),
  companySkillService: () => ({
    listRuntimeSkillEntries: vi.fn(async () => []),
    resolveRequestedSkillKeys: vi.fn(async () => []),
  }),
  budgetService: () => ({}),
  heartbeatService: () => ({ wakeup: vi.fn(), cancelActiveForAgent: vi.fn() }),
  ISSUE_LIST_DEFAULT_LIMIT: 50,
  issueApprovalService: () => ({}),
  issueRecoveryActionService: () => ({}),
  issueService: () => ({}),
  logActivity: vi.fn(),
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({}),
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => mockEnvironmentService,
}));

vi.mock("../services/environment-runtime.js", () => ({
  environmentRuntimeService: () => mockEnvironmentRuntime,
}));

vi.mock("../services/environment-execution-target.js", () => ({
  resolveEnvironmentExecutionTarget: mockResolveEnvironmentExecutionTarget,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));

vi.mock("@paperclipai/adapter-claude-local/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-claude-local/server")>();
  return {
    ...actual,
    runClaudeLogin: mockRunClaudeLogin,
  };
});

import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping model-switch route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";

type TestActor = Express.Request["actor"];
let currentActor: TestActor | undefined;

const externalAdapter: ServerAdapterModule = {
  type: "external_test",
  execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
  testEnvironment: async () => ({
    adapterType: "external_test",
    status: "pass",
    checks: [],
    testedAt: new Date(0).toISOString(),
  }),
};

function fixtureAgent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: randomUUID(),
    companyId: COMPANY_ID,
    name: `Agent-${randomUUID().slice(0, 8)}`,
    urlKey: `agent-${randomUUID().slice(0, 8)}`,
    role: "engineer",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: {},
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describeEmbeddedPostgres("agents model-switch route", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-model-switch-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("model-switch-routes");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
    await db.insert(companies).values({
      id: COMPANY_ID,
      name: "Acme",
      issuePrefix: "ACME",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(companyMemberships).values({
      companyId: COMPANY_ID,
      principalType: "user",
      principalId: "user-1",
      status: "active",
      membershipRole: "owner",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const { registerServerAdapter } = await import("../adapters/index.js");
    registerServerAdapter(externalAdapter);
  });

  beforeEach(() => {
    currentActor = undefined;
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      reason: "allow_explicit_grant",
      explanation: "allowed",
    });
    mockResolveEnvironmentExecutionTarget.mockResolvedValue(null);
  });

  afterEach(async () => {
    await db.delete(agents);
  });

  afterAll(async () => {
    const { unregisterServerAdapter } = await import("../adapters/index.js");
    unregisterServerAdapter("external_test");
    if (stopDb) await stopDb();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function createApp() {
    const { agentRoutes } = await vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js");
    const { errorHandler } = await vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = currentActor;
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return app;
  }

  const boardActor: TestActor = {
    type: "board",
    userId: "user-1",
    companyIds: [COMPANY_ID],
    source: "session",
    isInstanceAdmin: false,
  };

  it("dry-run reports would-be changes without persisting", async () => {
    currentActor = boardActor;
    const opus = fixtureAgent({
      adapterType: "claude_local",
      adapterConfig: { model: "claude-opus-5", env: { ANTHROPIC_API_KEY: "k" } },
    });
    const haiku = fixtureAgent({
      adapterType: "claude_local",
      adapterConfig: { model: "claude-haiku-4-5" },
    });
    mockAgentService.list.mockResolvedValue([opus, haiku]);
    const app = await createApp();

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/agents/model-switch`)
      .send({
        adapterType: "claude_local",
        mappings: [
          { from: "claude-opus-5", to: "deepseek-v4-pro[1m]" },
          { from: "claude-haiku-4-5", to: "deepseek-v4-flash" },
        ],
        dryRun: true,
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dryRun: true, updated: 2, skipped: 0 });
    expect(res.body.agents.map((a: any) => [a.from, a.to])).toEqual([
      ["claude-opus-5", "deepseek-v4-pro[1m]"],
      ["claude-haiku-4-5", "deepseek-v4-flash"],
    ]);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("applies model + env overrides and records an activity log per agent", async () => {
    currentActor = boardActor;
    const opus = fixtureAgent({
      adapterType: "claude_local",
      adapterConfig: { model: "claude-opus-5", env: { ANTHROPIC_API_KEY: "k" } },
    });
    const updatedOpus = { ...opus, adapterConfig: { model: "deepseek-v4-pro[1m]", env: { ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "https://api.deepseek.com" } } };
    mockAgentService.list.mockResolvedValue([opus]);
    mockAgentService.update.mockResolvedValue(updatedOpus);
    const app = await createApp();

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/agents/model-switch`)
      .send({
        adapterType: "claude_local",
        mappings: [{ from: "claude-opus-5", to: "deepseek-v4-pro[1m]" }],
        env: { ANTHROPIC_BASE_URL: "https://api.deepseek.com" },
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dryRun: false, updated: 1, skipped: 0 });
    expect(mockAgentService.update).toHaveBeenCalledTimes(1);
    const [agentId, patch, options] = mockAgentService.update.mock.calls[0] as [string, any, any];
    expect(agentId).toBe(opus.id);
    expect(patch.adapterConfig.model).toBe("deepseek-v4-pro[1m]");
    // The secrets normalization layer wraps plain env values into bindings.
    expect(patch.adapterConfig.env.ANTHROPIC_BASE_URL).toEqual({
      type: "plain",
      value: "https://api.deepseek.com",
    });
    expect(patch.adapterConfig.env.ANTHROPIC_API_KEY).toEqual({ type: "plain", value: "k" });
    expect(options.recordRevision.source).toBe("bulk_model_switch");
  });

  it("an empty `from` matches any current model", async () => {
    currentActor = boardActor;
    const agent = fixtureAgent({
      adapterType: "claude_local",
      adapterConfig: { model: "claude-haiku-4-5" },
    });
    mockAgentService.list.mockResolvedValue([agent]);
    mockAgentService.update.mockResolvedValue(agent);
    const app = await createApp();

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/agents/model-switch`)
      .send({
        mappings: [{ from: "", to: "deepseek-v4-flash" }],
      });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);
    const [, patch] = mockAgentService.update.mock.calls[0] as [string, any];
    expect(patch.adapterConfig.model).toBe("deepseek-v4-flash");
  });

  it("skips agents without a matching model and agents already on the target", async () => {
    currentActor = boardActor;
    const gemini = fixtureAgent({
      adapterType: "gemini_local",
      adapterConfig: { model: "gemini-2.5-pro" },
    });
    const already = fixtureAgent({
      adapterType: "claude_local",
      adapterConfig: { model: "deepseek-v4-flash" },
    });
    mockAgentService.list.mockResolvedValue([gemini, already]);
    const app = await createApp();

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/agents/model-switch`)
      .send({
        mappings: [{ from: "deepseek-v4-flash", to: "deepseek-v4-flash" }],
      });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(0);
    expect(res.body.skipped).toBe(2);
    const reasons = res.body.agents.map((a: any) => a.reason).sort();
    expect(reasons).toEqual(["no_change", "no_match"]);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("skips agents the actor is not allowed to update", async () => {
    currentActor = boardActor;
    const agent = fixtureAgent({
      adapterType: "claude_local",
      adapterConfig: { model: "claude-opus-5" },
    });
    mockAgentService.list.mockResolvedValue([agent]);
    mockAccessService.decide.mockResolvedValue({
      allowed: false,
      reason: "deny_no_grants",
      explanation: "no grant",
    });
    const app = await createApp();

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/agents/model-switch`)
      .send({ mappings: [{ from: "claude-opus-5", to: "deepseek-v4-pro[1m]" }] });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(0);
    expect(res.body.skipped).toBe(1);
    expect(res.body.agents[0].reason).toBe("no_permission");
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("validates opencode model ids through the adapter constraints", async () => {
    currentActor = boardActor;
    const agent = fixtureAgent({
      adapterType: "opencode_local",
      adapterConfig: { model: "opencode/deepseek-v4-flash" },
    });
    mockAgentService.list.mockResolvedValue([agent]);
    const app = await createApp();

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/agents/model-switch`)
      .send({ mappings: [{ from: "opencode/deepseek-v4-flash", to: "opencode/deepseek-v4-flash-free" }] });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);
    const [, patch] = mockAgentService.update.mock.calls[0] as [string, any];
    expect(patch.adapterConfig.model).toBe("opencode/deepseek-v4-flash-free");
  });
});