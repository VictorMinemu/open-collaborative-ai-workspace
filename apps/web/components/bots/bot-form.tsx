"use client";

import {
  type AllowedModel,
  type Member,
  type ModelProviderKind,
  type OrgUnit,
  providerShortLabel,
  type UnitKind,
} from "@ocw/contracts";
import { Globe } from "lucide-react";
import { type ReactNode, useState } from "react";
import { UNIT_KIND_ICON, UNIT_KIND_LABEL } from "@/components/members/unit-chip";
import { UserAvatar } from "@/components/ui/avatar";
import { describedBy, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { BotAvatar } from "./bot-bits";
import { AVATAR_CHOICES } from "./presets";

export interface BotFormValues {
  name: string;
  username: string;
  avatar: string;
  description: string;
  instructions: string;
  /** `<provider>::<modelId>` */
  model: string;
}

export type BotFormErrors = Partial<Record<keyof BotFormValues, string>>;

export const modelKey = (provider: string, modelId: string) => `${provider}::${modelId}`;
export function splitModelKey(key: string): { provider: ModelProviderKind; modelId: string } {
  const idx = key.indexOf("::");
  return { provider: key.slice(0, idx) as ModelProviderKind, modelId: key.slice(idx + 2) };
}

/** Mirrors the API's auto-username so the preview matches what will be created. */
export function suggestUsername(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return base.length >= 2 ? base : "";
}

function providerLabel(p: ModelProviderKind): string {
  return providerShortLabel(p);
}

export function BotForm({
  values,
  errors,
  onChange,
  models,
  idPrefix,
  usernameTouched,
  onUsernameTouched,
}: {
  values: BotFormValues;
  errors: BotFormErrors;
  onChange: (patch: Partial<BotFormValues>) => void;
  models: AllowedModel[];
  idPrefix: string;
  usernameTouched: boolean;
  onUsernameTouched: () => void;
}) {
  const [customAvatar, setCustomAvatar] = useState(
    values.avatar && !(AVATAR_CHOICES as readonly string[]).includes(values.avatar) ? values.avatar : "",
  );
  const id = (k: string) => `${idPrefix}-${k}`;
  const items = models.map((m) => ({ value: modelKey(m.provider, m.modelId), label: m.label }));
  const usernamePreview = usernameTouched ? values.username : suggestUsername(values.name);

  return (
    <div className="grid gap-5">
      <div className="flex items-start gap-4">
        <BotAvatar name={values.name || "Bot"} avatar={values.avatar} size="lg" />
        <div className="grid min-w-0 flex-1 gap-2">
          <span className="font-medium text-[13px]">Avatar</span>
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Avatar">
            {AVATAR_CHOICES.map((emoji) => (
              <button
                key={emoji}
                type="button"
                role="radio"
                aria-checked={values.avatar === emoji}
                aria-label={`Avatar ${emoji}`}
                onClick={() => {
                  setCustomAvatar("");
                  onChange({ avatar: emoji });
                }}
                className={cn(
                  "flex size-8 items-center justify-center rounded-lg text-base outline-none transition-[background-color,box-shadow] hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/40",
                  values.avatar === emoji && "bg-brand-soft ring-1 ring-primary/40",
                )}
              >
                {emoji}
              </button>
            ))}
          </div>
          <Input
            aria-label="Custom avatar (emoji or image URL)"
            placeholder="Or paste an emoji or image URL"
            value={customAvatar}
            onChange={(e) => {
              setCustomAvatar(e.target.value);
              onChange({ avatar: e.target.value.trim() || "🤖" });
            }}
            className="h-8 text-[13px]"
          />
          {errors.avatar ? <p className="text-[13px] text-destructive">{errors.avatar}</p> : null}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id={id("name")} label="Name" error={errors.name}>
          <Input
            id={id("name")}
            data-testid="bot-name"
            value={values.name}
            placeholder="e.g. Archie"
            maxLength={80}
            onChange={(e) => onChange({ name: e.target.value })}
            aria-invalid={!!errors.name}
            aria-describedby={describedBy(id("name"), errors.name)}
          />
        </FormField>
        <FormField
          id={id("username")}
          label="Handle"
          error={errors.username}
          hint={usernameTouched ? undefined : "Generated from the name"}
        >
          <div className="relative">
            <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground text-sm">
              @
            </span>
            <Input
              id={id("username")}
              data-testid="bot-username"
              value={usernamePreview}
              placeholder="archie"
              maxLength={40}
              className="pl-7 font-mono text-[13px]"
              onChange={(e) => {
                onUsernameTouched();
                onChange({ username: e.target.value.toLowerCase().replace(/[^a-z0-9-_]/g, "") });
              }}
              aria-invalid={!!errors.username}
              aria-describedby={describedBy(
                id("username"),
                errors.username,
                usernameTouched ? undefined : "x",
              )}
            />
          </div>
        </FormField>
      </div>

      <FormField
        id={id("description")}
        label="Description"
        hint="Shown on the bot's card."
        error={errors.description}
      >
        <Input
          id={id("description")}
          value={values.description}
          placeholder="What is this bot for?"
          maxLength={500}
          onChange={(e) => onChange({ description: e.target.value })}
          aria-describedby={describedBy(id("description"), errors.description, "x")}
        />
      </FormField>

      <FormField
        id={id("model")}
        label="Model"
        error={errors.model}
        hint="Fixed for this bot; you can change it later."
      >
        <Select
          items={items}
          value={values.model || null}
          onValueChange={(v) => v && onChange({ model: String(v) })}
        >
          <SelectTrigger
            id={id("model")}
            data-testid="bot-model"
            placeholder="Choose a model"
            aria-invalid={!!errors.model}
          />
          <SelectContent>
            {models.map((m) => (
              <SelectItem key={modelKey(m.provider, m.modelId)} value={modelKey(m.provider, m.modelId)}>
                <span className="flex w-full items-center justify-between gap-3">
                  <span>{m.label}</span>
                  <span className="text-muted-foreground text-xs">
                    {providerLabel(m.provider)}
                    {m.isDefault ? " · default" : ""}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>

      <FormField
        id={id("instructions")}
        label="Instructions"
        error={errors.instructions}
        hint="How the bot should behave. It always knows who is speaking in a thread."
      >
        <Textarea
          id={id("instructions")}
          data-testid="bot-instructions"
          value={values.instructions}
          rows={7}
          placeholder="You are a helpful teammate who…"
          onChange={(e) => onChange({ instructions: e.target.value })}
          aria-invalid={!!errors.instructions}
          aria-describedby={describedBy(id("instructions"), errors.instructions, "x")}
          className="font-mono text-[12.5px]"
        />
      </FormField>
    </div>
  );
}

export function SheetSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-3">
      <h3 className="font-semibold text-[11px] text-muted-foreground uppercase tracking-wider">{title}</h3>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------- persona scope and owner (AGENT-01)

/** Where a shared persona lives: the whole organization or one department, team or project. */
export type PersonaScope = "organization" | UnitKind;

/** `unitId` and `ownerUserId` use "" for none (organization / no owner). */
export interface PlacementValues {
  scope: PersonaScope;
  unitId: string;
  ownerUserId: string;
}

const SCOPES: PersonaScope[] = ["organization", "department", "team", "project"];
const SCOPE_LABEL: Record<PersonaScope, string> = { organization: "Organization", ...UNIT_KIND_LABEL };
const NO_OWNER = "none";

/** "Engineering › Backend" for a unit, from the full tree (names of the units the caller cannot target too). */
export function unitTrail(unit: Pick<OrgUnit, "path" | "name">, all: readonly OrgUnit[]): string {
  const byId = new Map(all.map((u) => [u.id, u.name]));
  return unit.path.map((id) => byId.get(id) ?? unit.name).join(" › ");
}

/**
 * Scope, unit and owner of a shared persona (AGENT-01). `targets` = the units the caller may place it in (the
 * API's create hint; the current unit is always included by the caller); `allowOrganization` = `bot.manage`.
 * Personal bots never render this: they stay the one-click owner-only flow.
 */
export function PlacementFields({
  idPrefix,
  value,
  onChange,
  targets,
  allUnits,
  allowOrganization,
  members,
  canMove = true,
  error,
}: {
  idPrefix: string;
  value: PlacementValues;
  onChange: (patch: Partial<PlacementValues>) => void;
  targets: readonly OrgUnit[];
  allUnits: readonly OrgUnit[];
  allowOrganization: boolean;
  members: readonly Member[];
  /** False when the caller may not move this persona away from where it is (scope and unit read-only). */
  canMove?: boolean;
  error?: string;
}) {
  const id = (k: string) => `${idPrefix}-${k}`;
  const offered = SCOPES.filter((sc) =>
    sc === "organization" ? allowOrganization : targets.some((u) => u.kind === sc),
  );
  const inScope = targets
    .filter((u) => u.kind === value.scope)
    .sort((a, b) => unitTrail(a, allUnits).localeCompare(unitTrail(b, allUnits)));
  const unitItems = inScope.map((u) => ({ value: u.id, label: u.name }));
  const active = members.filter((m) => m.status === "active");
  const ownerItems = [
    { value: NO_OWNER, label: "No owner" },
    ...active.map((m) => ({ value: m.userId, label: m.displayName })),
  ];
  const chosen = allUnits.find((u) => u.id === value.unitId);
  const audience =
    value.scope === "organization"
      ? "Everyone in the organization can see it, mention it and message it."
      : chosen
        ? `Only members of ${chosen.name} and the units inside it can see it, mention it and message it.`
        : `Choose the ${SCOPE_LABEL[value.scope].toLowerCase()} it belongs to.`;

  function pickScope(scope: PersonaScope) {
    if (scope === value.scope) return;
    const first = targets.find((u) => u.kind === scope);
    onChange({ scope, unitId: scope === "organization" ? "" : (first?.id ?? "") });
  }

  return (
    <div className="grid gap-4" data-testid="persona-placement">
      <div className="grid gap-2">
        <span className="font-medium text-[13px]" id={id("scope-label")}>
          Scope
        </span>
        <div
          role="radiogroup"
          aria-labelledby={id("scope-label")}
          className="grid grid-cols-2 gap-1.5 min-[480px]:grid-cols-4"
        >
          {SCOPES.map((sc) => {
            const Icon = sc === "organization" ? Globe : UNIT_KIND_ICON[sc];
            const enabled = canMove && offered.includes(sc);
            const checked = value.scope === sc;
            return (
              <button
                key={sc}
                type="button"
                role="radio"
                aria-checked={checked}
                disabled={!enabled && !checked}
                data-testid={`persona-scope-${sc}`}
                onClick={() => enabled && pickScope(sc)}
                className={cn(
                  "flex h-9 items-center justify-center gap-1.5 rounded-lg border px-2 font-medium text-[13px] outline-none transition-[background-color,border-color,box-shadow]",
                  "focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-40",
                  checked
                    ? "border-primary/50 bg-brand-soft text-brand-soft-foreground"
                    : "bg-background text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                <Icon className="size-3.5 shrink-0" aria-hidden />
                {SCOPE_LABEL[sc]}
              </button>
            );
          })}
        </div>
        <p className="text-[13px] text-muted-foreground" data-testid="persona-audience">
          {audience}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {value.scope === "organization" ? null : (
          <FormField id={id("unit")} label={SCOPE_LABEL[value.scope]} error={error}>
            <Select
              items={unitItems}
              value={value.unitId || null}
              onValueChange={(v) => v && onChange({ unitId: String(v) })}
              disabled={!canMove}
            >
              <SelectTrigger
                id={id("unit")}
                data-testid="persona-unit"
                placeholder={`Choose a ${SCOPE_LABEL[value.scope].toLowerCase()}`}
                aria-invalid={!!error}
              />
              <SelectContent>
                {inScope.map((u) => (
                  <SelectItem
                    key={u.id}
                    value={u.id}
                    data-testid="persona-unit-option"
                    data-unit-name={u.name}
                  >
                    <span className="flex w-full min-w-0 items-center justify-between gap-3">
                      <span className="truncate">{u.name}</span>
                      {u.path.length > 1 ? (
                        <span className="truncate text-muted-foreground text-xs">
                          {unitTrail({ ...u, path: u.path.slice(0, -1) }, allUnits)}
                        </span>
                      ) : null}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        )}
        <FormField id={id("owner")} label="Owner" hint="Accountable for it; can edit it.">
          <Select
            items={ownerItems}
            value={value.ownerUserId || NO_OWNER}
            onValueChange={(v) => onChange({ ownerUserId: v && v !== NO_OWNER ? String(v) : "" })}
          >
            <SelectTrigger
              id={id("owner")}
              data-testid="persona-owner"
              aria-describedby={describedBy(id("owner"), undefined, "x")}
            />
            <SelectContent>
              <SelectItem value={NO_OWNER}>
                <span className="text-muted-foreground">No owner</span>
              </SelectItem>
              {active.map((m) => (
                <SelectItem key={m.userId} value={m.userId}>
                  <span className="flex min-w-0 items-center gap-2">
                    <UserAvatar name={m.displayName} src={m.avatarUrl} seed={m.userId} className="size-5" />
                    <span className="truncate">{m.displayName}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      </div>
    </div>
  );
}
