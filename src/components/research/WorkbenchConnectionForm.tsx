import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { pickOpenPaths } from "@/lib/tauri";

export function WorkbenchConnectionForm({ busy, onConnect }: {
  busy: boolean;
  onConnect: (python: string) => void;
}) {
  const { t } = useTranslation("researchTools");
  const [python, setPython] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const pythonLabel = t(($) => $.researchTools.journal.python);
  const disabled = busy || browsing;

  async function browse() {
    setBrowsing(true);
    setBrowseError(null);
    try {
      const paths = await pickOpenPaths({ title: pythonLabel });
      if (paths?.[0]) setPython(paths[0]);
    } catch (cause) {
      setBrowseError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBrowsing(false);
    }
  }

  return (
    <form className="w-full max-w-lg space-y-3 text-left" onSubmit={(event) => {
      event.preventDefault();
      if (disabled || !python.trim()) return;
      setBrowseError(null);
      onConnect(python.trim());
    }}>
      <p className="text-sm text-muted-foreground">{t(($) => $.researchTools.journal.runtimeHelp)}</p>
      <Input value={python} disabled={disabled} onChange={(event) => setPython(event.target.value)}
        aria-label={pythonLabel} placeholder={pythonLabel} />
      {browseError && <p role="alert" className="break-words text-sm text-destructive">{browseError}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={disabled} onClick={() => void browse()}>
          {t(($) => $.researchTools.journal.browse)}
        </Button>
        <Button type="submit" disabled={disabled || !python.trim()}>{t(($) => $.researchTools.journal.connect)}</Button>
      </div>
    </form>
  );
}
