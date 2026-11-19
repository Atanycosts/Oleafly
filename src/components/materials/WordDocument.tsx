import { forwardRef, useImperativeHandle, type ComponentProps, type ReactNode } from "react";
import { DocxEditor, useDocxEditor, type DocxEditorRef } from "@docx-editor.dev/react";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export type WordDocumentRef = Pick<DocxEditorRef, "getEditor" | "save">;
type Props = Omit<ComponentProps<typeof DocxEditor.Root>, "children"> & {
  title: string;
  className?: string;
  children?: ReactNode;
};

const DocumentBridge = forwardRef<WordDocumentRef>(function DocumentBridge(_, ref) {
  const editor = useDocxEditor();
  useImperativeHandle(ref, () => ({ getEditor: () => editor, save: () => editor?.save() ?? Promise.resolve(null) }), [editor]);
  return null;
});

/** Keep the engine session and viewport independent of Oleafly's shared commands. */
export const WordDocument = forwardRef<WordDocumentRef, Props>(function WordDocument({ title, className, children, ...props }, ref) {
  return <DocxEditor.Root {...props}>
    <DocumentBridge ref={ref} />
    <section aria-label={title} className={cn("relative flex h-full min-h-0 flex-col", className)}>
      <DocxEditor.Viewport className="relative min-h-0 flex-1">
        <DocxEditor.HeaderFooterChrome />
        <DocxEditor.NotesChrome />
        <DocxEditor.Content />
        {children}
      </DocxEditor.Viewport>
      <DocxEditor.Loading overlay indicator={<Spinner />} />
      <DocxEditor.OpenFailure />
    </section>
  </DocxEditor.Root>;
});
