import { PluginClient, TauriPage, type BrowserPageAdapter } from "@srsholmes/tauri-playwright";

/** Capture the actual WebView pixels without depending on macOS screen access. */
export async function webviewScreenshot(page: TauriPage | BrowserPageAdapter, path: string) {
  if (!(page instanceof TauriPage)) return page.screenshot({ path });
  const client = new PluginClient(process.env.TAURI_PLAYWRIGHT_SOCKET ?? "/tmp/tauri-playwright.sock");
  await client.connect();
  try {
    const result = await client.send({ type: "screenshot", window: "main", path });
    if (!result.ok) throw new Error(`WebView screenshot failed: ${result.error}`);
  } finally {
    client.disconnect();
  }
}
