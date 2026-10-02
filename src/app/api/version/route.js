import https from "https";
import pkg from "../../../../package.json" with { type: "json" };

const NPM_PACKAGE_NAME = "9router";
const VERSION_CACHE_TTL_MS = 3600000; // cache npm latest lookup for 1h

/**
 * Opt-out for self-hosted / source builds.
 *
 * `currentVersion` is baked in from package.json at build time, so a build cut
 * from the newest tag never reports an update. This flag exists for the case
 * where the operator deliberately runs a private fork: the "Update now" flow
 * runs `npm i -g 9router`, which would replace the custom build with the public
 * npm package and drop local changes. Set DISABLE_UPDATE_CHECK=true to keep the
 * feature but never surface it.
 */
function isUpdateCheckDisabled() {
  const v = String(process.env.DISABLE_UPDATE_CHECK || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// Survive hot reload; one cache per process
const versionCache = (global.__npmVersionCache ??= { value: null, fetchedAt: 0 });

// Fetch latest version from npm registry
function fetchLatestVersion() {
  return new Promise((resolve) => {
    const req = https.get(
      `https://registry.npmjs.org/${NPM_PACKAGE_NAME}/latest`,
      { timeout: 4000 },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data).version || null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

async function getLatestVersionCached() {
  if (versionCache.value && Date.now() - versionCache.fetchedAt < VERSION_CACHE_TTL_MS) {
    return versionCache.value;
  }
  const latest = await fetchLatestVersion();
  if (latest) {
    versionCache.value = latest;
    versionCache.fetchedAt = Date.now();
  }
  return latest;
}

export async function GET() {
  const currentVersion = pkg.version;

  if (isUpdateCheckDisabled()) {
    return Response.json({ currentVersion, latestVersion: null, hasUpdate: false, updateCheckDisabled: true });
  }

  const latestVersion = await getLatestVersionCached();
  const hasUpdate = latestVersion ? compareVersions(latestVersion, currentVersion) > 0 : false;

  return Response.json({ currentVersion, latestVersion, hasUpdate });
}
