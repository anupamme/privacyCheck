#!/usr/bin/env node
/* =========================================================================
 *  Refresh public/browser-versions.json from the vendors' release feeds.
 *
 *  Run it by hand (`npm run update-browser-versions`) or let the scheduled
 *  GitHub Action in .github/workflows/update-browser-versions.yml commit the
 *  result. The server also refreshes the same data in memory at runtime — this
 *  file is the offline baseline shipped in the image.
 *
 *  A source that fails keeps its previous value instead of dropping out, so a
 *  vendor changing their feed degrades to "slightly stale", not "no data".
 *  Exit codes: 0 = written/unchanged, 1 = every source failed.
 * ========================================================================= */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchLatestBrowserVersions, BROWSERS } from "../lib/browser-versions.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "public", "browser-versions.json");

const previous = (() => {
  try { return JSON.parse(fs.readFileSync(OUT, "utf8")); } catch { return { latest: {}, full: {} }; }
})();

const { latest, full, errors } = await fetchLatestBrowserVersions();

if (!Object.keys(latest).length) {
  console.error("all sources failed — leaving " + path.basename(OUT) + " untouched:");
  for (const [name, err] of Object.entries(errors)) console.error(`  ${name}: ${err}`);
  process.exit(1);
}

const merged = { latest: {}, full: {} };
for (const name of BROWSERS) {
  const major = latest[name] ?? previous.latest?.[name];
  if (major == null) continue;
  merged.latest[name] = major;
  merged.full[name] = full[name] ?? previous.full?.[name] ?? String(major);
  const before = previous.latest?.[name];
  const mark = errors[name] ? "!" : before === major ? " " : "→";
  console.log(
    `${mark} ${name.padEnd(8)} ${String(before ?? "—").padStart(4)} -> ${String(major).padEnd(4)}` +
    ` (${merged.full[name]})${errors[name] ? `  [kept: ${errors[name]}]` : ""}`
  );
}

const changed = JSON.stringify(merged.latest) !== JSON.stringify(previous.latest ?? {});
const snapshot = {
  // Only bump the date when a number actually moved — otherwise every CI run
  // would produce a commit that says nothing.
  updated: changed || !previous.updated ? new Date().toISOString().slice(0, 10) : previous.updated,
  note: "Latest stable major versions, refreshed by tools/update-browser-versions.mjs. The server also refreshes this in memory; see /api/browser-versions.",
  ...merged,
};

fs.writeFileSync(OUT, JSON.stringify(snapshot, null, 2) + "\n");
console.log(`\n${changed ? "updated" : "unchanged"}: ${path.relative(process.cwd(), OUT)} (as of ${snapshot.updated})`);
