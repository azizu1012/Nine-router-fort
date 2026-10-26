import { NextResponse } from "next/server";
import { killAppProcesses } from "@/lib/appUpdater";

// This route exists only to hand the machine over to the in-app updater. On a
// self-managed build it must refuse, or a stray click would kill the server
// without anything taking over.
function isUpdateCheckDisabled() {
  const v = String(process.env.DISABLE_UPDATE_CHECK || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function isInAppUpdateDisabled() {
  const v = String(process.env.DISABLE_IN_APP_UPDATE ?? "true").trim().toLowerCase();
  // Opt-in only: anything except an explicit false keeps the npm updater off.
  return !(v === "0" || v === "false" || v === "no" || v === "off");
}

// Shutdown app to release file locks for manual update
export async function POST() {
  if (isUpdateCheckDisabled() || isInAppUpdateDisabled()) {
    return NextResponse.json(
      { success: false, message: "Self-managed fork: updater shutdown is disabled (DISABLE_IN_APP_UPDATE)." },
      { status: 403 }
    );
  }

  try {
    await killAppProcesses();
  } catch { /* best effort */ }

  const response = NextResponse.json({ success: true, message: "Shutting down for manual update..." });

  setTimeout(() => process.exit(0), 500);

  return response;
}
