import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import {
  agentsApi,
  type AdapterModel,
  type ModelSwitchPreset,
  type ModelSwitchResult,
} from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { getAdapterLabel } from "../adapters/adapter-display-registry";
import { ArrowRight, ArrowRightLeft, Loader2, Plus, Play, Save, Trash2 } from "lucide-react";
import { cn } from "../lib/utils";

const HIDDEN_MODEL_SWITCH_STATUSES = new Set(["terminated", "pending_approval"]);
const MAX_RESULT_ROWS = 8;

function parseEnvOverrides(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  let count = 0;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    out[key] = line.slice(eq + 1);
    count += 1;
  }
  return count > 0 ? out : undefined;
}

function serializeEnv(env: Record<string, string> | null | undefined): string {
  if (!env) return "";
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

interface ModelSwitchDialogProps {
  companyId: string;
  agents: Agent[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ModelSwitchDialog({ companyId, agents, open, onOpenChange }: ModelSwitchDialogProps) {
  const queryClient = useQueryClient();
  const [adapterType, setAdapterType] = useState("");
  const [mappings, setMappings] = useState<Array<{ from: string; to: string }>>([{ from: "", to: "" }]);
  const [envText, setEnvText] = useState("");
  const [result, setResult] = useState<ModelSwitchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"preview" | "apply" | null>(null);
  const [presetName, setPresetName] = useState("");
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [presetBusy, setPresetBusy] = useState<"save" | "delete" | "apply" | null>(null);

  const presetsQueryKey = ["agents", companyId, "model-switch-presets"];
  const { data: presets = [] } = useQuery({
    queryKey: presetsQueryKey,
    queryFn: () => agentsApi.modelSwitchPresets.list(companyId),
    enabled: open,
  });
  const selectedPreset = useMemo(
    () => presets.find((preset) => preset.id === selectedPresetId) ?? null,
    [presets, selectedPresetId],
  );

  // Visible agents in scope (mirrors the agents list page's hidden statuses).
  const scopedAgents = useMemo(
    () =>
      agents.filter((agent) => {
        if (HIDDEN_MODEL_SWITCH_STATUSES.has(agent.status)) return false;
        if (adapterType && agent.adapterType !== adapterType) return false;
        return true;
      }),
    [agents, adapterType],
  );

  const adapterTypes = useMemo(() => {
    const types = new Set<string>();
    for (const agent of agents) {
      if (HIDDEN_MODEL_SWITCH_STATUSES.has(agent.status)) continue;
      types.add(agent.adapterType);
    }
    return Array.from(types).sort();
  }, [agents]);

  const existingModels = useMemo(() => {
    const models = new Set<string>();
    for (const agent of scopedAgents) {
      const model = agent.adapterConfig?.model;
      if (typeof model === "string" && model.trim()) models.add(model.trim());
    }
    return Array.from(models).sort();
  }, [scopedAgents]);

  // Suggest target models from the adapter's model registry when a single
  // adapter type is selected; otherwise fall back to models already in use.
  const { data: adapterModels = [] } = useQuery({
    queryKey: adapterType
      ? queryKeys.agents.adapterModels(companyId, adapterType)
      : ["agents", companyId, "adapter-models", "none"],
    queryFn: () => agentsApi.adapterModels(companyId, adapterType!),
    enabled: Boolean(adapterType),
  });
  const targetModelSuggestions = useMemo(() => {
    const models = new Set<string>(adapterModels.map((m: AdapterModel) => m.id));
    for (const model of existingModels) models.add(model);
    return Array.from(models).sort();
  }, [adapterModels, existingModels]);

  const validMappings = useMemo(
    () => mappings.filter((m) => m.to.trim().length > 0),
    [mappings],
  );
  const envOverrides = useMemo(() => parseEnvOverrides(envText), [envText]);
  const canRun = validMappings.length > 0;

  useEffect(() => {
    if (open) {
      setAdapterType("");
      setMappings([{ from: "", to: "" }]);
      setEnvText("");
      setResult(null);
      setError(null);
      setPending(null);
      setPresetName("");
      setSelectedPresetId("");
      setPresetBusy(null);
    }
  }, [open]);

  const savePreset = useMutation({
    mutationFn: async () => {
      const request = {
        adapterType: adapterType || undefined,
        mappings: validMappings.map((m) => ({
          ...(m.from.trim() ? { from: m.from.trim() } : {}),
          to: m.to.trim(),
        })),
        ...(envOverrides ? { env: envOverrides } : {}),
      };
      const existing = selectedPreset ?? presets.find((preset) => preset.name === presetName);
      if (existing) {
        return agentsApi.modelSwitchPresets.update(companyId, existing.id, {
          ...request,
          name: presetName,
        });
      }
      return agentsApi.modelSwitchPresets.create(companyId, { ...request, name: presetName });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: presetsQueryKey });
      setError(null);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Saving preset failed");
    },
  });

  const deletePreset = useMutation({
    mutationFn: (presetId: string) => agentsApi.modelSwitchPresets.remove(companyId, presetId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: presetsQueryKey });
      setSelectedPresetId("");
      setPresetName("");
      setError(null);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Deleting preset failed");
    },
  });

  const applyPreset = useMutation({
    mutationFn: (presetId: string) => agentsApi.modelSwitchPresets.apply(companyId, presetId, { dryRun: false }),
    onSuccess: (data) => {
      setResult(data);
      setError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.org(companyId) });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Applying preset failed");
    },
  });

  function loadPreset(preset: ModelSwitchPreset) {
    setAdapterType(preset.adapterType ?? "");
    setMappings(
      preset.mappings.length > 0
        ? preset.mappings.map((m) => ({ from: m.from ?? "", to: m.to }))
        : [{ from: "", to: "" }],
    );
    setEnvText(serializeEnv(preset.env));
    setPresetName(preset.name);
    setSelectedPresetId(preset.id);
    setResult(null);
    setError(null);
  }

  async function handleSavePreset() {
    if (!canRun || !presetName.trim()) return;
    setPresetBusy("save");
    setError(null);
    try {
      await savePreset.mutateAsync();
    } finally {
      setPresetBusy(null);
    }
  }

  async function handleDeletePreset() {
    if (!selectedPreset) return;
    setPresetBusy("delete");
    setError(null);
    try {
      await deletePreset.mutateAsync(selectedPreset.id);
    } finally {
      setPresetBusy(null);
    }
  }

  async function handleApplyPreset() {
    if (!selectedPreset) return;
    setPresetBusy("apply");
    setResult(null);
    setError(null);
    try {
      await applyPreset.mutateAsync(selectedPreset.id);
    } finally {
      setPresetBusy(null);
    }
  }

  const runSwitch = useMutation({
    mutationFn: ({ dryRun }: { dryRun: boolean }) =>
      agentsApi.modelSwitch(companyId, {
        adapterType: adapterType || undefined,
        mappings: validMappings.map((m) => ({
          ...(m.from.trim() ? { from: m.from.trim() } : {}),
          to: m.to.trim(),
        })),
        ...(envOverrides ? { env: envOverrides } : {}),
        dryRun,
      }),
    onSuccess: (data, variables) => {
      setResult(data);
      setError(null);
      if (!variables.dryRun) {
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.org(companyId) });
      }
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Model switch failed");
    },
  });

  function updateMapping(index: number, patch: Partial<{ from: string; to: string }>) {
    setMappings((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  async function handleRun(dryRun: boolean) {
    setPending(dryRun ? "preview" : "apply");
    setResult(null);
    setError(null);
    try {
      await runSwitch.mutateAsync({ dryRun });
    } finally {
      setPending(null);
    }
  }

  const changedAgents = result?.agents.filter((a) => a.changed) ?? [];
  const skippedCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const agent of result?.agents ?? []) {
      if (agent.changed || !agent.reason) continue;
      counts.set(agent.reason, (counts.get(agent.reason) ?? 0) + 1);
    }
    return counts;
  }, [result]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Switch agent models</DialogTitle>
          <DialogDescription>
            Bulk-update the model used by a company's agents — the same operation the
            ad-hoc SQL scripts perform, but with a dry-run preview and audit log.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Presets */}
          <div className="rounded-md border border-border p-3 space-y-3">
            <div className="flex items-center gap-2">
              <Select
                value={selectedPresetId}
                onValueChange={(value) => {
                  const preset = presets.find((p) => p.id === value);
                  if (preset) loadPreset(preset);
                  else setSelectedPresetId("");
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Load a preset…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">No preset</SelectItem>
                  {presets.map((preset) => (
                    <SelectItem key={preset.id} value={preset.id}>
                      {preset.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedPreset && (
                <>
                  <Button
                    type="button"
                    variant="default"
                    size="sm"
                    className="shrink-0"
                    disabled={presetBusy !== null}
                    onClick={handleApplyPreset}
                  >
                    {presetBusy === "apply" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                    Apply now
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="shrink-0"
                    aria-label="Delete preset"
                    disabled={presetBusy !== null}
                    onClick={handleDeletePreset}
                  >
                    {presetBusy === "delete" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  </Button>
                </>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Input
                className="font-mono text-xs"
                placeholder="Preset name (e.g. DeepSeek tier)"
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={!canRun || !presetName.trim() || presetBusy !== null}
                onClick={handleSavePreset}
              >
                {presetBusy === "save" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                Save preset
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Save the current scope, mappings and env as a named preset, then apply it in one click.
            </p>
          </div>

          {/* Scope */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium w-24 shrink-0">Scope</label>
              <Select value={adapterType} onValueChange={setAdapterType}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="All adapter types" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">All adapter types</SelectItem>
                  {adapterTypes.map((type) => (
                    <SelectItem key={type} value={type}>
                      {getAdapterLabel(type)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground pl-28">
              {scopedAgents.length} agent{scopedAgents.length !== 1 ? "s" : ""} in scope
              {adapterType ? ` (${getAdapterLabel(adapterType)})` : ""}.
            </p>
          </div>

          {/* Mappings */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Model mapping</label>
            <div className="space-y-2">
              {mappings.map((mapping, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Input
                    list={`model-switch-from-${index}`}
                    className="font-mono"
                    placeholder="Current model (blank = any)"
                    value={mapping.from}
                    onChange={(e) => updateMapping(index, { from: e.target.value })}
                  />
                  <ArrowRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <Input
                    list={`model-switch-to-${index}`}
                    className="font-mono"
                    placeholder="New model (required)"
                    value={mapping.to}
                    onChange={(e) => updateMapping(index, { to: e.target.value })}
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label="Remove mapping"
                    disabled={mappings.length <= 1}
                    onClick={() => setMappings((prev) => prev.filter((_, i) => i !== index))}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                  <datalist id={`model-switch-from-${index}`}>
                    <option value="" />
                    {existingModels.map((model) => (
                      <option key={model} value={model} />
                    ))}
                  </datalist>
                  <datalist id={`model-switch-to-${index}`}>
                    {targetModelSuggestions.map((model) => (
                      <option key={model} value={model} />
                    ))}
                  </datalist>
                </div>
              ))}
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setMappings((prev) => [...prev, { from: "", to: "" }])}
            >
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              Add mapping
            </Button>
          </div>

          {/* Env overrides */}
          <div className="space-y-2">
            <label className="text-sm font-medium">
              Env overrides <span className="text-muted-foreground font-normal">(optional)</span>
            </label>
            <Textarea
              className="font-mono text-xs min-h-20"
              placeholder={"One KEY=value per line, merged into each affected agent's env.\nExample:\nANTHROPIC_BASE_URL=https://api.deepseek.com"}
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          {/* Result */}
          {result && (
            <div className="rounded-md border border-border p-3 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant={result.dryRun ? "secondary" : "default"}>
                  {result.dryRun ? "Preview" : "Applied"}
                </Badge>
                <span className="text-xs">
                  <span className="text-foreground font-medium">{result.updated}</span>{" "}
                  agent{result.updated !== 1 ? "s" : ""} changed
                </span>
                <span className="text-xs text-muted-foreground">
                  · {result.skipped} skipped
                </span>
              </div>
              {changedAgents.length > 0 && (
                <ul className="text-xs space-y-1 max-h-40 overflow-y-auto">
                  {changedAgents.slice(0, MAX_RESULT_ROWS).map((agent) => (
                    <li key={agent.id} className="flex items-center gap-1.5 font-mono">
                      <span className="truncate max-w-40">{agent.name}</span>
                      <ArrowRightLeft className="h-3 w-3 text-muted-foreground shrink-0" />
                      <span className="text-muted-foreground truncate max-w-40">{agent.from ?? "(unset)"}</span>
                      <span className="text-muted-foreground shrink-0">→</span>
                      <span className="truncate max-w-48">{agent.to}</span>
                    </li>
                  ))}
                  {changedAgents.length > MAX_RESULT_ROWS && (
                    <li className="text-muted-foreground">
                      … and {changedAgents.length - MAX_RESULT_ROWS} more
                    </li>
                  )}
                </ul>
              )}
              {skippedCounts.size > 0 && (
                <p className="text-xs text-muted-foreground">
                  Skipped:{" "}
                  {Array.from(skippedCounts.entries())
                    .map(([reason, count]) => `${count} ${reason.replace("_", " ")}`)
                    .join(", ")}
                </p>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={!canRun || pending !== null}
            onClick={() => handleRun(true)}
          >
            {pending === "preview" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {result?.dryRun ? "Refresh preview" : "Preview"}
          </Button>
          <Button
            type="button"
            disabled={!canRun || pending !== null}
            onClick={() => handleRun(false)}
          >
            {pending === "apply" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Apply switch
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}