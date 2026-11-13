// Bundles tools/dump-import.ts (with an Obsidian-like converter in place of the `obsidian`
// module) and runs it. Usage: npm run dump-import -- --dump <file|url> --vault <folder> …
import esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const outfile = path.join(root, ".tool-build", "dump-import.mjs");

await esbuild.build({
	entryPoints: [path.join(root, "tools", "dump-import.ts")],
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node20",
	outfile,
	packages: "external",
	alias: { obsidian: path.join(root, "tools", "markdown-shim.ts") },
	logLevel: "warning",
});

const result = spawnSync(process.execPath, ["--max-old-space-size=8192", outfile, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
