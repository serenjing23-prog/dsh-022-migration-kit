// Fail loudly if any DSH config file starts with a UTF-8 BOM.
//
// Why this exists: DSH parses its patch layers as YAML. PowerShell 5.1's
// `Set-Content -Encoding UTF8` prepends EF BB BF, and the resulting file makes
// the Host die at boot with:
//   DesktopHostFatalError: dsh: failed to parse patches ... YAMLParseError:
//   Unexpected scalar at node end at line 1, column 4: 锘? insert:
// (锘? is the BOM decoded as GBK.) The app then self-recovers by rewriting the
// file, which looks like "it crashed and fixed itself".
//
// Run this after every upgrade and before any restart.
//
// usage: node check-bom.mjs [--fix]
//   --fix  rewrite offending files without the BOM (content otherwise untouched)
// exit:  0 = clean, 1 = BOM found (or still present after --fix)
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const ROOT = join(homedir(), ".dsh");
const PROFILE = join(ROOT, "profiles", "desktop");
const EXT = new Set([".yml", ".yaml", ".json"]);
const SKIP_DIRS = new Set(["node_modules", "sessions", "attachments", "cache", "electron", "dsh-runtimes", "storages"]);

const fix = process.argv.includes("--fix");
const offenders = [];

function walk(dir, depth) {
  if (depth > 4) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === "." || e.name === "..") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(p, depth + 1);
      continue;
    }
    const dot = e.name.lastIndexOf(".");
    if (dot < 0 || !EXT.has(e.name.slice(dot))) continue;
    let size = 0;
    try {
      size = statSync(p).size;
    } catch {
      continue;
    }
    if (size < 3 || size > 8 * 1024 * 1024) continue;
    let buf;
    try {
      buf = readFileSync(p);
    } catch {
      continue;
    }
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) offenders.push(p);
  }
}

walk(ROOT, 0);
// the profile dir is already covered by walk(ROOT); keep PROFILE referenced so
// the intent (profile configs are the ones that break boot) stays explicit.
void PROFILE;

if (!offenders.length) {
  console.log("OK: no UTF-8 BOM in any DSH config file");
  process.exit(0);
}

console.log(`BOM FOUND in ${offenders.length} file(s):`);
for (const p of offenders) console.log("  " + p);

if (!fix) {
  console.log("\nThese will make the next DSH start fail with a YAMLParseError.");
  console.log("Re-run with --fix to strip the BOM.");
  process.exit(1);
}

let failed = 0;
for (const p of offenders) {
  try {
    const buf = readFileSync(p);
    writeFileSync(p, buf.subarray(3));
    const after = readFileSync(p);
    if (after[0] === 0xef && after[1] === 0xbb && after[2] === 0xbf) throw new Error("BOM still present");
    console.log("  fixed: " + p);
  } catch (e) {
    failed++;
    console.log("  FAILED: " + p + " (" + e.message + ")");
  }
}
console.log(failed ? `\n${failed} file(s) still broken` : "\nAll fixed; restart DSH now.");
process.exit(failed ? 1 : 0);
