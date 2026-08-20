import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agentModelSwitchPresets, agents, companies, companyMemberships, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping model-switch preset route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

type TestActor = Express.Request["actor"];
let currentActor: TestActor | undefined;

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

describeEmbeddedPostgres("agents model-switch preset route", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-model-switch-presets-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("model-switch-preset-routes");
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
    await db.delete(agentModelSwitchPresets);
    await db.delete(agents);
  });

  afterAll(async () => {
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

  function presetBody() {
    return {
      name: "DeepSeek tier",
      adapterType: "claude_local",
      mappings: [
        { from: "claude-opus-5", to: "deepseek-v4-pro[1m]" },
        { from: "claude-haiku-4-5", to: "deepseek-v4-flash" },
      ],
      env: { ANTHROPIC_BASE_URL: "https://api.deepseek.com" },
    };
  }

  it("creates, lists, updates and deletes presets", async () => {
    currentActor = boardActor;
    const app = await createApp();

    const created = await request(app)
      .post(`/api/companies/${COMPANY_ID}/agents/model-switch-presets`)
      .send(presetBody());
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      companyId: COMPANY_ID,
      name: "DeepSeek tier",
      adapterType: "claude_local",
      mappings: [
        { from: "claude-opus-5", to: "deepseek-v4-pro[1m]" },
        { from: "claude-haiku-4-5", to: "deepseek-v4-flash" },
      ],
      env: { ANTHROPIC_BASE_URL: "https://api.deepseek.com" },
    });
    const presetId = created.body.id as string;

    const listed = await request(app).get(`/api/companies/${COMPANY_ID}/agents/model-switch-presets`);
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].name).toBe("DeepSeek tier");

    const updated = await request(app)
      .patch(`/api/companies/${COMPANY_ID}/agents/model-switch-presets/${presetId}`)
      .send({ name: "DeepSeek tier v2", mappings: [{ to: "deepseek-v4-flash" }] });
    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe("DeepSeek tier v2");
    expect(updated.body.mappings).toEqual([{ to: "deepseek-v4-flash" }]);

    const removed = await request(app).delete(`/api/companies/${COMPANY_ID}/agents/model-switch-presets/${presetId}`);
    expect(removed.status).toBe(204);

    const afterDelete = await request(app).get(`/api/companies/${COMPANY_ID}/agents/model-switch-presets`);
    expect(afterDelete.body).toEqual([]);
  });

  it("rejects a duplicate preset name with 409", async () => {
    currentActor = boardActor;
    const app = await createApp();
    await request(app).post(`/api/companies/${COMPANY_ID}/agents/model-switch-presets`).send(presetBody());

    const dup = await request(app)
      .post(`/api/companies/${COMPANY_ID}/agents/model-switch-presets`)
      .send(presetBody());
    expect(dup.status).toBe(409);
  });

  it("returns 404 for missing presets on update and apply", async () => {
    currentActor = boardActor;
    const app = await createApp();
    const missingId = randomUUID();

    const patched = await request(app)
      .patch(`/api/companies/${COMPANY_ID}/agents/model-switch-presets/${missingId}`)
      .send({ name: "x" });
    expect(patched.status).toBe(404);

    const applied = await request(app)
      .post(`/api/companies/${COMPANY_ID}/agents/model-switch-presets/${missingId}/apply`)
      .send({});
    expect(applied.status).toBe(404);
  });

  it("applies a preset's stored mappings, scope and env", async () => {
    currentActor = boardActor;
    const agent = fixtureAgent({
      adapterType: "claude_local",
      adapterConfig: { model: "claude-opus-5", env: { ANTHROPIC_API_KEY: "k" } },
    });
    mockAgentService.list.mockResolvedValue([agent]);
    mockAgentService.update.mockResolvedValue(agent);
    const app = await createApp();

    const created = await request(app)
      .post(`/api/companies/${COMPANY_ID}/agents/model-switch-presets`)
      .send(presetBody());
    const presetId = created.body.id as string;

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/agents/model-switch-presets/${presetId}/apply`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dryRun: false, updated: 1, skipped: 0, preset: { id: presetId, name: "DeepSeek tier" } });
    expect(mockAgentService.update).toHaveBeenCalledTimes(1);
    const [, patch, options] = mockAgentService.update.mock.calls[0] as [string, any, any];
    expect(patch.adapterConfig.model).toBe("deepseek-v4-pro[1m]");
    expect(patch.adapterConfig.env.ANTHROPIC_BASE_URL).toEqual({
      type: "plain",
      value: "https://api.deepseek.com",
    });
    expect(options.recordRevision.source).toBe("bulk_model_switch");
  });

  it("supports dry-run apply without persisting", async () => {
    currentActor = boardActor;
    const agent = fixtureAgent({
      adapterType: "claude_local",
      adapterConfig: { model: "claude-opus-5" },
    });
    mockAgentService.list.mockResolvedValue([agent]);
    const app = await createApp();

    const created = await request(app)
      .post(`/api/companies/${COMPANY_ID}/agents/model-switch-presets`)
      .send(presetBody());
    const presetId = created.body.id as string;

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/agents/model-switch-presets/${presetId}/apply`)
      .send({ dryRun: true });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dryRun: true, updated: 1, skipped: 0 });
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("honors the preset's adapter-type scope and skips out-of-scope agents", async () => {
    currentActor = boardActor;
    const claude = fixtureAgent({
      adapterType: "claude_local",
      adapterConfig: { model: "claude-opus-5" },
    });
    const gemini = fixtureAgent({
      adapterType: "gemini_local",
      adapterConfig: { model: "gemini-2.5-pro" },
    });
    mockAgentService.list.mockResolvedValue([claude, gemini]);
    mockAgentService.update.mockResolvedValue(claude);
    const app = await createApp();

    const created = await request(app)
      .post(`/api/companies/${COMPANY_ID}/agents/model-switch-presets`)
      .send(presetBody());
    const presetId = created.body.id as string;

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/agents/model-switch-presets/${presetId}/apply`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);
    expect(res.body.skipped).toBe(0);
    expect(res.body.agents).toHaveLength(1);
    expect(res.body.agents[0].id).toBe(claude.id);
    expect(res.body.agents.find((a: any) => a.id === gemini.id)).toBeUndefined();
  });
});