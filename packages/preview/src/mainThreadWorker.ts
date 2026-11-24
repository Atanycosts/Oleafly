import workerSrc from "./pdf.worker?worker&url";
import { dropNativeDecompression } from "./worker-decompression";

type PdfWorkerModule = {
  WorkerMessageHandler?: unknown;
};

export function installPdfWorkerModule(workerModule: PdfWorkerModule) {
  const handler = workerModule.WorkerMessageHandler as { setup?: unknown } | undefined;
  if (typeof handler?.setup !== "function") {
    throw new TypeError("PDF worker module does not expose WorkerMessageHandler.setup");
  }
  (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = workerModule;
}

export async function installMainThreadPdfWorker() {
  await import("./polyfills");
  dropNativeDecompression(globalThis, globalThis.navigator?.userAgent ?? "");
  const workerModule = import.meta.env.PROD
    ? await import(/* @vite-ignore */ workerSrc)
    : await import("pdfjs-dist/build/pdf.worker.min.mjs");
  installPdfWorkerModule(workerModule);
}
