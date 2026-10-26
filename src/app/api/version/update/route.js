import { NextResponse } from "next/server";
import { killAppProcesses, spawnUpdaterAndExit } from "@/lib/appUpdater";

/**
 * Self-hosted / source builds opt out with DISABLE_UPDATE_CHECK=true. This fork
 * additionally keeps the npm updater off unless explicitly enabled, because
 * `npm i -g 9router` would replace the fork with the public package.
 */
function isUpdateCheckDisabled() {
  const v = String(process.env.DISABLE_UPDATE_CHECK || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function isInAppUpdateDisabled() {
  const v = String(process.env.DISABLE_IN_APP_UPDATE ?? "true").trim().toLowerCase();
  // Opt-in only: anything except an explicit false keeps the npm updater off.
  return !(v === "0" || v === "false" || v === "no" || v === "off");
}

export async function POST() {
  if (isUpdateCheckDisabled() || isInAppUpdateDisabled()) {
    return NextResponse.json(
      { success: false, message: "Self-managed fork: the in-app npm updater is disabled (DISABLE_IN_APP_UPDATE)." },
      { status: 403 }
    );
  }

  if (process.env.NODE_ENV !== "production") {
    return NextResponse.json(
      { success: false, message: "Update is only available in production build (9router CLI)" },
      { status: 403 }
    );
  }

  try {
    // Kill sibling processes (cloudflared, MITM, stray next-server) to release file locks on Windows
    await killAppProcesses();
  } catch { /* best effort */ }

  // Schedule detached updater then exit current server process
  spawnUpdaterAndExit();

  return NextResponse.json({ success: true, message: "Updater started. This app will exit shortly." });
}
