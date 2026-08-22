import { describe, expect, it } from "vitest";
import {
  type,
  label,
  models,
  DEFAULT_COMMANDCODE_LOCAL_MODEL,
  buildCommandCodeModelProfiles,
} from "./index.js";

describe("commandcode-local adapter metadata", () => {
  it("exposes the adapter type and label", () => {
    expect(type).toBe("commandcode_local");
    expect(label).toBe("Command Code");
  });

  it("has a non-empty model list with the default first", () => {
    expect(models.length).toBeGreaterThan(0);
    expect(models[0].id).toBe(DEFAULT_COMMANDCODE_LOCAL_MODEL);
    for (const model of models) {
      expect(model.id).toContain("/");
    }
  });

  it("cheap profile defaults to the flash model", () => {
    const [cheap] = buildCommandCodeModelProfiles({});
    expect(cheap.key).toBe("cheap");
    expect(cheap.adapterConfig).toEqual({ model: DEFAULT_COMMANDCODE_LOCAL_MODEL });
  });

  it("cheap profile honours PAPERCLIP_COMMANDCODE_CHEAP_MODEL", () => {
    const [cheap] = buildCommandCodeModelProfiles({ PAPERCLIP_COMMANDCODE_CHEAP_MODEL: "gateway/model" });
    expect(cheap.adapterConfig).toEqual({ model: "gateway/model" });
  });
});
