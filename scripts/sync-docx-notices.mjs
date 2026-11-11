import { createRequire } from "node:module";
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
for (const name of ["core", "react", "fonts"]) {
  const source = path.resolve(path.dirname(require.resolve(`@docx-editor.dev/${name}`)), "..");
  const metadata = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
  const destination = path.join(root, "src-tauri/resources/licenses", `docx-editor-${metadata.version}`, name);
  const files = ["LICENSE", "THIRD_PARTY_NOTICES.md", ...(await readdir(path.join(source, "licenses"))).map((file) => `licenses/${file}`)];
  for (const file of files) {
    const bytes = await readFile(path.join(source, file));
    const target = path.join(destination, file);
    if (check) {
      if (!bytes.equals(await readFile(target))) throw new Error(`DOCX upstream notice is stale: ${target}`);
    } else {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
  }
}
console.log(check ? "DOCX notices match installed packages" : "DOCX upstream notices synchronized");
