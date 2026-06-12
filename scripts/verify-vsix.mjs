import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";

const vsixFiles = readdirSync(".")
  .filter((name) => /^tsperf-type-lens-\d+\.\d+\.\d+\.vsix$/.test(name))
  .sort();

if (vsixFiles.length === 0) {
  throw new Error("No tsperf-type-lens VSIX package found. Run npm run package first.");
}

const vsix = vsixFiles.at(-1);
const entries = execFileSync("unzip", ["-Z1", vsix], { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter(Boolean);

const requiredEntries = [
  "extension/package.json",
  "extension/README.md",
  "extension/LICENSE.txt",
  "extension/dist/extension.js",
  "extension/fixtures/pathological-types.ts"
];

const forbiddenPatterns = [
  /^extension\/node_modules\//,
  /^extension\/src\//,
  /(^|\/)\._/,
  /^extension\/tsconfig\.json$/,
  /^extension\/scripts\//,
  /^extension\/package-lock\.json$/
];

const missing = requiredEntries.filter((entry) => !entries.includes(entry));
const forbidden = entries.filter((entry) => forbiddenPatterns.some((pattern) => pattern.test(entry)));

if (missing.length > 0 || forbidden.length > 0) {
  if (missing.length > 0) {
    console.error("Missing VSIX entries:");
    for (const entry of missing) console.error(`- ${entry}`);
  }
  if (forbidden.length > 0) {
    console.error("Forbidden VSIX entries:");
    for (const entry of forbidden) console.error(`- ${entry}`);
  }
  process.exit(1);
}

console.log(`Verified ${vsix}: ${entries.length} packaged entries, no source/dependency/AppleDouble noise.`);
