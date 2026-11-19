import { isTauri } from "@tauri-apps/api/core";
import { bytesToBase64 } from "@/lib/base64";
import { pickSavePath } from "@/lib/native-file-dialog";
import { writeBytesFile } from "@/lib/tauri";

/** Use the application's picked-path grant for desktop copies. */
export type DocxDownloadResult =
  | { status: "saved"; path: string }
  | { status: "cancelled" }
  | { status: "download_requested" };

export async function downloadDocxCopy(bytes: Uint8Array, filename: string): Promise<DocxDownloadResult> {
  if (isTauri()) {
    const destination = await pickSavePath({ defaultPath: filename, filters: [{ name: "DOCX", extensions: ["docx"] }] });
    if (!destination) return { status: "cancelled" };
    await writeBytesFile(destination, bytesToBase64(bytes));
    return { status: "saved", path: destination };
  }
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return { status: "download_requested" };
}
