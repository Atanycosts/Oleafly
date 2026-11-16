import { hasExactDocxFont } from "@/lib/docx-fonts";
import type { JournalWorld } from "@/lib/journal-workbench";
import { useFontPacksStore } from "@/store/font-packs";

export type DocxFontAcquisition =
  | "checking"
  | "available"
  | "downloading"
  | "noSource"
  | "failed"
  | "stillMissing";

export interface DocxFontAcquisitionResult {
  families: {
    family: string;
    state: DocxFontAcquisition;
    packId?: string;
  }[];
}

export interface EnsureDocxFontsOptions {
  attemptedPacks?: Set<string>;
  isActive?: () => boolean;
  onState?: (family: string, state: DocxFontAcquisition) => void;
}

const familyKey = (family: string) => family.trim().toLocaleLowerCase("en-US");

export function requiredDocxFontFamilies(world: JournalWorld | null): string[] {
  if (!world) return [];
  const families: string[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    const family = value.trim();
    const key = familyKey(family);
    if (!family || seen.has(key)) return;
    seen.add(key);
    families.push(family);
  };

  for (const rule of world.rules) {
    if (
      rule.property !== "body_font_family"
      || rule.unit !== "font_family"
      || rule.basis_status !== "confirmed"
      || typeof rule.expected !== "string"
      || rule.scope.article_type !== world.scope.article_type
      || rule.scope.stage !== world.scope.stage
      || rule.scope.language !== world.scope.language
    ) continue;
    add(rule.expected);
  }
  for (const font of world.template?.font_requirements ?? []) add(font.family);
  return families;
}

export async function ensureDocxFonts(
  world: JournalWorld | null,
  {
    attemptedPacks = new Set<string>(),
    isActive = () => true,
    onState,
  }: EnsureDocxFontsOptions = {},
): Promise<DocxFontAcquisitionResult> {
  const results = new Map<string, DocxFontAcquisitionResult["families"][number]>();
  const families = requiredDocxFontFamilies(world);
  const update = (family: string, state: DocxFontAcquisition, packId?: string) => {
    results.set(familyKey(family), { family, state, ...(packId ? { packId } : {}) });
    onState?.(family, state);
  };
  const snapshot = () => ({ families: [...results.values()] });
  if (!families.length || !isActive()) return snapshot();
  await useFontPacksStore.getState().load();
  if (!isActive()) return snapshot();

  for (const family of families) {
    if (!isActive()) return snapshot();
    update(family, "checking");
    if (await hasExactDocxFont(family)) {
      if (!isActive()) return snapshot();
      update(family, "available");
      continue;
    }
    if (!isActive()) return snapshot();

    const catalog = useFontPacksStore.getState();
    if (catalog.status !== "ready") {
      update(family, "failed");
      continue;
    }
    const pack = catalog.packs.find((candidate) =>
      candidate.families?.some((catalogFamily) => familyKey(catalogFamily) === familyKey(family)));
    if (!pack) {
      update(family, "noSource");
      continue;
    }
    if (attemptedPacks.has(pack.id)) {
      update(family, "stillMissing", pack.id);
      continue;
    }

    attemptedPacks.add(pack.id);
    update(family, "downloading", pack.id);
    if (!await catalog.install(pack.id)) {
      if (!isActive()) return snapshot();
      update(family, "failed", pack.id);
      continue;
    }
    if (!isActive()) return snapshot();
    const available = await hasExactDocxFont(family);
    if (!isActive()) return snapshot();
    update(family, available ? "available" : "stillMissing", pack.id);
  }
  return snapshot();
}
