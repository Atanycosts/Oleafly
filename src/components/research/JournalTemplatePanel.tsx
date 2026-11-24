import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  fetchDocxFindingGroups,
  type DocxFindingGroup,
  type DocxFindingLocation,
} from "@/lib/docx-finding-review";
import type { JournalCheck, JournalProject, JournalWorld } from "@/lib/journal-workbench";
import { DocxFindingBrowser } from "./DocxFindingBrowser";

export function JournalTemplatePanel({ world, project, check, onJump }: {
  world: JournalWorld;
  project: JournalProject | null;
  check: JournalCheck | null;
  onJump?: (location: DocxFindingLocation) => void;
}) {
  const { t } = useTranslation("researchTools");
  const text = t(($) => $.researchTools.journal.template, { returnObjects: true });
  const review = t(($) => $.researchTools.docx.findingReview, { returnObjects: true });
  const workspace = t(($) => $.researchTools.workspace, { returnObjects: true });
  const checkId = check?.check_id;
  const hasComparison = !!world.template && !!check?.template_comparison;
  const contextKey = [
    world.version_id,
    project?.project_id ?? "",
    project?.baseline_id ?? "",
    checkId ?? "",
    check?.baseline_id ?? "",
  ].join("\u0000");
  const [findingReview, setFindingReview] = useState<{
    contextKey: string;
    groups: DocxFindingGroup[];
  } | null>(null);
  const [findingBusy, setFindingBusy] = useState(false);
  const [findingFailed, setFindingFailed] = useState(false);
  const groups = findingReview?.contextKey === contextKey ? findingReview.groups : null;

  useEffect(() => {
    setFindingReview(null);
    if (!checkId || !hasComparison) {
      setFindingBusy(false);
      setFindingFailed(false);
      return;
    }
    let active = true;
    setFindingBusy(true);
    setFindingFailed(false);
    void fetchDocxFindingGroups(checkId)
      .then((result) => {
        if (active) setFindingReview({ contextKey, groups: result.groups });
      })
      .catch(() => {
        if (active) setFindingFailed(true);
      })
      .finally(() => {
        if (active) setFindingBusy(false);
      });
    return () => { active = false; };
  }, [checkId, contextKey, hasComparison]);

  if (!world.template) return null;

  return <section className="space-y-3 rounded-lg border border-sidebar-border p-3 text-xs" data-testid="journal-template-facts">
    <p className="font-semibold">{text.title}</p>
    <p className="text-muted-foreground">{text.adopted}</p>
    {hasComparison && <div className="space-y-2">
      {findingBusy && <p role="status" className="text-muted-foreground">{review.loadingGroups}</p>}
      {findingFailed && <p role="alert" className="text-destructive">{workspace.journalTemplate.loadFailed}</p>}
      {groups && checkId && <DocxFindingBrowser
        checkId={checkId}
        groups={groups}
        title={text.differences}
        onJump={onJump}
      />}
    </div>}
  </section>;
}
