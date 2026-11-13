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
  version?: string | null;
}

interface SystemFontResolution {
  faces: SystemFontFace[];
  missing: FontFaceRequest[];
}

export interface DocxFontAlias {
  from: string;
  to: string;
}

export interface DocxFontStatus {
  probed: boolean;
  missing: FontFaceRequest[];
  aliases: DocxFontAlias[];
  loaded?: { family: string; version: string | null; sha256: string }[];
}

export const docxFontFaceKey = (face: FontFaceRequest) => JSON.stringify([face.family.trim().toLowerCase(), face.weight, face.style]);
const exactAxes = (face: SystemFontFace) => face.weight === face.requested.weight && face.style === face.requested.style;

export function resolveDocxSystemFonts(requests: readonly FontFaceRequest[]) {
  return invoke<SystemFontResolution>("resolve_system_font_faces", { requests });
}

export async function hasExactDocxFont(family: string): Promise<boolean> {
  const result = await resolveDocxSystemFonts([{ family, weight: 400, style: "normal" }]);
  return result.faces.some(exactAxes);
}

export function createDocxFontResolver(options: {
  onError(cause: unknown): void;
  onStatus(status: DocxFontStatus): void;
}) {
  const missing = new Map<string, FontFaceRequest>();
  const aliases = new Map<string, DocxFontAlias>();
  const loaded = new Map<string, { family: string; version: string | null; sha256: string }>();
  return defineFontResolver(async (request) => {
    try {
      const covered = new Set(request.resolvedFaces?.map(docxFontFaceKey));
      const requests = new Map<string, FontFaceRequest>();
      const families = new Map<string, string>();
      for (const family of [request.defaultFamily, ...request.families]) {
        const key = family.trim().toLowerCase();
        if (!families.has(key) && families.size < 64) families.set(key, family);
      }
      for (const family of families.values()) {
        for (const weight of [400, 700]) for (const style of ["normal", "italic"] as const) {
          const face = { family, weight, style };
          if (!covered.has(docxFontFaceKey(face))) requests.set(docxFontFaceKey(face), face);
        }
      }
      if (!requests.size || request.signal?.aborted) return;
      const result = await resolveDocxSystemFonts([...requests.values()]);
      if (request.signal?.aborted) return;
      const sources = new Map<string, FontSource>();
      const substitutions: FontSourceSubstitution[] = [];
      for (const [key, face] of requests) { missing.set(key, face); aliases.delete(key); }
      for (const face of result.faces) {
        if (!exactAxes(face) || face.style === "oblique") continue;
        const actual: FontFaceRequest = { family: face.family, weight: face.weight, style: face.style };
        const key = docxFontFaceKey(actual);
        loaded.set(key, { family: face.family, version: face.version ?? null, sha256: face.sha256 });
        if (!covered.has(key) && !sources.has(key)) {
          sources.set(key, { request: actual, id: `system:${face.postscriptName}:${face.sha256}:${face.faceIndex}`,
            bytes: base64ToBytes(face.contentBase64), hash: `sha256:${face.sha256}`, faceIndex: face.faceIndex });
        }
        const requestedKey = docxFontFaceKey(face.requested);
        missing.delete(requestedKey);
        if (requestedKey !== key) {
          substitutions.push({ from: face.requested, to: actual });
          aliases.set(requestedKey, { from: face.requested.family, to: actual.family });
        }
      }
      options.onStatus({ probed: true, missing: [...missing.values()], aliases: [...new Map([...aliases.values()].map((item) => [item.from, item])).values()], loaded: [...loaded.values()] });
      return { sources: [...sources.values()], substitutions };
    } catch (cause) {
      if (!request.signal?.aborted) options.onError(cause);
      return;
    }
  });
}
