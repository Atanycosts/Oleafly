import { useTranslation } from "react-i18next";
import { formatJournalValue, type JournalAnnotationObject, type JournalCheck, type JournalFragment, type JournalRule, type JournalWorld } from "@/lib/journal-workbench";

export function JournalObjectView({ object }: Readonly<{ object: JournalAnnotationObject }>) {
  const { t } = useTranslation("researchTools");
  const text = t(($) => $.researchTools.journal, { returnObjects: true });
  const retained = JSON.parse(object.source.content) as { object: unknown };
  const rule = object.reference.kind === "rule" ? retained.object as JournalRule : null;
  const format = rule?.expected && typeof rule.expected === "object" ? rule.expected : null;
  const check = object.reference.kind === "check" ? retained.object as Pick<JournalCheck, "created_at" | "summary"> : null;
  return <section className="space-y-2 text-sm" data-testid="journal-retained-object">
    {rule && <>
      <h4 className="font-medium">{format ? text.template.roles[format.role as keyof typeof text.template.roles] ?? text.template.snapshot : text.properties[rule.property as keyof typeof text.properties]}</h4>
      <p>{format ? text.template.snapshot : formatJournalValue(rule.expected, rule.unit)}</p>
      {rule.evidence.map((evidence) => <blockquote key={`${evidence.source_id}:${evidence.locator}`} className="whitespace-pre-wrap border-l-2 pl-3">
        <p>{evidence.quote}</p>
      </blockquote>)}
    </>}
    {object.reference.kind === "source" && <>
      <p className="whitespace-pre-wrap">{(retained.object as JournalFragment).text}</p>
    </>}
    {check && <>
      <h4 className="font-medium">{text.results}</h4>
      <p className="text-muted-foreground">{new Date(check.created_at).toLocaleString()}</p>
      <dl className="grid grid-cols-2 gap-2">{Object.entries(check.summary).map(([verdict, count]) => <div key={verdict}><dt>{text.verdicts[verdict as keyof typeof text.verdicts]}</dt><dd>{count}</dd></div>)}</dl>
    </>}
    {object.reference.kind === "world" && <>
      <h4 className="font-medium">{(retained.object as JournalWorld).journal_name}</h4>
      <p>{text.rules} · {(retained.object as JournalWorld).rules.length}</p>
      <ul>{(retained.object as JournalWorld).sources.map((source) => <li key={source.source_id}>{source.name}</li>)}</ul>
    </>}
  </section>;
}
