import { useTranslation } from "react-i18next";
import { CodeBlock } from "@/components/ui/code-block";
import type { JournalAnnotationObject, JournalFragment, JournalRule } from "@/lib/journal-workbench";

export function JournalObjectView({ object }: Readonly<{ object: JournalAnnotationObject }>) {
  const { t } = useTranslation("researchTools");
  const text = t(($) => $.researchTools.journal, { returnObjects: true });
  const retained = JSON.parse(object.source.content) as { object: unknown };
  return <section className="space-y-2 text-sm" data-testid="journal-retained-object">
    <p className="break-all font-mono text-xs">{object.reference.kind}:{object.reference.objectId} · {object.target.objectRevision}</p>
    {object.reference.kind === "rule" && <>
      <h4 className="font-medium">{text.properties[(retained.object as JournalRule).property as keyof typeof text.properties]}</h4>
      {(retained.object as JournalRule).evidence.map((evidence) => <blockquote key={`${evidence.source_id}:${evidence.locator}`} className="whitespace-pre-wrap border-l-2 pl-3">
        <p>{evidence.quote}</p><code className="break-all text-xs">{evidence.locator}</code>
      </blockquote>)}
    </>}
    {object.reference.kind === "source" && <>
      <p className="whitespace-pre-wrap">{(retained.object as JournalFragment).text}</p>
      <code className="block break-all text-xs">{(retained.object as JournalFragment).locator}</code>
    </>}
    <details className="text-xs"><summary>{text.sourceData}</summary><CodeBlock code={JSON.stringify(retained.object, null, 2)} preClassName="whitespace-pre-wrap break-all" /></details>
  </section>;
}
