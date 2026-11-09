import { describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "./settings";

vi.mock("@/i18n/desktop", () => ({ changeLocalePreference: vi.fn(async () => {}) }));

describe("ui locale preference", () => {
  it("defaults to Chinese, persists an English choice, and resets", async () => {
    const { changeLocalePreference } = await import("@/i18n/desktop");
    const store = useSettingsStore.getState();
    expect(store.uiLocalePreference).toBe("zh-Hans");
    store.setUiLocalePreference("en");
    expect(useSettingsStore.getState().uiLocalePreference).toBe("en");
    expect(localStorage.getItem("oleafly.locale")).toBe("en");
    expect(changeLocalePreference).toHaveBeenCalledWith("en");
    useSettingsStore.getState().resetGeneralPreferences();
    expect(useSettingsStore.getState().uiLocalePreference).toBe("zh-Hans");
    expect(changeLocalePreference).toHaveBeenLastCalledWith("zh-Hans");
  });
});
