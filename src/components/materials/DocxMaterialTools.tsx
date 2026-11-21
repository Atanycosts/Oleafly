import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Eye, MessageSquarePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type DocxMaterialView = "working" | "original" | "compare";

interface Props {
  view: DocxMaterialView;
  onViewChange(view: DocxMaterialView): void;
  disabled?: boolean;
  onAnnotateWhole(): Promise<void>;
}

export function DocxMaterialTools({
  view,
  onViewChange,
  disabled = false,
  onAnnotateWhole,
}: Readonly<Props>) {
  const { t } = useTranslation("editor");
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function capture() {
    setCapturing(true);
    setError(null);
    try {
      await onAnnotateWhole();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCapturing(false);
    }
  }

  return <>
    <Select value={view} onValueChange={(value) => onViewChange(value as DocxMaterialView)}>
      <SelectTrigger className="h-8 w-40 text-xs" aria-label={t(($) => $.editor.materials.viewMode)}>
        <span className="flex min-w-0 items-center gap-1.5"><Eye className="size-3.5" /><SelectValue /></span>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="working">{t(($) => $.editor.materials.docxWorking)}</SelectItem>
        <SelectItem value="original">{t(($) => $.editor.materials.docxOriginal)}</SelectItem>
        <SelectItem value="compare">{t(($) => $.editor.materials.docxCompare)}</SelectItem>
      </SelectContent>
    </Select>
    <Button type="button" size="sm" variant="outline" disabled={disabled || capturing}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => void capture()}>
      <MessageSquarePlus className="mr-1 size-3.5" />{t(($) => $.editor.materials.annotateWhole)}
    </Button>
    {error && <span role="alert" className="max-w-80 text-xs text-destructive">{error}</span>}
  </>;
}
