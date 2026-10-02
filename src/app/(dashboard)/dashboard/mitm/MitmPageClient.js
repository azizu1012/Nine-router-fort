"use client";

import { useState, useEffect } from "react";
import { MITM_TOOLS } from "@/shared/constants/cliTools";
import { getModelsByProviderId } from "@/shared/constants/models";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "@/shared/constants/providers";
import { MitmServerCard, MitmToolCard } from "@/app/(dashboard)/dashboard/cli-tools/components";
import { dedupe } from "@/store/pageDataStore";

export default function MitmPageClient() {
  const [connections, setConnections] = useState([]);
  const [apiKeys, setApiKeys] = useState([]);
  const [modelAliases, setModelAliases] = useState({});
  const [cloudEnabled, setCloudEnabled] = useState(false);
  const [expandedTool, setExpandedTool] = useState(null);
  const [mitmStatus, setMitmStatus] = useState({ running: false, certExists: false, dnsStatus: {}, hasCachedPassword: false });

  useEffect(() => {
    let cancelled = false;
    // These were four sequential awaits, so the page painted in four serial
    // round-trips. Fan them out and share each query with any other page that
    // needs the same payload in this load.
    (async () => {
      const [connData, keysData, aliasData, settingsData] = await Promise.all([
        dedupe("providers:connections", () => fetch("/api/providers").then((r) => (r.ok ? r.json() : null))),
        dedupe("api-keys", () => fetch("/api/keys").then((r) => (r.ok ? r.json() : null))),
        dedupe("model-aliases", () => fetch("/api/models/alias").then((r) => (r.ok ? r.json() : null))),
        dedupe("settings", () => fetch("/api/settings").then((r) => (r.ok ? r.json() : null))),
      ]);
      if (cancelled) return;
      if (connData) setConnections(connData.connections || []);
      if (keysData) setApiKeys(keysData.keys || []);
      if (aliasData) setModelAliases(aliasData.aliases || {});
      if (settingsData) setCloudEnabled(settingsData.cloudEnabled || false);
    })();
    return () => { cancelled = true; };
  }, []);

  const getActiveProviders = () => connections.filter(c => c.isActive !== false);

  const hasActiveProviders = () => {
    const active = getActiveProviders();
    return active.some(conn =>
      getModelsByProviderId(conn.provider).length > 0 ||
      isOpenAICompatibleProvider(conn.provider) ||
      isAnthropicCompatibleProvider(conn.provider)
    );
  };

  const mitmTools = Object.entries(MITM_TOOLS);

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
        <span className="material-symbols-outlined text-[16px] text-yellow-500 mt-0.5 shrink-0">warning</span>
        <p className="text-xs text-red-600 dark:text-yellow-400 leading-relaxed">
          ⚠️ MITM intercepts HTTPS traffic of IDE tools (Antigravity, GitHub Copilot, Kiro) via local CA to redirect requests to your providers. May violate ToS → account ban. Use at your own risk.
        </p>
      </div>

      {/* MITM Server Card */}
      <MitmServerCard
        apiKeys={apiKeys}
        cloudEnabled={cloudEnabled}
        onStatusChange={setMitmStatus}
      />

      {/* Tool Cards */}
      <div className="grid gap-3 sm:gap-4">
        {mitmTools.map(([toolId, tool]) => (
          <MitmToolCard
            key={toolId}
            tool={tool}
            isExpanded={expandedTool === toolId}
            onToggle={() => setExpandedTool(expandedTool === toolId ? null : toolId)}
            serverRunning={mitmStatus.running}
            dnsActive={mitmStatus.dnsStatus?.[toolId] || false}
            hasCachedPassword={mitmStatus.hasCachedPassword || false}
            needsSudoPassword={mitmStatus.needsSudoPassword !== false}
            isWin={mitmStatus.isWin === true}
            apiKeys={apiKeys}
            activeProviders={getActiveProviders()}
            hasActiveProviders={hasActiveProviders()}
            modelAliases={modelAliases}
            cloudEnabled={cloudEnabled}
            onDnsChange={(data) => setMitmStatus(prev => ({ ...prev, dnsStatus: data.dnsStatus ?? prev.dnsStatus }))}
          />
        ))}
      </div>
    </div>
  );
}
