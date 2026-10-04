"use client";

import { EmojiString } from "@ocw/contracts";
import { Link2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage, isImageSrc, toneFor, UserAvatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { describedBy } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn, initials } from "@/lib/utils";

/** 6 × 4 curated avatars: friendly, distinct at 32 px, no people (skin tones stay the user's choice later). */
export const AVATAR_EMOJIS = [
  "🦊",
  "🐼",
  "🐨",
  "🦁",
  "🐯",
  "🐸",
  "🐙",
  "🦉",
  "🐧",
  "🦄",
  "🐝",
  "🐳",
  "🌵",
  "🌻",
  "🍀",
  "🔥",
  "⚡",
  "🌈",
  "🚀",
  "🎨",
  "🎧",
  "☕",
  "🧠",
  "👾",
] as const;

const EMOJI_NAMES: Record<(typeof AVATAR_EMOJIS)[number], string> = {
  "🦊": "Fox",
  "🐼": "Panda",
  "🐨": "Koala",
  "🦁": "Lion",
  "🐯": "Tiger",
  "🐸": "Frog",
  "🐙": "Octopus",
  "🦉": "Owl",
  "🐧": "Penguin",
  "🦄": "Unicorn",
  "🐝": "Bee",
  "🐳": "Whale",
  "🌵": "Cactus",
  "🌻": "Sunflower",
  "🍀": "Clover",
  "🔥": "Fire",
  "⚡": "Lightning",
  "🌈": "Rainbow",
  "🚀": "Rocket",
  "🎨": "Palette",
  "🎧": "Headphones",
  "☕": "Coffee",
  "🧠": "Brain",
  "👾": "Space invader",
};

/**
 * Avatar = an emoji from the grid or an https image URL (uploads wait for object storage, Phase 4).
 * `value` is what will be saved (may be an invalid URL while typing); `previewSrc` is the last valid value.
 */
export function AvatarPicker({
  value,
  previewSrc,
  onChange,
  name,
  seed,
  error,
}: {
  value: string | null;
  previewSrc: string | null;
  onChange: (value: string | null) => void;
  name: string;
  seed: string;
  error?: string | undefined;
}) {
  const isEmoji = value !== null && !isImageSrc(value) && EmojiString.safeParse(value).success;
  const [url, setUrl] = useState(value && !isEmoji ? value : "");

  // Keep the URL field in sync when the value changes from outside (reset after save, "Remove avatar").
  useEffect(() => {
    if (value === null || isEmoji) setUrl("");
    else setUrl(value);
  }, [value, isEmoji]);

  return (
    <div className="grid gap-5 sm:grid-cols-[auto_1fr] sm:gap-6">
      <div className="flex items-center gap-4 sm:flex-col sm:items-center sm:gap-3">
        <AvatarPreview name={name} src={previewSrc} seed={seed} />
        <div className="grid gap-1 sm:justify-items-center">
          <span className="font-medium text-sm sm:hidden">Your avatar</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={value === null}
            onClick={() => onChange(null)}
            className="-ml-2 w-fit text-muted-foreground hover:text-destructive sm:ml-0"
          >
            <Trash2 /> Remove avatar
          </Button>
        </div>
      </div>

      <div className="grid min-w-0 gap-4">
        <fieldset className="grid gap-2">
          <legend className="mb-2 font-medium text-sm">Pick an emoji</legend>
          <div className="grid w-full max-w-[22rem] grid-cols-6 gap-1.5" data-testid="avatar-emoji-grid">
            {AVATAR_EMOJIS.map((emoji) => {
              const selected = value === emoji;
              return (
                <button
                  key={emoji}
                  type="button"
                  aria-label={EMOJI_NAMES[emoji]}
                  aria-pressed={selected}
                  onClick={() => onChange(selected ? null : emoji)}
                  className={cn(
                    "flex aspect-square min-h-10 items-center justify-center rounded-lg border text-[22px] leading-none outline-none transition-[background-color,border-color,transform] hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/40 active:scale-95",
                    selected
                      ? "border-primary bg-primary/10 ring-1 ring-primary/40 hover:bg-primary/15"
                      : "border-transparent bg-muted/50",
                  )}
                >
                  <span aria-hidden>{emoji}</span>
                </button>
              );
            })}
          </div>
        </fieldset>

        <div className="grid gap-2">
          <Label htmlFor="avatar-url">Or use an image URL</Label>
          <div className="relative">
            <Link2 className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="avatar-url"
              type="url"
              inputMode="url"
              placeholder="https://…/me.png"
              autoComplete="off"
              spellCheck={false}
              value={url}
              onChange={(e) => {
                const next = e.target.value;
                setUrl(next);
                onChange(next.trim() ? next.trim() : null);
              }}
              aria-invalid={!!error}
              aria-describedby={describedBy("avatar-url", error, true)}
              className="pl-9"
            />
          </div>
          {error ? (
            <p id="avatar-url-error" role="alert" className="text-[13px] text-destructive">
              {error}
            </p>
          ) : (
            <p id="avatar-url-hint" className="text-[13px] text-muted-foreground">
              Square images look best. Only https:// links are accepted.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

const PREVIEW_CLASS = "size-20 text-xl shadow-sm ring-1 ring-border";

/** Large preview. Remote images are fetched without a referrer (T-02-14-03: no avatar-host tracking). */
function AvatarPreview({ name, src, seed }: { name: string; src: string | null; seed: string }) {
  if (src && !isImageSrc(src)) return <UserAvatar name={name} src={src} className={PREVIEW_CLASS} />;
  return (
    <Avatar className={PREVIEW_CLASS} data-testid="avatar-preview">
      {src ? <AvatarImage src={src} alt="" referrerPolicy="no-referrer" /> : null}
      <AvatarFallback className={cn("text-xl", toneFor(seed))}>{initials(name || "?")}</AvatarFallback>
    </Avatar>
  );
}
