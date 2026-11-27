import { runViaBackend } from "@/lib/agent-backend";
import type { EffortLevel } from "@oleafly/ai-core";

const emptyInput = { type: "object", properties: {}, additionalProperties: false };

export async function runDocxFormatCandidateAgent<Plan, Result>({ journal, effort, inspect, apply, signal }: {
  journal: string;
  effort?: EffortLevel;
  inspect(): Promise<Plan>;
  apply(): Promise<Result>;
  signal: AbortSignal;
}) {
  let applied: Promise<Result> | undefined;
  const outcome = await runViaBackend({
    effort,
    system: [
      "Prepare a Word formatting candidate. The supplied tool works only on a separate copy of the manuscript.",
      "Inspect the template comparison and call apply_template_format to apply all supported, unambiguous differences.",
      "Also call the tool when inspection reports table pagination changes, even if there are no template differences.",
      "Position-specific differences with an uncertain template basis are listed for the author, not guessed.",
      "Do not rewrite text, change formulas or replace images. The tool itself saves and rechecks the candidate.",
    ].join(" "),
    messages: [{ role: "user", content: [{ type: "text", text: `Format this manuscript using the selected ${journal} template. Do not change the content.` }] }],
    tools: [
      { name: "inspect_template_format", description: "Count format differences and undetermined findings for the captured manuscript and template. Not all differences can be applied automatically.", input_schema: emptyInput },
      { name: "apply_template_format", description: "Apply the supported, unambiguous template changes to the separate DOCX candidate; retain and recheck it.", input_schema: emptyInput },
    ],
  }, {
    onEvent: () => {},
    onToolRequest: async ({ name }) => {
      signal.throwIfAborted();
      if (name === "inspect_template_format") return { output: JSON.stringify(await inspect()) };
      if (name !== "apply_template_format") throw new Error("This run only exposes the Word formatting candidate tools.");
      applied ??= apply();
      return { output: JSON.stringify(await applied) };
    },
  }, signal);
  if (applied) return applied;
  if (outcome.error) throw new Error(outcome.error);
  if (outcome.stopped_at_cap) throw new Error("The agent did not submit a formatting candidate.");
}
