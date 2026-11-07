import { i18n } from "@/i18n";
import type { SkillEntry } from "@/lib/skills";

export const SKILL_PHASE_ORDER = [
  "research",
  "authoring",
  "figures",
  "review",
  "submission",
  "communication",
  "tooling",
] as const;

export type SkillPhase = (typeof SKILL_PHASE_ORDER)[number];

export interface SkillGroup {
  key: string;
  label: string;
  skills: SkillEntry[];
}

export function groupSkills(skills: readonly SkillEntry[]): SkillGroup[] {
  const byPhase = new Map<string, SkillEntry[]>();
  const yours: SkillEntry[] = [];
  const shelf: SkillEntry[] = [];
  for (const skill of skills) {
    if (skill.tier === "shelf") {
      shelf.push(skill);
      continue;
    }
    if (skill.phase && SKILL_PHASE_ORDER.includes(skill.phase as SkillPhase)) {
      const list = byPhase.get(skill.phase) ?? [];
      list.push(skill);
      byPhase.set(skill.phase, list);
      continue;
    }
    yours.push(skill);
  }
  const byName = (list: SkillEntry[]) => [...list].sort((a, b) => a.name.localeCompare(b.name));
  const groups: SkillGroup[] = [];
  for (const phase of SKILL_PHASE_ORDER) {
    const list = byPhase.get(phase);
    if (list && list.length > 0) {
      const labels = i18n.t(($) => $.core.skillGroups, { returnObjects: true });
      groups.push({ key: phase, label: labels[phase], skills: byName(list) });
    }
  }
  if (yours.length > 0) groups.push({
      key: "user",
      label: i18n.t(($) => $.core.skillGroups.user),
      skills: byName(yours),
    });
  if (shelf.length > 0) groups.push({
      key: "shelf",
      label: i18n.t(($) => $.core.skillGroups.shelf),
      skills: byName(shelf),
    });
  return groups;
}

export function skillDisplayText(skill: {
  id: string;
  name: string;
  description: string;
  source?: string;
}): { name: string; description: string } {
  if (skill.source === "user" || i18n.resolvedLanguage === "en") return skill;
  const catalog = i18n.t(($) => $.core.bundledSkills, { returnObjects: true });
  return Object.hasOwn(catalog, skill.id) ? catalog[skill.id as keyof typeof catalog] : skill;
}

export function matchesSkillSearch(
  query: string,
  fields: readonly (string | null | undefined)[],
): boolean {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = fields.filter(Boolean).join("\n").toLocaleLowerCase();
  return words.every((word) => haystack.includes(word));
}
