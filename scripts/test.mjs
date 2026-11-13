// Bundles test/*.test.ts with a stand-in for the `obsidian` module, then runs them with
// Node's built-in test runner. Usage: npm test
import esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const outdir = path.join(root, ".test-build");
const tests = readdirSync(path.join(root, "test")).filter((f) => f.endsWith(".test.ts"));

rmSync(outdir, { recursive: true, force: true });
await esbuild.build({
	entryPoints: tests.map((f) => path.join(root, "test", f)),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node20",
	outdir,
	outExtension: { ".js": ".mjs" },
	packages: "external",
	alias: { obsidian: path.join(root, "test", "support", "obsidian-stub.ts") },
	inject: [path.join(root, "test", "support", "dom.ts")],
	logLevel: "warning",
});

const files = tests.map((f) => path.join(outdir, f.replace(/\.ts$/, ".mjs")));
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
