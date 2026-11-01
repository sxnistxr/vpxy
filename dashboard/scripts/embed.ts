// Copies the exported dashboard into the Go embed directory (internal/vpxydash/dist).
// Precompressed copies are skipped: the Go server compresses responses itself.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const from = join(import.meta.dir, "..", "dist", "static");
const to = join(import.meta.dir, "..", "..", "internal", "vpxydash", "dist");

if (!existsSync(join(from, "index.html"))) {
  throw new Error(`no export at ${from}; run "optz export" first`);
}
rmSync(to, { recursive: true, force: true });
mkdirSync(join(to, "assets"), { recursive: true });
cpSync(join(from, "index.html"), join(to, "index.html"));
let copied = 1;
for (const name of readdirSync(join(from, "assets"))) {
  if (name.endsWith(".gz") || name.endsWith(".br")) continue;
  cpSync(join(from, "assets", name), join(to, "assets", name));
  copied++;
}
console.log(`embed: copied ${copied} files to ${to}`);
