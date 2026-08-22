import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterSkillContext,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  buildPersistentSkillSnapshot,
  ensurePaperclipSkillSymlink,
  readPaperclipRuntimeSkillEntries,
  readInstalledSkillTargets,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveCommandCodeSkillsHome(config: Record<string, unknown>) {
  const env =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  const configuredHome = asString(env.HOME);
  const home = configuredHome ? path.resolve(configuredHome) : os.homedir();
  return path.join(home, ".commandcode", "skills");
}

async function buildCommandCodeSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, availableEntries);
  const skillsHome = resolveCommandCodeSkillsHome(config);
  const installed = await readInstalledSkillTargets(skillsHome);
  return buildPersistentSkillSnapshot({
    adapterType: "commandcode_local",
    availableEntries,
    desiredSkills,
    installed,
    skillsHome,
    locationLabel: "~/.commandcode/skills",
    installedDetail: "Installed in the Command Code personal skills home.",
    missingDetail: "Configured but not currently linked into the Command Code personal skills home.",
    externalConflictDetail: "Skill name is occupied by an external installation in the Command Code personal skills home.",
    externalDetail: "Installed outside Paperclip management in the Command Code personal skills home.",
    warnings: [
      "Command Code discovers skills from ~/.commandcode/skills.",
    ],
  });
}

export async function listCommandCodeSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildCommandCodeSkillSnapshot(ctx.config);
}

export async function syncCommandCodeSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(ctx.config, __moduleDir);
  const desiredSet = new Set(desiredSkills);
  const skillsHome = resolveCommandCodeSkillsHome(ctx.config);
  await fs.mkdir(skillsHome, { recursive: true });
  const installed = await readInstalledSkillTargets(skillsHome);
  const availableByRuntimeName = new Map(availableEntries.map((entry) => [entry.runtimeName, entry]));

  for (const available of availableEntries) {
    if (!desiredSet.has(available.key)) continue;
    const target = path.join(skillsHome, available.runtimeName);
    await ensurePaperclipSkillSymlink(available.source, target);
  }

  for (const [name, installedEntry] of installed.entries()) {
    const available = availableByRuntimeName.get(name);
    if (!available) continue;
    if (desiredSet.has(available.key)) continue;
    if (installedEntry.targetPath !== available.source) continue;
    await fs.unlink(path.join(skillsHome, name)).catch(() => {});
  }

  return buildCommandCodeSkillSnapshot(ctx.config);
}

export function resolveCommandCodeDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string }>,
) {
  return resolvePaperclipDesiredSkillNames(config, availableEntries);
}
