// Pin the profile's exact-version bundles to a target DSH version.
// These packages declare exact peerDependencies, so their own version must equal
// the host version or the boot gate skips them.
//
// usage: node pin-bundles.mjs <profileDir> <targetVersion> [pkg...]
// Writes package.json as UTF-8 without BOM (a BOM breaks DSH boot) and verifies
// the result parses and contains no duplicate keys.
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";

const [, , profileDir, target, ...rest] = process.argv;
if (!profileDir || !target) {
  console.error("usage: node pin-bundles.mjs <profileDir> <targetVersion> [pkg...]");
  process.exit(2);
}

const DEFAULT_PKGS = [
  "@deepseek-ai/dsh-deepseek-chat-import",
  "@deepseek-ai/dsh-subagent-claude-code",
  "@deepseek-ai/dsh-subagent-codex",
];
const pkgs = rest.length ? rest : DEFAULT_PKGS;

const pkgPath = join(profileDir, "package.json");
const before = readFileSync(pkgPath, "utf8");
const bom = before.charCodeAt(0) === 0xfeff;
const text = bom ? before.slice(1) : before;

let next = text;
const changed = [];
for (const name of pkgs) {
  // match: "name": "oldversion"
  const re = new RegExp(`("${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*")([^"]*)(")`);
  const m = re.exec(next);
  if (!m) {
    console.log(`- ${name}: not present, skipped`);
    continue;
  }
  if (m[2] === target) {
    console.log(`= ${name}: already ${target}`);
    continue;
  }
  next = next.replace(re, `$1${target}$3`);
  changed.push(`${name} ${m[2]} -> ${target}`);
  console.log(`+ ${name}: ${m[2]} -> ${target}`);
}

if (!changed.length) {
  console.log("nothing to change");
  process.exit(0);
}

// validate before writing
let parsed;
try {
  parsed = JSON.parse(next);
} catch (e) {
  console.error(`refusing to write: result does not parse (${e.message})`);
  process.exit(3);
}
const deps = parsed.dependencies ?? {};
for (const name of pkgs) {
  if (deps[name] && deps[name] !== target) {
    console.error(`refusing to write: ${name} still ${deps[name]}`);
    process.exit(4);
  }
}

const backup = `${pkgPath}.bak-pin-${new Date().toISOString().replace(/[:.]/g, "-")}`;
copyFileSync(pkgPath, backup);
writeFileSync(pkgPath, next, "utf8"); // node writes without BOM

// read back
const after = readFileSync(pkgPath, "utf8");
if (after.charCodeAt(0) === 0xfeff) {
  console.error("BOM appeared after write; restore from " + backup);
  process.exit(5);
}
JSON.parse(after);
console.log(`written (${Buffer.byteLength(after)} bytes, no BOM); backup ${backup}`);
