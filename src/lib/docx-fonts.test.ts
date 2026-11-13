import { beforeEach, expect, it, vi } from "vitest";
import { composeFontOrigins, defineFontResolver, type FontResolutionRequest } from "@docx-editor.dev/core/editor";

const transport = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: transport.invoke }));

import { createDocxFontResolver } from "./docx-fonts";

const request = (family: string, weight = 400, style: "normal" | "italic" = "normal") => ({ family, weight, style });
const face = (family: string, weight = 400) => ({ requested: request(family, weight), family, weight, style: "normal" as const,
  postscriptName: `${family}-${weight}`, faceIndex: 0, sha256: "a".repeat(64), contentBase64: "AAECAw==" });
const resolution = (families: string[]): FontResolutionRequest => ({ families, defaultFamily: families[0] });
const hooks = () => ({ onError: vi.fn(), onSubstitutions: vi.fn() });

beforeEach(() => { transport.invoke.mockReset(); });

it("supplies original font bytes, actual metadata and hash without a substitution", async () => {
  const original = face("Times New Roman");
  transport.invoke.mockResolvedValue({ faces: [original], missing: [] });
  const options = hooks();
  const result = await createDocxFontResolver(options)(resolution(["Times New Roman"]));
  expect(transport.invoke).toHaveBeenCalledExactlyOnceWith("resolve_system_font_faces", {
    requests: [request("Times New Roman"), request("Times New Roman", 400, "italic"), request("Times New Roman", 700), request("Times New Roman", 700, "italic")],
  });
  expect(result?.sources).toEqual([{ request: request(original.family), id: `system:${original.postscriptName}:${original.sha256}:0`,
    bytes: Uint8Array.from([0, 1, 2, 3]), hash: `sha256:${original.sha256}`, faceIndex: 0 }]);
  expect(result?.substitutions).toEqual([]);
  expect(options.onSubstitutions).not.toHaveBeenCalled();
});

it("deduplicates CJK alias requests and sources and explicitly maps regular and bold substitutes", async () => {
  transport.invoke.mockImplementation(async (_command, { requests }) => {
    if (requests[0].family === "宋体") return { faces: [], missing: requests };
    return { faces: requests.map((item: ReturnType<typeof request>) => face(item.family, item.weight)), missing: [] };
  });
  const options = hooks();
  const result = await createDocxFontResolver(options)(resolution(["宋体", "SimSun", "黑体", "SimHei", "楷体"]));
  expect(transport.invoke.mock.calls[1][1].requests).toEqual([
    request("Noto Serif CJK SC"), request("Noto Serif CJK SC", 700), request("Noto Sans CJK SC"), request("Noto Sans CJK SC", 700),
  ]);
  expect(result?.sources).toHaveLength(4);
  expect(result?.substitutions).toHaveLength(8);
  expect(result?.substitutions).toContainEqual({ from: request("宋体", 700), to: request("Noto Serif CJK SC", 700) });
  expect(result?.substitutions?.some((item) => item.from.family === "楷体" || item.from.style === "italic")).toBe(false);
  expect(options.onSubstitutions).toHaveBeenCalledWith([
    { from: "宋体", to: "Noto Serif CJK SC" }, { from: "SimSun", to: "Noto Serif CJK SC" },
    { from: "黑体", to: "Noto Sans CJK SC" }, { from: "SimHei", to: "Noto Sans CJK SC" },
  ]);
});

it("leaves missing substitutes unresolved and never claims unprovided faces", async () => {
  transport.invoke.mockImplementation(async (_command, { requests }) => ({ faces: [], missing: requests }));
  const options = hooks();
  const result = await createDocxFontResolver(options)(resolution(["宋体"]));
  expect(result).toEqual({ sources: [], substitutions: [] });
  expect(options.onSubstitutions).not.toHaveBeenCalled();
});

it("reuses earlier byte-backed faces without reloading them", async () => {
  transport.invoke.mockImplementation(async (_command, { requests }) => ({ faces: [], missing: requests }));
  const result = await createDocxFontResolver(hooks())({ ...resolution(["宋体"]), resolvedFaces: [request("Noto Serif CJK SC"), request("Noto Serif CJK SC", 700)] });
  expect(transport.invoke).toHaveBeenCalledOnce();
  expect(result?.sources).toEqual([]);
  expect(result?.substitutions).toHaveLength(2);
});

it("deduplicates actual faces even when native returns the same static face twice", async () => {
  const regular = face("Times New Roman");
  transport.invoke.mockResolvedValue({ faces: [regular, { ...regular, requested: request("Times New Roman", 700) }], missing: [] });
  const result = await createDocxFontResolver(hooks())(resolution(["Times New Roman"]));
  expect(result?.sources).toHaveLength(1);
  expect(result?.substitutions).toEqual([{ from: request("Times New Roman", 700), to: request("Times New Roman") }]);
});

it("connects localized authored family names to native canonical metadata", async () => {
  transport.invoke.mockResolvedValue({ faces: [{ ...face("Canonical Serif"), requested: request("本地衬线") }], missing: [] });
  const options = hooks();
  const result = await createDocxFontResolver(options)(resolution(["本地衬线"]));
  expect(result?.sources?.[0].request).toEqual(request("Canonical Serif"));
  expect(result?.substitutions).toEqual([{ from: request("本地衬线"), to: request("Canonical Serif") }]);
  expect(options.onSubstitutions).toHaveBeenCalledWith([{ from: "本地衬线", to: "Canonical Serif" }]);
});

it("maps CJK replacement straight to the actual nearest weight without a substitution chain", async () => {
  transport.invoke.mockResolvedValueOnce({ faces: [], missing: [request("宋体", 700)] })
    .mockResolvedValueOnce({ faces: [{ ...face("Noto Serif CJK SC"), requested: request("Noto Serif CJK SC", 700) }], missing: [] });
  const result = await createDocxFontResolver(hooks())(resolution(["宋体"]));
  expect(result?.substitutions).toContainEqual({ from: request("宋体", 700), to: request("Noto Serif CJK SC") });
  expect(result?.sources).toHaveLength(1);
});

it("does not fetch a CJK substitute twice when the document also requests its actual family", async () => {
  transport.invoke.mockResolvedValue({ faces: [face("Noto Serif CJK SC"), face("Noto Serif CJK SC", 700)], missing: [request("宋体"), request("宋体", 700)] });
  const result = await createDocxFontResolver(hooks())(resolution(["宋体", "Noto Serif CJK SC"]));
  expect(transport.invoke).toHaveBeenCalledOnce();
  expect(result?.sources).toHaveLength(2);
  expect(result?.substitutions).toHaveLength(2);
});

it("skips actual oblique faces rather than relabeling their bytes as italic", async () => {
  transport.invoke.mockResolvedValue({ faces: [{ ...face("Example"), requested: request("Example", 400, "italic"), style: "oblique" }], missing: [] });
  const result = await createDocxFontResolver(hooks())(resolution(["Example"]));
  expect(result).toEqual({ sources: [], substitutions: [] });
});

it("deduplicates family names and caps each native batch at 256 face requests", async () => {
  transport.invoke.mockResolvedValue({ faces: [], missing: [] });
  const families = ["DEFAULT", ...Array.from({ length: 64 }, (_, index) => `Family ${index}`)];
  await createDocxFontResolver(hooks())({ families, defaultFamily: "Default" });
  const requests = transport.invoke.mock.calls[0][1].requests;
  expect(requests).toHaveLength(256);
  expect(requests.filter((item: ReturnType<typeof request>) => item.family.toLowerCase() === "default")).toHaveLength(4);
  expect(requests.some((item: ReturnType<typeof request>) => item.family === "Family 63")).toBe(false);
});

it("reports native failures while allowing the later packaged origin to supply fonts", async () => {
  const failure = new Error("Native font read failed");
  transport.invoke.mockRejectedValue(failure);
  const options = hooks();
  const source = { request: request("Liberation Serif"), id: "packaged", bytes: Uint8Array.from([0, 1, 2, 3]), hash: `sha256:${"b".repeat(64)}`, faceIndex: 0 };
  const packaged = defineFontResolver(() => ({ sources: [source], substitutions: [{ from: request("Times New Roman"), to: source.request }] }));
  const result = await composeFontOrigins([createDocxFontResolver(options), packaged], resolution(["Times New Roman"]));
  expect(options.onError).toHaveBeenCalledWith(failure);
  expect(result?.sources).toHaveLength(1);
  expect(result?.sources?.[0]).toMatchObject(source);
});

it("keeps original native faces ahead of a later origin and removes its generic substitution", async () => {
  transport.invoke.mockResolvedValue({ faces: [face("Times New Roman")], missing: [] });
  const later = defineFontResolver((input) => {
    expect(input.resolvedFaces).toContainEqual(request("Times New Roman"));
    return { sources: [{ request: request("Times New Roman"), id: "later", bytes: Uint8Array.from([9]), hash: `sha256:${"b".repeat(64)}`, faceIndex: 0 }],
      substitutions: [{ from: request("Times New Roman"), to: request("Liberation Serif") }] };
  });
  const result = await composeFontOrigins([createDocxFontResolver(hooks()), later], resolution(["Times New Roman"]));
  expect(result?.sources).toHaveLength(1);
  expect(result?.sources?.[0].id).toMatch(/^system:/);
  expect(result?.substitutions ?? []).toEqual([]);
});

it("retains direct native bytes through composition when the CJK substitute query fails", async () => {
  const original = face("Times New Roman");
  const failure = new Error("Noto font read failed");
  transport.invoke.mockResolvedValueOnce({ faces: [original], missing: [request("宋体")] }).mockRejectedValueOnce(failure);
  const options = hooks();
  const later = defineFontResolver((input) => {
    expect(input.resolvedFaces).toContainEqual(request("Times New Roman"));
    return { sources: [{ request: request("Times New Roman"), id: "later", bytes: Uint8Array.from([9]), hash: `sha256:${"b".repeat(64)}`, faceIndex: 0 }] };
  });
  const result = await composeFontOrigins([createDocxFontResolver(options), later], resolution(["Times New Roman", "宋体"]));
  expect(transport.invoke).toHaveBeenCalledTimes(2);
  expect(options.onError).toHaveBeenCalledExactlyOnceWith(failure);
  expect(options.onSubstitutions).not.toHaveBeenCalled();
  expect(result?.sources).toHaveLength(1);
  expect(result?.sources?.[0]).toMatchObject({ request: request("Times New Roman"),
    bytes: Uint8Array.from([0, 1, 2, 3]), hash: `sha256:${original.sha256}` });
  expect(result?.sources?.[0].id).toMatch(/^system:/);
  expect(result?.substitutions ?? []).toEqual([]);
});
