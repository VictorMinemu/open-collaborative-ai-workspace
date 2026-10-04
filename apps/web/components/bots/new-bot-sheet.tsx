"use client";

import { type Agent, CreateAgentRequest } from "@ocw/contracts";
import { ArrowLeft, ArrowRight, Settings2, Sparkles } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage, isApiError } from "@/lib/api";
import { useCreateAgent, useIsAdmin, useModels } from "@/lib/bots-queries";
import { validate } from "@/lib/form";
import { cn } from "@/lib/utils";
import { BotAvatar } from "./bot-bits";
import { BotForm, type BotFormErrors, type BotFormValues, modelKey, splitModelKey } from "./bot-form";
import { BOT_PRESETS, type BotPreset } from "./presets";

const EMPTY: BotFormValues = {
  name: "",
  username: "",
  avatar: "🤖",
  description: "",
  instructions: "",
  model: "",
};

export function NewBotSheet({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (agent: Agent) => void;
}) {
  const models = useModels();
  const create = useCreateAgent();
  const isAdmin = useIsAdmin();
  const [step, setStep] = useState<"template" | "details">("template");
  const [values, setValues] = useState<BotFormValues>(EMPTY);
  const [errors, setErrors] = useState<BotFormErrors>({});
  const [usernameTouched, setUsernameTouched] = useState(false);
  const available = models.data?.models ?? [];
  const defaultModel = available.find((m) => m.isDefault) ?? available[0];

  function reset() {
    setStep("template");
    setValues(EMPTY);
    setErrors({});
    setUsernameTouched(false);
  }

  function pick(preset: BotPreset) {
    setValues({
      name: preset.name,
      username: "",
      avatar: preset.avatar,
      description: preset.description,
      instructions: preset.instructions,
      model: defaultModel ? modelKey(defaultModel.provider, defaultModel.modelId) : "",
    });
    setErrors({});
    setUsernameTouched(false);
    setStep("details");
  }

  async function submit() {
    const { provider, modelId } = values.model ? splitModelKey(values.model) : { provider: "", modelId: "" };
    const result = validate(CreateAgentRequest, {
      name: values.name,
      ...(usernameTouched && values.username ? { username: values.username } : {}),
      avatarUrl: values.avatar || undefined,
      description: values.description || undefined,
      instructions: values.instructions,
      modelProvider: provider || undefined,
      modelId: modelId || undefined,
    } as Record<string, unknown>);
    if (result.errors) {
      const e = result.errors as Record<string, string>;
      setErrors({
        name: e.name,
        username: e.username,
        avatar: e.avatarUrl,
        description: e.description,
        instructions: e.instructions,
        model: e.modelProvider || e.modelId ? "Choose a model" : undefined,
      });
      return;
    }
    try {
      const agent = await create.mutateAsync(result.data);
      toast.success(`${agent.name} is being set up`, {
        description: `@${agent.username} will be ready in a moment.`,
      });
      onCreated(agent);
      onOpenChange(false);
      reset();
    } catch (err) {
      if (isApiError(err, 409)) setErrors({ username: "This handle is already taken" });
      else if (isApiError(err) && err.code === "model_not_allowed") setErrors({ model: err.message });
      else toast.error("Could not create the bot", { description: errorMessage(err) });
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setTimeout(reset, 250);
      }}
    >
      <SheetContent
        side="right"
        className="w-full max-w-full sm:w-[36rem] sm:max-w-[92vw]"
        data-testid="new-bot-sheet"
      >
        <div className="flex items-center gap-2 border-b px-5 py-4 pr-14">
          {step === "details" ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Back to templates"
              onClick={() => setStep("template")}
            >
              <ArrowLeft />
            </Button>
          ) : (
            <span className="flex size-8 items-center justify-center rounded-lg bg-brand-soft text-brand-soft-foreground">
              <Sparkles className="size-4" />
            </span>
          )}
          <div className="min-w-0">
            <SheetTitle>{step === "template" ? "New bot" : values.name || "Blank bot"}</SheetTitle>
            <SheetDescription className="text-[13px]">
              {step === "template" ? "Pick a starting point. You can edit everything." : "Review and create."}
            </SheetDescription>
          </div>
        </div>

        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-5 py-5">
          {models.isSuccess && available.length === 0 ? (
            <NoModels isAdmin={isAdmin} />
          ) : step === "template" ? (
            <div className="grid grid-cols-1 gap-2.5 min-[420px]:grid-cols-2" data-testid="bot-presets">
              {BOT_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  data-testid={`preset-${p.id}`}
                  onClick={() => pick(p)}
                  className={cn(
                    "group flex items-start gap-3 rounded-xl border bg-card p-3.5 text-left shadow-xs outline-none transition-[border-color,box-shadow,transform]",
                    "hover:border-primary/40 hover:shadow-md focus-visible:ring-[3px] focus-visible:ring-ring/40 active:scale-[0.99]",
                    p.id === "blank" && "border-dashed bg-transparent shadow-none",
                  )}
                >
                  <BotAvatar name={p.name || "Blank"} avatar={p.avatar} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2 font-medium text-sm">
                      {p.name || "Blank"}
                      <ArrowRight className="size-3.5 -translate-x-1 text-muted-foreground opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100" />
                    </span>
                    <span className="mt-0.5 block text-muted-foreground text-xs leading-snug">
                      {p.tagline}
                    </span>
                  </span>
                </button>
              ))}
              <ol className="col-span-full mt-4 grid gap-3 rounded-xl border bg-muted/30 p-4 text-sm min-[420px]:grid-cols-3">
                {[
                  ["Pick a template", "Name, avatar and instructions are prefilled."],
                  ["Choose a model", "From the models your admins allowed."],
                  ["Mention it", "Add it to a channel and @mention it in any thread."],
                ].map(([title, text], i) => (
                  <li key={title} className="flex gap-2.5 min-[420px]:flex-col min-[420px]:gap-1.5">
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary font-semibold text-[11px] text-primary-foreground">
                      {i + 1}
                    </span>
                    <span>
                      <span className="block font-medium">{title}</span>
                      <span className="block text-muted-foreground text-xs leading-snug">{text}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <BotForm
              idPrefix="new-bot"
              values={values}
              errors={errors}
              models={available}
              onChange={(patch) => {
                setValues((v) => ({ ...v, ...patch }));
                setErrors((e) => {
                  const next = { ...e };
                  for (const k of Object.keys(patch)) delete next[k as keyof BotFormValues];
                  return next;
                });
              }}
              usernameTouched={usernameTouched}
              onUsernameTouched={() => setUsernameTouched(true)}
            />
          )}
        </div>

        {step === "details" && available.length > 0 ? (
          <div className="flex items-center justify-between gap-2 border-t bg-muted/30 px-5 py-3">
            <p className="hidden text-muted-foreground text-xs sm:block">
              Runs in your OpenClaw cell · tools off
            </p>
            <div className="flex flex-1 justify-end gap-2 sm:flex-none">
              <Button variant="outline" onClick={() => setStep("template")} className="flex-1 sm:flex-none">
                Back
              </Button>
              <Button
                onClick={submit}
                disabled={create.isPending}
                data-testid="create-bot"
                className="flex-1 sm:flex-none"
              >
                {create.isPending ? <Spinner /> : <Sparkles />}
                Create bot
              </Button>
            </div>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

export function NoModels({ isAdmin, className }: { isAdmin: boolean; className?: string }) {
  return (
    <div
      className={cn(
        "flex flex-col items-center rounded-xl border border-dashed px-6 py-10 text-center",
        className,
      )}
    >
      <span className="mb-3 flex size-11 items-center justify-center rounded-xl border bg-card shadow-xs">
        <Settings2 className="size-5 text-primary" />
      </span>
      <h3 className="font-semibold">Configure a model provider first</h3>
      <p className="mt-1 max-w-xs text-balance text-muted-foreground text-sm">
        {isAdmin
          ? "Bots need a model. Connect your ChatGPT subscription or add an API key for Anthropic, OpenAI or another provider."
          : "Bots need a model. Ask a workspace admin to add a model provider."}
      </p>
      {isAdmin ? (
        <Link href="/settings/models" className={cn(buttonVariants({ size: "sm" }), "mt-4")}>
          Open Settings › Models
        </Link>
      ) : null}
    </div>
  );
}
