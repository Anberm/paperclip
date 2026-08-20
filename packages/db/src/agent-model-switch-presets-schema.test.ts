import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { agentModelSwitchPresets } from "./schema/agent_model_switch_presets.js";

function uniqueConstraint(table: Parameters<typeof getTableConfig>[0], constraintName: string) {
  return getTableConfig(table).uniqueConstraints.find((candidate) => candidate.name === constraintName);
}

function column(table: Parameters<typeof getTableConfig>[0], columnName: string) {
  const match = getTableConfig(table).columns.find((candidate) => candidate.name === columnName);
  if (!match) throw new Error(`Column ${columnName} not found`);
  return match;
}

describe("agent model switch presets schema", () => {
  it("enforces one preset name per company", () => {
    const constraint = uniqueConstraint(agentModelSwitchPresets, "agent_model_switch_presets_company_name_uq");

    expect(constraint?.columns.map((candidate) => candidate.name)).toEqual(["company_id", "name"]);
  });

  it("keeps lookup indexes company-scoped", () => {
    const index = getTableConfig(agentModelSwitchPresets).indexes.find(
      (candidate) => candidate.config.name === "agent_model_switch_presets_company_idx",
    );

    expect(index?.config.columns.map((candidate) => (candidate as { name: string }).name)).toEqual([
      "company_id",
    ]);
  });

  it("stores mappings and env as jsonb with nullable scope", () => {
    const columnNames = getTableConfig(agentModelSwitchPresets).columns.map((candidate) => candidate.name);

    expect(columnNames).toEqual(expect.arrayContaining([
      "id",
      "company_id",
      "name",
      "adapter_type",
      "mappings",
      "env",
      "created_at",
      "updated_at",
    ]));
    expect(column(agentModelSwitchPresets, "mappings").notNull).toBe(true);
    expect(column(agentModelSwitchPresets, "env").notNull).toBe(false);
    expect(column(agentModelSwitchPresets, "adapter_type").notNull).toBe(false);
  });
});