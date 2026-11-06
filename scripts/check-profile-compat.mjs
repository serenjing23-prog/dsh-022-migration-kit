#!/usr/bin/env node
/**
 * check-profile-compat.mjs — DSH profile pre-upgrade compatibility checker.
 *
 * Answers: after upgrading DSH to <target>, which bundles will be SKIPPED, which
 * are retired, and which duplicate functionality the new release ships.
 *
 * The gate reproduced here is the one in @deepseek-ai/dsh-app-boot 0.2.2:
 *   - `dsh.engines.dsh` decides ALONE; peerDependencies are then ignored.
 *   - otherwise every peer that is `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*`
 *     must match; peers such as @deepseek-ai/cordis are NOT checked.
 *   - matching is `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`,
 *     so prerelease targets DO participate in ranges (>=0.2.1-rc.3 matches 0.2.2-rc.1).
 *   - `workspace:^`, `workspace:~`, `workspace:*` in peers mean the current runtime.
 *
 * Zero dependencies, Node >= 18.
 *
 * Usage:
 *   node scripts/check-profile-compat.mjs --profile "C:/Users/me/.dsh/profiles/desktop"
 *   node scripts/check-profile-compat.mjs --profile <dir> --target 0.2.2-rc.1
 *   node scripts/check-profile-compat.mjs --profile <dir> --json
 *
 * Exit codes: 0 = nothing will be skipped, 2 = at least one bundle will be skipped.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------ *
 * Minimal semver with includePrerelease support
 * ------------------------------------------------------------------ */

const RE_VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(text) {
  const m = RE_VERSION.exec(String(text).trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] };
}

const mk = (major, minor, patch, pre = []) => ({ major, minor, patch, pre });

function compareIdent(a, b) {
  const na = /^\d+$/.test(a);
  const nb = /^\d+$/.test(b);
  if (na && nb) return Number(a) - Number(b);
  if (na) return -1;
  if (nb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function compare(a, b) {
  for (const k of ['major', 'minor', 'patch']) if (a[k] !== b[k]) return a[k] - b[k];
  if (!a.pre.length && !b.pre.length) return 0;
  if (!a.pre.length) return 1;
  if (!b.pre.length) return -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
    if (a.pre[i] === undefined) return -1;
    if (b.pre[i] === undefined) return 1;
    const c = compareIdent(a.pre[i], b.pre[i]);
    if (c) return c;
  }
  return 0;
}

function boundsOf(token) {
  const m = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(token.trim());
  if (!m) return null;
  const op = m[1] || '=';
  const raw = m[2].trim();
  if (raw === '' || raw === '*' || raw === 'x' || raw === 'X') return { any: true };

  const parts = raw.split('.');
  const wildcard = parts.findIndex((p) => p === 'x' || p === 'X' || p === '*');
  const known = wildcard === -1 ? parts.length : wildcard;
  if (known < 3) {
    const major = Number(parts[0]);
    const minor = known >= 2 ? Number(parts[1]) : 0;
    if (!Number.isFinite(major)) return null;
    if (known === 1) return { lower: mk(major, 0, 0), lowerInclusive: true, upper: mk(major + 1, 0, 0), upperInclusive: false };
    return { lower: mk(major, minor, 0), lowerInclusive: true, upper: mk(major, minor + 1, 0), upperInclusive: false };
  }

  const v = parseVersion(raw);
  if (!v) return null;
  const hasPre = v.pre.length > 0;
  switch (op) {
    case '^': {
      const upper = v.major > 0 ? mk(v.major + 1, 0, 0) : v.minor > 0 ? mk(0, v.minor + 1, 0) : mk(0, 0, v.patch + 1);
      return { lower: v, lowerInclusive: true, upper, upperInclusive: false, prerelease: hasPre };
    }
    case '~':
      return { lower: v, lowerInclusive: true, upper: mk(v.major, v.minor + 1, 0), upperInclusive: false, prerelease: hasPre };
    case '>=': return { lower: v, lowerInclusive: true, prerelease: hasPre };
    case '>': return { lower: v, lowerInclusive: false, prerelease: hasPre };
    case '<=': return { upper: v, upperInclusive: true, prerelease: hasPre };
    case '<': return { upper: v, upperInclusive: false, prerelease: hasPre };
    default: return { lower: v, lowerInclusive: true, upper: v, upperInclusive: true, exact: true, prerelease: hasPre };
  }
}

function inBounds(version, b, includePrerelease) {
  if (b.any) return includePrerelease ? true : version.pre.length === 0;
  if (b.lower) {
    const c = compare(version, b.lower);
    if (b.lowerInclusive === false ? c <= 0 : c < 0) return false;
  }
  if (b.upper) {
    const c = compare(version, b.upper);
    if (b.upperInclusive === false ? c >= 0 : c > 0) return false;
  }
  return true;
}

/**
 * npm-compatible satisfies(). With includePrerelease (DSH's choice) the
 * "prerelease needs a same-tuple comparator" rule is waived.
 */
export function satisfies(versionText, rangeText, { includePrerelease = true } = {}) {
  const version = parseVersion(versionText);
  if (!version) return { ok: false, reason: `invalid version ${versionText}` };
  const sets = String(rangeText).split('||').map((s) => s.trim()).filter(Boolean);
  if (!sets.length) return { ok: false, reason: 'empty range' };
  let reason = '';
  for (const set of sets) {
    const tokens = set.split(/\s+/).filter(Boolean);
    let ok = true;
    let anchor = false;
    for (const token of tokens) {
      if (token === '-') { ok = false; reason = 'hyphen range unsupported'; break; }
      const b = boundsOf(token);
      if (!b || !inBounds(version, b, includePrerelease)) { ok = false; reason = `fails ${token}`; break; }
      if (b.prerelease && b.lower && b.lower.major === version.major && b.lower.minor === version.minor && b.lower.patch === version.patch) anchor = true;
    }
    if (!ok) continue;
    if (!includePrerelease && version.pre.length > 0 && !anchor) { reason = 'prerelease without same-version comparator'; continue; }
    return { ok: true };
  }
  return { ok: false, reason: reason || 'no comparator matched' };
}

/* ------------------------------------------------------------------ *
 * Profile inspection
 * ------------------------------------------------------------------ */

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const isDshPeer = (name) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-');

function resolvePackage(profileDir, name) {
  const file = path.join(profileDir, 'node_modules', ...name.split('/'), 'package.json');
  const pkg = readJson(file);
  return pkg ? { pkg, dir: path.dirname(file) } : null;
}

/** Mirror evaluatePluginCompatibility(): engines.dsh decides alone, else @deepseek-ai/dsh* peers. */
function gateOf(pkg, target) {
  const fields = pkg.dsh || {};
  if (fields.engines && Object.hasOwn(fields.engines, 'dsh')) {
    const range = fields.engines.dsh;
    if (typeof range !== 'string') return [{ field: 'dsh.engines.dsh', range: String(range), ok: false, reason: 'not a string' }];
    return [{ field: 'dsh.engines.dsh', range, ...satisfies(target, range), decidesAlone: true }];
  }
  const out = [];
  for (const [name, range] of Object.entries(pkg.peerDependencies || {})) {
    if (!isDshPeer(name) || typeof range !== 'string') continue;
    const normalized = ['workspace:^', 'workspace:~', 'workspace:*'].includes(range) ? target : range;
    out.push({ field: `peerDeps.${name}`, range, ...satisfies(target, normalized) });
  }
  return out;
}

function main() {
const args = process.argv.slice(2);
const getArg = (name, fallback) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1]; };
const profileArg = getArg('--profile');
const target = getArg('--target', '0.2.2-rc.1');
const asJson = args.includes('--json');
const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = getArg('--data', path.join(here, '..', 'data'));

if (!profileArg) {
  console.error('usage: node check-profile-compat.mjs --profile <profile-dir> [--target 0.2.2-rc.1] [--json]');
  process.exit(1);
}

const profileDir = path.resolve(profileArg);
const profilePkg = readJson(path.join(profileDir, 'package.json'));
if (!profilePkg) {
  console.error(`not a DSH profile (no package.json): ${profileDir}`);
  process.exit(1);
}

const bundles = profilePkg.dsh?.profile?.bundles ?? [];
const depended = Object.keys(profilePkg.dependencies ?? {});
const official = readJson(path.join(dataDir, `official-bundles-${target.replace(/\./g, '-')}.json`)) ?? readJson(path.join(dataDir, 'official-bundles.json'));
const retired = new Set(official?.retired ?? []);
const duplicates = readJson(path.join(dataDir, 'duplicates.json')) ?? [];
const duplicateByName = new Map();
for (const row of duplicates) for (const name of [].concat(row.community)) duplicateByName.set(name, row);

function inspect(name) {
  const found = resolvePackage(profileDir, name);
  if (!found) {
    return name.startsWith('@deepseek-ai/')
      ? { name, status: 'app-provided', detail: 'shipped by the DSH installation' }
      : { name, status: 'missing', detail: 'in dsh.profile.bundles but not installed — it will be skipped' };
  }
  const gates = gateOf(found.pkg, target);
  const failed = gates.filter((g) => !g.ok);
  const row = {
    name,
    version: found.pkg.version,
    status: failed.length ? 'skip-risk' : gates.length ? 'ok' : 'no-gate',
    gates,
    failed,
    detail: failed.length
      ? failed.map((f) => `${f.field}=${f.range} (${f.reason})`).join(' | ')
      : gates.length ? `${gates.length} gate(s) satisfied` : 'no dsh/peer gate declared',
  };
  if (retired.has(name)) {
    row.status = 'retired';
    row.detail = `retired by ${target}: remove from dsh.profile.bundles`;
  }
  const dup = duplicateByName.get(name);
  if (dup) row.duplicate = dup;
  return row;
}

const bundleRows = bundles.map(inspect);
const depRows = depended.filter((n) => !bundles.includes(n)).map(inspect);

// Duplicates that are installed as transitive sub-packages of a meta bundle
// (e.g. @linxin666/dsh-web-all) never appear in dsh.profile.bundles; report them
// from the installed tree instead.
const installedDirs = new Set();
for (const scope of ['', '@linxin666', '@deepseek-ai', '@liustack', '@ljwei-stak', '@weibaohui', '@local']) {
  const dir = path.join(profileDir, 'node_modules', scope);
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) installedDirs.add(scope ? `${scope}/${entry.name}` : entry.name);
    }
  } catch { /* scope missing */ }
}
const installedDuplicates = duplicates.filter((row) => [].concat(row.community).some((n) => installedDirs.has(n)));

const summary = {
  target,
  profile: profileDir,
  bundles: bundleRows,
  dependencies: depRows,
  installedDuplicates,
  counts: {
    bundles: bundleRows.length,
    skip: bundleRows.filter((r) => r.status === 'skip-risk' || r.status === 'missing').length,
    retired: bundleRows.filter((r) => r.status === 'retired').length,
    duplicatesInstalled: installedDuplicates.length,
  },
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  const pad = (s, n) => String(s ?? '').padEnd(n);
  console.log('\nDSH profile compatibility check');
  console.log(`  profile : ${profileDir}`);
  console.log(`  target  : ${target}`);
  console.log(`  bundles : ${bundleRows.length}\n`);
  const order = { 'skip-risk': 0, retired: 1, missing: 2, 'no-gate': 3, ok: 4, 'app-provided': 5 };
  const icon = { ok: 'OK  ', 'skip-risk': 'SKIP', 'no-gate': '--  ', 'app-provided': 'APP ', missing: 'MISS', retired: 'RET ' };
  for (const r of [...bundleRows].sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name))) {
    console.log(`${icon[r.status]} ${pad(r.name, 56)} ${pad(r.version, 10)} ${r.detail}`);
  }
  if (installedDuplicates.length) {
    console.log('\nofficial functionality you also installed from the community:');
    for (const row of installedDuplicates) {
      console.log(`  - ${[].concat(row.community).join(', ')} -> ${[].concat(row.officialEquivalent).join(', ')}  [${row.verdict}]`);
    }
  }
  console.log(`\nsummary: ${summary.counts.skip} will be skipped, ${summary.counts.retired} retired, ${summary.counts.duplicatesInstalled} duplicate(s)\n`);
}

process.exit(summary.counts.skip ? 2 : 0);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
