import type { EffortLevel, WebToggle } from "@oleafly/ai-core";

export type WebSetting = WebToggle;

export const WEB_ON: WebSetting = Object.freeze({ search: true, fetch: true });

export function resolveRunEffort(
  selected: EffortLevel | undefined,
  choices: readonly EffortLevel[],
): EffortLevel | undefined {
  return selected !== undefined && choices.includes(selected) ? selected : undefined;
}
