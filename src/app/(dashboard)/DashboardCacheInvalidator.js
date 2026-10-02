"use client";

import { useEffect } from "react";
import { installCacheInvalidationInterceptor } from "@/store/pageDataStore";

/**
 * Installs the dashboard response-cache write invalidator once per page load.
 * Keeping it here means every page shares one client cache and no individual
 * fetch call site has to remember to invalidate after a mutation.
 */
export default function DashboardCacheInvalidator() {
  useEffect(() => {
    installCacheInvalidationInterceptor();
  }, []);
  return null;
}
