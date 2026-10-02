import { NextResponse } from "next/server";
import { deleteApiKey, getApiKeyById, updateApiKey } from "@/lib/localDb";

// GET /api/keys/[id] - Get single key
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    return NextResponse.json({ key });
  } catch (error) {
    console.log("Error fetching key:", error);
    return NextResponse.json({ error: "Failed to fetch key" }, { status: 500 });
  }
}

// PUT /api/keys/[id] - Update key
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { isActive, name, allowedProviders, limitTpm, limitRpd, limitConcurrency } = body;

    const existing = await getApiKeyById(id);
    if (!existing) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    const updateData = {};
    if (isActive !== undefined) updateData.isActive = isActive;
    if (typeof name === "string" && name.trim()) updateData.name = name.trim();
    if (allowedProviders !== undefined) {
      updateData.allowedProviders = Array.isArray(allowedProviders) ? allowedProviders : null;
    }
    for (const [field, value] of [["limitTpm", limitTpm], ["limitRpd", limitRpd], ["limitConcurrency", limitConcurrency]]) {
      if (value !== undefined) updateData[field] = value;
    }

    const updated = await updateApiKey(id, updateData);
    // A changed pause/allow-list/limit must take effect on the next request.
    const { invalidateApiKeyCache } = await import("@/sse/services/auth.js");
    const { getApiKeyById } = await import("@/lib/localDb");
    invalidateApiKeyCache((await getApiKeyById(id))?.key || null);
    invalidateApiKeyCache();

    return NextResponse.json({ key: updated });
  } catch (error) {
    console.log("Error updating key:", error);
    return NextResponse.json({ error: "Failed to update key" }, { status: 500 });
  }
}

// DELETE /api/keys/[id] - Delete API key
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;

    const deleted = await deleteApiKey(id);
    if (!deleted) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    // Drop the deleted key's counters so its concurrency slot is freed at once.
    const { invalidateApiKeyCache } = await import("@/sse/services/auth.js");
    if (existing.key) invalidateApiKeyCache(existing.key);
    invalidateApiKeyCache();

    return NextResponse.json({ message: "Key deleted successfully" });
  } catch (error) {
    console.log("Error deleting key:", error);
    return NextResponse.json({ error: "Failed to delete key" }, { status: 500 });
  }
}
