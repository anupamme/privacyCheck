/* =========================================================================
 *  Latest-stable browser versions — live lookup
 *
 *  The "Browser up to date?" card compares the visitor's parsed browser major
 *  against the current stable release. Hardcoding those numbers rots within
 *  weeks (Chrome/Edge ship every ~4 weeks, Firefox every ~4), so we pull them
 *  from each vendor's own release feed instead.
 *
 *  Two consumers:
 *    - tools/update-browser-versions.mjs  — refreshes the committed snapshot
 *      public/browser-versions.json (run by CI on a schedule).
 *    - server.js — refreshes the same data in memory, so a long-running
 *      deployment stays current even if nobody rebuilds the image.
 *
 *  No dependencies: Node 20+ global fetch only.
 * ========================================================================= */

const TIMEOUT_MS = 8000;
// Some of these endpoints are picky about a missing/!browser UA.
const UA = "privacyCheck/1.0 (+https://github.com/sglogger/privacyCheck)";

async function get(url, as = "json") {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "user-agent": UA, accept: as === "json" ? "application/json" : "*/*" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return as === "json" ? res.json() : res.text();
}

const majorOf = (v) => parseInt(String(v).split(".")[0], 10);
const cmpVersion = (a, b) => {
  const pa = String(a).split("."), pb = String(b).split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (parseInt(pa[i], 10) || 0) - (parseInt(pb[i], 10) || 0);
    if (d) return d;
  }
  return 0;
};
const highest = (versions) => versions.sort(cmpVersion).at(-1);

/* ---- per-vendor fetchers -------------------------------------------------
 * Each returns the full version string; the caller derives the major. They
 * throw on failure — one dead source must not take the others down.
 * ---------------------------------------------------------------------- */

// Chromium's release dashboard. Chrome rolls a new major out gradually, so for
// a while two majors are both "Stable" — the new one with a single early-rollout
// build, the old one still getting patches. Treating that lone build as "latest"
// would flag the whole install base as one version behind, so we require a major
// to have shipped at least two stable builds before we call it current.
async function chrome() {
  const rows = await get("https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Windows&num=30");
  if (!Array.isArray(rows) || !rows.length) throw new Error("empty release list");
  const byMajor = new Map();
  for (const r of rows) {
    const m = majorOf(r.version);
    if (!Number.isFinite(m)) continue;
    if (!byMajor.has(m)) byMajor.set(m, new Set());
    byMajor.get(m).add(r.version);
  }
  const rolled = [...byMajor.entries()].filter(([, v]) => v.size >= 2).map(([m]) => m);
  const major = rolled.length ? Math.max(...rolled) : Math.max(...byMajor.keys());
  return highest([...byMajor.get(major)]);
}

// Microsoft's Edge update API lists every channel; we want Stable's newest build.
async function edge() {
  const products = await get("https://edgeupdates.microsoft.com/api/products?view=enterprise");
  const stable = (products || []).find((p) => p.Product === "Stable");
  const versions = (stable?.Releases || []).map((r) => r.ProductVersion).filter(Boolean);
  if (!versions.length) throw new Error("no Stable releases");
  return highest(versions);
}

// Mozilla publishes the canonical version map as a tiny JSON file.
async function firefox() {
  const j = await get("https://product-details.mozilla.org/1.0/firefox_versions.json");
  const v = j?.LATEST_FIREFOX_VERSION;
  if (!v) throw new Error("LATEST_FIREFOX_VERSION missing");
  return v;
}

// Opera has no version API; every stable release gets a blog post titled
// "Opera <version> Stable update" on the desktop blog.
async function opera() {
  const xml = await get("https://blogs.opera.com/desktop/feed/", "text");
  const versions = [...xml.matchAll(/Opera\s+(\d+(?:\.\d+)*)\s+stable\s+update/gi)].map((m) => m[1]);
  if (!versions.length) throw new Error("no stable post in feed");
  return highest(versions);
}

// Apple has no version API either, but the Safari release notes are a DocC
// bundle whose JSON lists one "Safari <version> Release Notes" page per release.
async function safari() {
  const doc = await get("https://developer.apple.com/tutorials/data/documentation/safari-release-notes.json");
  const versions = Object.values(doc?.references || {})
    .map((r) => /^Safari (\d+(?:\.\d+)*) Release Notes$/.exec(r?.title || "")?.[1])
    .filter(Boolean);
  if (!versions.length) throw new Error("no release-note pages found");
  return highest(versions);
}

// Keys must match the browser names detectBrowserVersion() produces in app.js.
const FETCHERS = { Chrome: chrome, Edge: edge, Firefox: firefox, Opera: opera, Safari: safari };

/**
 * Look every browser up in parallel. Sources fail independently: a source that
 * errors is reported in `errors` and simply omitted from `latest`, so callers
 * can keep their previous value for it.
 *
 * @returns {Promise<{latest: Record<string, number>, full: Record<string, string>, errors: Record<string, string>}>}
 */
export async function fetchLatestBrowserVersions() {
  const entries = await Promise.all(
    Object.entries(FETCHERS).map(async ([name, fn]) => {
      try {
        const version = await fn();
        const major = majorOf(version);
        if (!Number.isFinite(major)) throw new Error(`unparsable version "${version}"`);
        return [name, { major, version, error: null }];
      } catch (err) {
        return [name, { major: null, version: null, error: String(err?.message || err) }];
      }
    })
  );

  const latest = {}, full = {}, errors = {};
  for (const [name, r] of entries) {
    if (r.error) errors[name] = r.error;
    else { latest[name] = r.major; full[name] = r.version; }
  }
  return { latest, full, errors };
}

export const BROWSERS = Object.keys(FETCHERS);
