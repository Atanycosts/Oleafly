import { beforeEach, expect, it, vi } from "vitest";
import type { FontResolutionRequest } from "@docx-editor.dev/core/editor";

const transport = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: transport.invoke }));
import { createDocxFontResolver, hasExactDocxFont } from "./docx-fonts";

const request = (family: string, weight = 400, style: "normal" | "italic" = "normal") => ({ family, weight, style });
const face = (family: string, weight = 400) => ({ requested: request(family, weight), family, weight, style: "normal" as const,
  postscriptName: `${family}-${weight}`, faceIndex: 0, sha256: "a".repeat(64), contentBase64: "AAECAw==" });
const resolution = (families: string[]): FontResolutionRequest => ({ families, defaultFamily: families[0] });
const hooks = () => ({ onError: vi.fn(), onStatus: vi.fn() });
beforeEach(() => { transport.invoke.mockReset(); });

it("retains exact TNR bytes and reports missing SimSun without querying Noto or another origin", async () => {
  const original = face("Times New Roman");
  transport.invoke.mockResolvedValue({ faces: [original], missing: [request("SimSun")] });
  const options = hooks();
  const result = await createDocxFontResolver(options)(resolution(["Times New Roman", "SimSun"]));
  expect(transport.invoke).toHaveBeenCalledOnce();
  expect(transport.invoke.mock.calls[0][1].requests.every((item: ReturnType<typeof request>) => ["Times New Roman", "SimSun"].includes(item.family))).toBe(true);
  expect(result?.sources).toEqual([{ request: request(original.family), id: `system:${original.postscriptName}:${original.sha256}:0`,
    bytes: Uint8Array.from([0, 1, 2, 3]), hash: `sha256:${original.sha256}`, faceIndex: 0 }]);
  expect(result?.substitutions).toEqual([]);
  expect(options.onStatus.mock.calls[0][0]).toMatchObject({ probed: true, aliases: [], missing: expect.arrayContaining([request("SimSun")]) });
});

it("connects native-confirmed localized aliases to the exact face", async () => {
  transport.invoke.mockResolvedValue({ faces: [{ ...face("Canonical Serif"), requested: request("本地衬线") }], missing: [] });
  const options = hooks();
  const result = await createDocxFontResolver(options)(resolution(["本地衬线"]));
  expect(result?.sources?.[0].request).toEqual(request("Canonical Serif"));
  expect(result?.substitutions).toEqual([{ from: request("本地衬线"), to: request("Canonical Serif") }]);
  expect(options.onStatus.mock.calls[0][0].aliases).toEqual([{ from: "本地衬线", to: "Canonical Serif" }]);
});

it("refuses nearest weights, italic mismatches and oblique instead of treating them as exact", async () => {
  transport.invoke.mockResolvedValue({ faces: [
    { ...face("Example"), requested: request("Example", 700) },
    { ...face("Example"), requested: request("Example", 400, "italic") },
    { ...face("Other"), requested: request("Other", 400, "italic"), style: "oblique" },
  ], missing: [] });
  const options = hooks();
  const result = await createDocxFontResolver(options)(resolution(["Example", "Other"]));
  expect(result).toEqual({ sources: [], substitutions: [] });
  expect(options.onStatus.mock.calls[0][0].missing).toContainEqual(request("Example", 700));
});

it("deduplicates family names and caps each native batch at 256 requests", async () => {
  transport.invoke.mockResolvedValue({ faces: [], missing: [] });
  await createDocxFontResolver(hooks())({ families: ["DEFAULT", ...Array.from({ length: 64 }, (_, i) => `Family ${i}`)], defaultFamily: "Default" });
  const requests = transport.invoke.mock.calls[0][1].requests;
  expect(requests).toHaveLength(256);
  expect(requests.filter((item: ReturnType<typeof request>) => item.family.toLowerCase() === "default")).toHaveLength(4);
});

it("reports native errors without inventing sources or satisfaction", async () => {
  const cause = new Error("Native read failed");
  transport.invoke.mockRejectedValue(cause);
  const options = hooks();
  expect(await createDocxFontResolver(options)(resolution(["SimSun"]))).toBeUndefined();
  expect(options.onError).toHaveBeenCalledExactlyOnceWith(cause);
  expect(options.onStatus).not.toHaveBeenCalled();
});

it("updates accumulated missing faces when a later probe provides their exact bytes", async () => {
  transport.invoke.mockResolvedValueOnce({ faces: [], missing: [request("SimSun")] })
    .mockResolvedValueOnce({ faces: [face("SimSun")], missing: [] });
  const options = hooks();
  const resolver = createDocxFontResolver(options);
  await resolver(resolution(["SimSun"]));
  await resolver(resolution(["SimSun"]));
  expect(options.onStatus.mock.calls[1][0].missing).not.toContainEqual(request("SimSun"));
});

it("checks regular-face availability using exact axes", async () => {
  transport.invoke.mockResolvedValueOnce({ faces: [{ ...face("Example", 500), requested: request("Example") }], missing: [] })
    .mockResolvedValueOnce({ faces: [face("Example")], missing: [] });
  expect(await hasExactDocxFont("Example")).toBe(false);
  expect(await hasExactDocxFont("Example")).toBe(true);
});
