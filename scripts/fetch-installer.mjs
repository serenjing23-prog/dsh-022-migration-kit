// Download the pending DSH desktop installer for the nightly channel and write
// update-info.json the way the app's updater would, so install-0.2.2.ps1 can be reused.
// usage: node fetch-installer.mjs <targetVersion>   e.g. 0.2.2-rc.5
import { createWriteStream } from "node:fs";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const FEED = "https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml";
const target = process.argv[2];
if (!target) {
  console.error("usage: node fetch-installer.mjs <version>");
  process.exit(2);
}

const pending = join(process.env.LOCALAPPDATA, "@deepseek-aidsh-desktop-updater", "pending");
await mkdir(pending, { recursive: true });

const feedText = await (await fetch(FEED)).text();
const version = /^version:\s*(\S+)/m.exec(feedText)?.[1];
const sha512 = /sha512:\s*>-\s*\n\s*(\S+)/.exec(feedText)?.[1];
const fileName = `deepseek-harness-${target}-win-x64.exe`;
if (version !== target) {
  console.error(`feed version ${version} != requested ${target}; refusing`);
  process.exit(3);
}
const url = `https://download.deepseek.com/dsh-desk/bin/win-x64/${fileName}`;

const dest = join(pending, fileName);
console.log(`downloading ${url}`);
const res = await fetch(url);
if (!res.ok) {
  console.error(`HTTP ${res.status}`);
  process.exit(4);
}
const total = Number(res.headers.get("content-length") || 0);
let seen = 0;
const hash = createHash("sha512");
const body = Readable.fromWeb(res.body);
body.on("data", (c) => {
  seen += c.length;
  hash.update(c);
  if (total && seen % (32 * 1024 * 1024) < c.length) {
    process.stdout.write(`  ${(seen / 1048576).toFixed(0)}/${(total / 1048576).toFixed(0)} MiB\n`);
  }
});
await pipeline(body, createWriteStream(dest));
const got = hash.digest("base64");
if (sha512 && got !== sha512) {
  await unlink(dest).catch(() => {});
  console.error(`sha512 mismatch: got ${got} want ${sha512}`);
  process.exit(5);
}
await writeFile(
  join(pending, "update-info.json"),
  JSON.stringify({ fileName, sha512: got, isAdminRightsRequired: false }),
  "utf8",
);
console.log(`OK ${dest} (${(seen / 1048576).toFixed(0)} MiB, sha512 verified)`);
