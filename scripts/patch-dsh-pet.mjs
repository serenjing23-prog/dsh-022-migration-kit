// Repair dsh-pet on DSH 0.2.3+ where `ctx.connection.authenticatedUrl` was removed.
//
// dsh-pet (0.3.x and 0.4.x alike) calls
//     const siteUrl = ctx.connection.authenticatedUrl(origin)
// which throws `TypeError: ctx.connection.authenticatedUrl is not a function`
// the moment the plugin loads, so the pet never appears. The value is only the
// site URL handed to the pet's helper window (a local loopback origin), so the
// origin itself is an equivalent fallback.
//
// What this does: rewrite only `ctx.connection.authenticatedUrl(<simple arg>)`
// into a guard that falls back to that argument. It never touches the package's
// own internal `authenticatedUrl(...)` method (standalone.js) and never touches
// any other file.
//
// usage: node patch-dsh-pet.mjs [--profile <dir>] [--dry-run]
// exit:  0 = ok (patched, already patched, or nothing to do), 1 = problem
import { readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const profileIdx = argv.indexOf("--profile");
const profileDir =
  profileIdx >= 0 && argv[profileIdx + 1]
    ? argv[profileIdx + 1]
    : join(homedir(), ".dsh", "profiles", "desktop");

const petDir = join(profileDir, "node_modules", "dsh-pet");
if (!existsSync(petDir)) {
  console.error(`dsh-pet not installed under ${profileDir}\\node_modules`);
  process.exit(1);
}

const MARK = "typeof ctx.connection.authenticatedUrl";
// Only a call whose single argument has no nested parentheses or commas.
const CALL = /ctx\.connection\.authenticatedUrl\(([^()]*)\)/g;

function guard(match, arg) {
  return `(typeof ctx.connection.authenticatedUrl === "function" ? ctx.connection.authenticatedUrl(${arg}) : (${arg}))`;
}

const libDir = join(petDir, "lib");
let files = [];
try {
  files = readdirSync(libDir).filter((f) => f.endsWith(".js"));
} catch {
  console.error(`no lib directory in ${petDir}`);
  process.exit(1);
}

let patchedFiles = 0;
let skippedFiles = 0;
let unresolved = 0;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

for (const name of files) {
  const file = join(libDir, name);
  let src;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (!src.includes("ctx.connection.authenticatedUrl(")) continue;

  if (src.includes(MARK)) {
    console.log(`= ${name}: already patched, skipped`);
    skippedFiles++;
    continue;
  }

  const before = (src.match(CALL) || []).length;
  if (!before) {
    console.log(`! ${name}: calls found but not in a patchable form; review by hand`);
    unresolved++;
    continue;
  }

  const next = src.replace(CALL, guard);
  const after = (next.match(/typeof ctx\.connection\.authenticatedUrl/g) || []).length;
  if (after !== before) {
    console.error(`! ${name}: replaced ${after} of ${before} calls; refusing to write`);
    unresolved++;
    continue;
  }

  if (dryRun) {
    console.log(`~ ${name}: would patch ${before} call(s)`);
    continue;
  }

  const backup = `${file}.bak-pet023-${stamp}`;
  try {
    copyFileSync(file, backup);
    writeFileSync(file, next, "utf8"); // no BOM: a BOM inside a JS module is risky
  } catch (e) {
    console.error(`! ${name}: not writable (${e.code || e.message}); run with write access to the profile`);
    unresolved++;
    continue;
  }
  console.log(`+ ${name}: patched ${before} call(s); backup ${backup}`);
  patchedFiles++;
}

if (!patchedFiles && !skippedFiles && !unresolved) {
  console.log("nothing to patch: no ctx.connection.authenticatedUrl call found");
}
if (unresolved) {
  console.error(`${unresolved} file(s) need manual review`);
  process.exit(1);
}
console.log(dryRun ? "dry run complete" : "done; restart DSH to load the pet again");
