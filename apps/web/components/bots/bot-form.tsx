"use client";

import { type AllowedModel, type ModelProviderKind, providerShortLabel } from "@ocw/contracts";
import { type ReactNode, useState } from "react";
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
