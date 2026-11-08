import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const MAX_PAGES = 300;

export async function answerPdfTextRequest(token: string): Promise<void> {
  try {
    const bytes = await invoke<ArrayBuffer>("research_pdf_text_fetch", { token });
    const { extractPdfText } = await import("@/lib/pdf-text");
    const { pages } = await extractPdfText(new Uint8Array(bytes), { maxPages: MAX_PAGES });
    await invoke("research_pdf_text_result", { token, pages, error: null });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await invoke("research_pdf_text_result", { token, pages: null, error: message }).catch(() => {
      // The task stopped waiting; nothing is left to answer.
    });
  }
}

export async function answerPdfPagesRequest(token: string, pages: number[], scale: number): Promise<void> {
  try {
    const bytes = await invoke<ArrayBuffer>("research_pdf_pages_fetch", { token });
    const { renderPages } = await import("@/lib/pdf-image");
    const images: string[] = [];
    for await (const image of renderPages(new Uint8Array(bytes), pages, scale)) images.push(image.slice("data:image/png;base64,".length));
    await invoke("research_pdf_pages_result", { token, images, error: null });
  } catch (error) {
    await invoke("research_pdf_pages_result", { token, images: null, error: error instanceof Error ? error.message : String(error) }).catch(() => {});
  }
}

export async function mountResearchPdfBridge(): Promise<() => void> {
  const stopText = await listen<{ token: string }>("research-pdf-text-request", (event) => {
    void answerPdfTextRequest(event.payload.token);
  });
  try {
    const stopPages = await listen<{ token: string; pages: number[]; scale: number }>("research-pdf-pages-request", (event) => {
      void answerPdfPagesRequest(event.payload.token, event.payload.pages, event.payload.scale);
    });
    return () => { stopText(); stopPages(); };
  } catch (error) { stopText(); throw error; }
}
