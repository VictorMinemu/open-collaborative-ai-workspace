import { Plug } from "lucide-react";
import type { Metadata } from "next";
import { McpServersSettings } from "@/components/mcp/mcp-servers-settings";
import { PageHeader } from "@/components/shell/page-header";

export const metadata: Metadata = { title: "MCP servers" };

export default function SettingsMcpServersPage() {
  return (
    <>
      <PageHeader title="MCP servers" icon={<Plug />} description="Tools your bots can call" />
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <McpServersSettings />
      </div>
    </>
  );
}
