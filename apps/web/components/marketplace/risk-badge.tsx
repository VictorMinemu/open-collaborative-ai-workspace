import type { RiskLevel } from "@ocw/contracts";
import { Ban, type LucideIcon, ShieldAlert, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export const RISK: Record<
  RiskLevel,
  { label: string; variant: "success" | "warning" | "destructive"; icon: LucideIcon }
> = {
  low: { label: "Low risk", variant: "success", icon: ShieldCheck },
  medium: { label: "Medium risk", variant: "warning", icon: ShieldAlert },
  high: { label: "High risk", variant: "destructive", icon: ShieldAlert },
  refuse: { label: "Blocked", variant: "destructive", icon: Ban },
};

/** The API's risk verdict for one plugin version (D-14). `refuse` reads "Blocked": it can never be installed. */
export function RiskBadge({ level, className }: { level: RiskLevel; className?: string }) {
  const r = RISK[level];
  const Icon = r.icon;
  return (
    <Badge
      variant={r.variant}
      data-testid={`risk-${level}`}
      className={cn(level === "refuse" && "bg-destructive text-white", className)}
    >
      <Icon aria-hidden />
      {r.label}
    </Badge>
  );
}
