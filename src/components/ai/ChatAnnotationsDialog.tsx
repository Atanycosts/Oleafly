import { useTranslation } from "react-i18next";
import { CopyableBlock } from "@/components/ui/copyable-block";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TaskAnnotations } from "@/components/research/tasks/TaskAnnotations";
import type { AnnotationTarget, TaskAnnotation } from "@/lib/task-collaboration";

export interface ChatAnnotationsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: AnnotationTarget;
  source?: { role: "user" | "assistant"; content: string };
  onOpenTarget?: (target: AnnotationTarget) => void;
  onSaved?: (annotation: TaskAnnotation) => void;
}

export function ChatAnnotationsDialog({ open, onOpenChange, target, source, onOpenTarget, onSaved }: Readonly<ChatAnnotationsDialogProps>) {
  const { t } = useTranslation("researchTools");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-2xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{t(($) => $.researchTools.tasks.annotations.chatTitle)}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 space-y-3 overflow-y-auto">
          {source?.content ? (
            <CopyableBlock source={source.content}>
              <blockquote className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded border-l-2 bg-muted p-3 pr-10 text-sm">
                {source.content}
              </blockquote>
            </CopyableBlock>
          ) : null}
          <TaskAnnotations contextScope="object" objectTarget={target} source={source ? { kind: `chat_message:${source.role}`, content: source.content } : undefined} onOpenTarget={onOpenTarget} onSaved={onSaved} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
