import { invoke } from "@tauri-apps/api/core";
import { defineFontResolver } from "@docx-editor.dev/core/editor";
import type { FontFaceRequest, FontSource, FontSourceSubstitution } from "@docx-editor.dev/core/contracts/editor";
import { base64ToBytes } from "@/lib/base64";

interface SystemFontFace {
  requested: FontFaceRequest;
  family: string;
  postscriptName: string;
  weight: number;
  style: "normal" | "italic" | "oblique";
  faceIndex: number;
  sha256: string;
  contentBase64: string;
}

interface SystemFontResolution {
  faces: SystemFontFace[];
  missing: FontFaceRequest[];
}

export interface DocxFontSubstitution {
  from: string;
  to: string;
}

const alternatives = new Map([
  ["宋体", "Noto Serif CJK SC"], ["simsun", "Noto Serif CJK SC"],
  ["黑体", "Noto Sans CJK SC"], ["simhei", "Noto Sans CJK SC"],
]);
const faceKey = (face: FontFaceRequest) => JSON.stringify([face.family.trim().toLowerCase(), face.weight, face.style]);
type CompatibleSystemFontFace = SystemFontFace & { style: "normal" | "italic" };
const compatibleFace = (face: SystemFontFace): face is CompatibleSystemFontFace => face.style !== "oblique";
const actualRequest = (face: CompatibleSystemFontFace): FontFaceRequest => ({ family: face.family, weight: face.weight, style: face.style });

export function createDocxFontResolver(options: {
  onError(cause: unknown): void;
  onSubstitutions(substitutions: DocxFontSubstitution[]): void;
}) {
  return defineFontResolver(async (request) => {
    try {
      const covered = new Set(request.resolvedFaces?.map(faceKey));
      const requests = new Map<string, FontFaceRequest>();
      const families = new Map<string, string>();
      for (const family of [request.defaultFamily, ...request.families]) {
        const key = family.trim().toLowerCase();
        if (!families.has(key) && families.size < 64) families.set(key, family);
      }
      for (const family of families.values()) {
        for (const weight of [400, 700]) for (const style of ["normal", "italic"] as const) {
          const face = { family, weight, style };
          if (!covered.has(faceKey(face))) requests.set(faceKey(face), face);
        }
      }
      if (!requests.size || request.signal?.aborted) return;
      const direct = await invoke<SystemFontResolution>("resolve_system_font_faces", { requests: [...requests.values()] });
      if (request.signal?.aborted) return;
      const directFaces = direct.faces.filter(compatibleFace);
      const available = new Set([...covered, ...directFaces.flatMap((face) => [faceKey(actualRequest(face)), faceKey(face.requested)])]);
      const substituteRequests = new Map<string, FontFaceRequest>();
      for (const missing of direct.missing) {
        const family = alternatives.get(missing.family.trim().toLowerCase());
        if (!family || missing.style !== "normal") continue;
        const face = { ...missing, family };
        if (!available.has(faceKey(face))) substituteRequests.set(faceKey(face), face);
      }
      let substitutes: SystemFontResolution = { faces: [], missing: [] };
      if (substituteRequests.size) {
        try {
          substitutes = await invoke<SystemFontResolution>("resolve_system_font_faces", { requests: [...substituteRequests.values()] });
        } catch (cause) {
          if (!request.signal?.aborted) options.onError(cause);
        }
      }
      if (request.signal?.aborted) return;
      const faces = [...directFaces, ...substitutes.faces.filter(compatibleFace)];
      const sources = new Map<string, FontSource>();
      for (const face of faces) {
        const actual = actualRequest(face);
        const key = faceKey(actual);
        if (covered.has(key) || sources.has(key)) continue;
        sources.set(key, { request: actual, id: `system:${face.postscriptName}:${face.sha256}:${face.faceIndex}`,
          bytes: base64ToBytes(face.contentBase64), hash: `sha256:${face.sha256}`, faceIndex: face.faceIndex });
      }
      const substitutions = new Map<string, FontSourceSubstitution>();
      const notices = new Map<string, DocxFontSubstitution>();
      const resolved = new Map(faces.map((face) => [faceKey(face.requested), actualRequest(face)]));
      for (const face of faces) {
        const to = actualRequest(face);
        if (faceKey(face.requested) === faceKey(to)) continue;
        substitutions.set(faceKey(face.requested), { from: face.requested, to });
        if (face.requested.family.trim().toLowerCase() !== to.family.trim().toLowerCase()) {
          notices.set(face.requested.family, { from: face.requested.family, to: to.family });
        }
      }
      for (const missing of direct.missing) {
        const family = alternatives.get(missing.family.trim().toLowerCase());
        if (!family || missing.style !== "normal") continue;
        const target = { ...missing, family };
        const to = resolved.get(faceKey(target)) ?? target;
        if (!sources.has(faceKey(to)) && !covered.has(faceKey(to))) continue;
        substitutions.set(faceKey(missing), { from: missing, to });
        notices.set(missing.family, { from: missing.family, to: to.family });
      }
      if (notices.size) options.onSubstitutions([...notices.values()]);
      return { sources: [...sources.values()], substitutions: [...substitutions.values()] };
    } catch (cause) {
      if (!request.signal?.aborted) options.onError(cause);
      return;
    }
  });
}
