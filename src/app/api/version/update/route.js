import { NextResponse } from "next/server";
import { killAppProcesses, spawnUpdaterAndExit } from "@/lib/appUpdater";

/**
 * Self-hosted / source builds opt out with DISABLE_UPDATE_CHECK=true. The update
 * flow installs the public npm package over the running install, so on a custom
 * fork it would silently discard local changes.
 */
function isUpdateCheckDisabled() {
  const v = String(process.env.DISABLE_UPDATE_CHECK || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export async function POST() {
  if (isUpdateCheckDisabled()) {
    return NextResponse.json(
      { success: false, message: "Self-managed build: the in-app updater is disabled (DISABLE_UPDATE_CHECK=true)." },
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
