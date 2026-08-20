import { index, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import type { AgentModelSwitchMapping } from "@paperclipai/shared";
import { companies } from "./companies.js";

export const agentModelSwitchPresets = pgTable(
  "agent_model_switch_presets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    adapterType: text("adapter_type"),
    mappings: jsonb("mappings").$type<AgentModelSwitchMapping[]>().notNull(),
    env: jsonb("env").$type<Record<string, string> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyNameUq: unique("agent_model_switch_presets_company_name_uq").on(table.companyId, table.name),
    companyIdx: index("agent_model_switch_presets_company_idx").on(table.companyId),
  }),
);