"use client";

import { Menu } from "@base-ui/react/menu";
import { AI_CHAT_TITLE_MAX, type AiChatSummary, type Permission } from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, ChevronLeft, Ellipsis, Pencil, SquarePen } from "lucide-react";
import Link from "next/link";
import {
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { buttonVariants } from "@/components/ui/button";
import { DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { moveSurfaceFocus, useSheetSurface } from "@/components/work-zone/control-surface";
import { updateAiChat } from "@/lib/ai-chat-queries";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * The AI chat header (05-10, AICHAT-04): the title, renamed in place (click it, Enter saves, Escape cancels), and a
 * menu with Rename and Archive/Unarchive. Later plans add their own items through `extraMenuItems` (05-11 settings,
 * 05-13 share) as `AiChatMenuItem`s, which render as menu rows on a desktop and as sheet rows at 390.
 */

// ---------------------------------------------------------------- menu (dropdown ≥ sm, bottom sheet at 390)

const MenuSurface = createContext<{ sheet: boolean; close: () => void }>({ sheet: false, close: () => {} });

/** One row of an AI chat menu (header or list row). */
export function AiChatMenuItem({
  icon,
  children,
  onSelect,
  testId,
  variant,
}: {
  icon: ReactNode;
  children: ReactNode;
  onSelect: () => void;
  testId?: string;
  variant?: "default" | "destructive";
}) {
  const surface = useContext(MenuSurface);
  if (surface.sheet) {
    return (
      <button
        type="button"
        data-surface-item
        data-testid={testId}
        onClick={() => {
          surface.close();
          onSelect();
        }}
        className={cn(
          "flex h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-[15px] outline-none transition-colors hover:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/30 [&_svg]:size-[18px] [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
          variant === "destructive" && "text-destructive [&_svg]:text-destructive",
        )}
      >
        {icon}
        {children}
      </button>
    );
  }
  return (
    <DropdownMenuItem data-testid={testId} variant={variant} onClick={onSelect}>
      {icon}
      {children}
    </DropdownMenuItem>
  );
}

/** A chat's menu: a dropdown on a desktop, a bottom sheet on a phone (D-16), controlled by the caller. */
export function AiChatMenu({
  trigger,
  title,
  open,
  onOpenChange,
  testId,
  align = "end",
  children,
}: {
  trigger: ReactElement;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  testId: string;
  align?: "start" | "end";
  children: ReactNode;
}) {
  const sheet = useSheetSurface();
  const close = () => onOpenChange(false);
  if (sheet) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetTrigger render={trigger} />
        <SheetContent
          side="bottom"
          data-testid={testId}
          data-surface="sheet"
          initialFocus={false}
          onKeyDown={moveSurfaceFocus}
          className="h-auto max-h-[85dvh] gap-0 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
        >
          <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-muted-foreground/25" aria-hidden />
          <SheetTitle className="truncate px-5 pt-3 pr-12 pb-2 text-[15px]">{title}</SheetTitle>
          <div className="grid gap-0.5 px-2">
            <MenuSurface.Provider value={{ sheet: true, close }}>{children}</MenuSurface.Provider>
          </div>
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <Menu.Root open={open} onOpenChange={onOpenChange}>
      <Menu.Trigger render={trigger} />
      <DropdownMenuContent align={align} data-testid={testId} className="min-w-44">
        <MenuSurface.Provider value={{ sheet: false, close }}>{children}</MenuSurface.Provider>
      </DropdownMenuContent>
    </Menu.Root>
  );
}

/**
 * Rename and Archive/Unarchive, shared by the header and the list rows. Both need `ai_chat.manage` (owner only, P-04):
 * `viewerCan` is the server's decision for the viewer; absent (the member's own list rows) means their own chat.
 */
export function AiChatStandardItems({
  chat,
  onRename,
  viewerCan,
}: {
  chat: AiChatSummary;
  onRename: () => void;
  viewerCan?: readonly Permission[] | undefined;
}) {
  const qc = useQueryClient();
  const setArchived = async (archived: boolean) => {
    try {
      await updateAiChat(qc, chat.id, { archived });
      toast.success(archived ? "Chat archived" : "Chat restored");
    } catch (err) {
      toast.error(archived ? "Couldn't archive the chat" : "Couldn't restore the chat", {
        description: errorMessage(err),
      });
    }
  };
  if (viewerCan && !viewerCan.includes("ai_chat.manage")) return null;
  return (
    <>
      <AiChatMenuItem icon={<Pencil />} testId="ai-chat-menu-rename" onSelect={onRename}>
        Rename
      </AiChatMenuItem>
      {chat.archived ? (
        <AiChatMenuItem
          icon={<ArchiveRestore />}
          testId="ai-chat-menu-unarchive"
          onSelect={() => void setArchived(false)}
        >
          Unarchive
        </AiChatMenuItem>
      ) : (
        <AiChatMenuItem
          icon={<Archive />}
          testId="ai-chat-menu-archive"
          onSelect={() => void setArchived(true)}
        >
          Archive
        </AiChatMenuItem>
      )}
    </>
  );
}

// ---------------------------------------------------------------- inline rename

/**
 * The title as an input: Enter or leaving the field saves (trimmed; empty or unchanged cancels), Escape cancels.
 * `onDone` runs when editing ends either way.
 */
export function AiChatTitleInput({
  chat,
  onDone,
  className,
  testId = "ai-chat-title-input",
}: {
  chat: AiChatSummary;
  onDone: () => void;
  className?: string;
  testId?: string;
}) {
  const qc = useQueryClient();
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(chat.title);
  const settled = useRef(false);

  useEffect(() => {
    // After the opening menu closed and returned focus to its trigger.
    const t = requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.select();
    });
    return () => cancelAnimationFrame(t);
  }, []);

  async function save() {
    if (settled.current) return;
    settled.current = true;
    const title = value.trim();
    onDone();
    if (!title || title === chat.title) return;
    try {
      await updateAiChat(qc, chat.id, { title });
    } catch (err) {
      toast.error("Couldn't rename the chat", { description: errorMessage(err) });
    }
  }

  return (
    <input
      ref={ref}
      data-testid={testId}
      aria-label="Chat title"
      value={value}
      maxLength={AI_CHAT_TITLE_MAX}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          e.preventDefault();
          void save();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          settled.current = true;
          onDone();
        }
      }}
      onBlur={() => void save()}
      className={cn(
        "h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 font-medium text-[14px] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25 sm:text-[15px] dark:bg-input/25",
        className,
      )}
    />
  );
}

// ---------------------------------------------------------------- header

/**
 * The header of an open chat. `viewerCan` (the server's decisions, 06-03) hides what the viewer may not do: a grantee
 * gets no rename and no menu at all when nothing in it is theirs (`extraMenuItems` null).
 */
export function AiChatHeader({
  chat,
  viewerCan,
  extraMenuItems,
}: {
  chat: AiChatSummary;
  viewerCan?: readonly Permission[] | undefined;
  extraMenuItems?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const canManage = !viewerCan || viewerCan.includes("ai_chat.manage");
  const hasMenu = canManage || !!extraMenuItems;
  // A chat someone shared with the viewer says whose it is (06-03); the owner's own header is unchanged.
  const sharedBy = chat.access !== undefined && chat.access !== "owner" ? chat.owner?.displayName : undefined;

  return (
    <header
      className="flex h-12 shrink-0 items-center gap-1 px-2 sm:h-14 sm:px-4"
      data-testid="ai-chat-header"
    >
      <BackToChats />
      {editing && canManage ? (
        <AiChatTitleInput chat={chat} onDone={() => setEditing(false)} className="mx-1" />
      ) : (
        <div className="flex min-w-0 flex-1 flex-col justify-center">
          <h1 className="flex min-w-0 items-center">
            {canManage ? (
              <button
                type="button"
                data-testid="ai-chat-title"
                title="Rename"
                onClick={() => setEditing(true)}
                className="min-w-0 truncate rounded-md px-1 py-0.5 text-left font-medium text-[14px] tracking-tight outline-none transition-colors hover:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/30 sm:text-[15px]"
              >
                {chat.title}
              </button>
            ) : (
              <span
                data-testid="ai-chat-title"
                className="min-w-0 truncate px-1 py-0.5 font-medium text-[14px] tracking-tight sm:text-[15px]"
              >
                {chat.title}
              </span>
            )}
            {chat.archived ? (
              <span
                data-testid="ai-chat-archived-badge"
                className="ml-1.5 shrink-0 rounded-[4px] bg-muted px-1.5 py-px font-medium text-[11px] text-muted-foreground"
              >
                Archived
              </span>
            ) : null}
          </h1>
          {sharedBy ? (
            <p
              data-testid="ai-chat-shared-by"
              className="-mt-0.5 truncate px-1 text-[11.5px] text-muted-foreground leading-4"
            >
              Shared by {sharedBy}
            </p>
          ) : null}
        </div>
      )}
      {hasMenu ? (
        <AiChatMenu
          open={menuOpen}
          onOpenChange={setMenuOpen}
          title={chat.title}
          testId="ai-chat-menu"
          trigger={
            <button
              type="button"
              aria-label="Chat options"
              title="Chat options"
              data-testid="ai-chat-menu-button"
              className={cn(
                buttonVariants({ variant: "ghost", size: "icon-sm" }),
                "text-muted-foreground data-popup-open:bg-accent",
              )}
            >
              <Ellipsis />
            </button>
          }
        >
          <AiChatStandardItems chat={chat} viewerCan={viewerCan} onRename={() => setEditing(true)} />
          {extraMenuItems}
        </AiChatMenu>
      ) : null}
      <NewChatLink />
    </header>
  );
}

/** The header of the screen's other states (new chat, loading, unavailable): a plain title. */
export function AiChatPlainHeader({ title }: { title: ReactNode }) {
  return (
    <header
      className="flex h-12 shrink-0 items-center gap-1 px-2 sm:h-14 sm:px-4"
      data-testid="ai-chat-header"
    >
      <BackToChats />
      <h1
        data-testid="ai-chat-title"
        className="min-w-0 flex-1 truncate px-1 font-medium text-[14px] tracking-tight sm:text-[15px]"
      >
        {title}
      </h1>
      <NewChatLink />
    </header>
  );
}

function BackToChats() {
  return (
    <Link
      href="/chat/ai"
      aria-label="All AI chats"
      className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }), "text-muted-foreground sm:hidden")}
    >
      <ChevronLeft />
    </Link>
  );
}

function NewChatLink() {
  return (
    <Link
      href="/chat/ai/new"
      aria-label="New chat"
      title="New chat"
      data-testid="ai-header-new-chat"
      className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }), "text-muted-foreground")}
    >
      <SquarePen />
    </Link>
  );
}
