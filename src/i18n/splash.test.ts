import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { SUPPORTED_LOCALES } from "@oleafly/i18n-contract";

type Shell = { splash: Record<string, string> };

function shellCatalog(locale: string): Shell {
  return JSON.parse(readFileSync(new URL(`./locales/${locale}/shell.json`, import.meta.url), "utf8")) as Shell;
}

describe("boot splash narration", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  const match = /var narration = (\{[\s\S]*?\});/.exec(html);
  const narration = JSON.parse(match?.[1] ?? "{}") as Record<string, { stages: string[]; starting: string }>;
  const shipped = /var shipped = (\[[^\]]*\]);/.exec(html);
  const prePaintLocales = JSON.parse(shipped?.[1] ?? "[]") as string[];

  it("paints Chinese on a fresh English device and respects an explicit English choice", () => {
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].find((entry) => entry[1].includes("var locale"))?.[1];
    if (!script) throw new Error("Pre-paint locale script is missing");
    for (const [preference, expected] of [[null, "zh-Hans"], ["en", "en"], ["system", "en"]]) {
      const document = { documentElement: { lang: "", className: "", style: {} } };
      runInNewContext(script, {
        document,
        localStorage: { getItem: (key: string) => key === "oleafly.locale" ? preference : null },
        navigator: { language: "en-US" },
        window: {},
      });
      expect(document.documentElement.lang).toBe(expected);
    }
  });

  it("lists every supported locale in the pre-paint script", () => {
    expect(prePaintLocales).toEqual([...SUPPORTED_LOCALES]);
    expect(Object.keys(narration).sort()).toEqual([...SUPPORTED_LOCALES].sort());
  });

  it.each([...SUPPORTED_LOCALES])("matches the %s shell catalog", (locale) => {
    const { splash } = shellCatalog(locale);
    expect(narration[locale]?.stages).toEqual([
      splash.initializing,
      splash.loadingCore,
      splash.loadingHarness,
      splash.loadingParsers,
    ]);
    expect(narration[locale]?.starting).toBe(splash.starting);
  });
});
