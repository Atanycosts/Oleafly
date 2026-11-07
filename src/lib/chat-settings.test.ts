import { describe, expect, it } from "vitest";
import { resolveRunEffort } from "./chat-settings";

describe("chat settings", () => {
  it("drops a stored effort the model does not offer", () => {
    expect(resolveRunEffort("max", ["low", "high"])).toBeUndefined();
    expect(resolveRunEffort("high", ["low", "high"])).toBe("high");
    expect(resolveRunEffort(undefined, ["low", "high"])).toBeUndefined();
  });
});
