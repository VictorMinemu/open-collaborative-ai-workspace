"use client";

import { MENTION_TOKEN_RE } from "@ocw/contracts";
import { createContext, memo, useContext } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

export interface MentionTarget {
  kind: "user" | "agent";
  displayName: string;
}

export interface MentionContextValue {
  /** handle → principal; unknown handles render as plain text. */
  handles: Map<string, MentionTarget>;
  myHandle: string | null;
}

export const MentionContext = createContext<MentionContextValue>({ handles: new Map(), myHandle: null });

// ---------------------------------------------------------------- rehype: @handle → <span data-mention>

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

const SKIP = new Set(["code", "pre", "a"]);

function splitMentions(text: string): HastNode[] {
  const out: HastNode[] = [];
  let last = 0;
  for (const m of text.matchAll(new RegExp(MENTION_TOKEN_RE.source, "g"))) {
    const handle = (m[2] ?? "").replace(/[._-]+$/, "");
    if (!handle) continue;
    const start = (m.index ?? 0) + (m[1]?.length ?? 0);
    const end = start + 1 + handle.length;
    if (start > last) out.push({ type: "text", value: text.slice(last, start) });
    out.push({
      type: "element",
      tagName: "span",
      properties: { dataMention: handle.toLowerCase() },
      children: [{ type: "text", value: `@${handle}` }],
    });
    last = end;
  }
  if (last === 0) return [{ type: "text", value: text }];
  if (last < text.length) out.push({ type: "text", value: text.slice(last) });
  return out;
}

function walk(node: HastNode): void {
  if (!node.children) return;
  if (node.type === "element" && node.tagName && SKIP.has(node.tagName)) return;
  const next: HastNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && child.value?.includes("@")) next.push(...splitMentions(child.value));
    else {
      walk(child);
      next.push(child);
    }
  }
  node.children = next;
}

function rehypeMentions() {
  return (tree: HastNode) => walk(tree);
}

// ---------------------------------------------------------------- components

function Mention({ handle, children }: { handle: string; children: React.ReactNode }) {
  const { handles, myHandle } = useContext(MentionContext);
  const target = handles.get(handle);
  if (!target) return <>{children}</>;
  const me = handle === myHandle;
  return (
    <span
      data-testid="mention"
      title={target.kind === "agent" ? `${target.displayName} (bot)` : target.displayName}
      className={cn(
        "rounded-[4px] px-0.5 font-medium",
        me
          ? "bg-amber-400/25 text-amber-900 dark:bg-amber-400/20 dark:text-amber-200"
          : "bg-primary/10 text-primary dark:bg-primary/20 dark:text-[oklch(0.8_0.11_278)]",
      )}
    >
      {children}
    </span>
  );
}

const components: Components = {
  span({ node: _node, ...props }) {
    const handle = (props as Record<string, unknown>)["data-mention"];
    if (typeof handle === "string") return <Mention handle={handle}>{props.children}</Mention>;
    return <span {...props} />;
  },
  a({ node: _node, className, ...props }) {
    return (
      <a
        {...props}
        className={cn("font-medium text-primary underline-offset-2 hover:underline", className)}
        target="_blank"
        rel="noopener noreferrer nofollow"
      />
    );
  },
  pre({ node: _node, className, ...props }) {
    return (
      <pre
        {...props}
        className={cn(
          "scrollbar-thin my-1.5 overflow-x-auto rounded-lg border bg-muted/60 px-3.5 py-3 font-mono text-[12.5px] leading-relaxed dark:bg-black/30",
          className,
        )}
      />
    );
  },
  code({ node: _node, className, ...props }) {
    const block = /\blanguage-|\bhljs\b/.test(className ?? "");
    return (
      <code
        {...props}
        className={cn(
          block
            ? "bg-transparent p-0"
            : "rounded-[5px] border bg-muted/70 px-1 py-px font-mono text-[0.86em] text-rose-600 dark:bg-white/5 dark:text-rose-300",
          className,
        )}
      />
    );
  },
  ul: ({ node: _node, className, ...props }) => (
    <ul {...props} className={cn("my-1 list-disc pl-5", className)} />
  ),
  ol: ({ node: _node, className, ...props }) => (
    <ol {...props} className={cn("my-1 list-decimal pl-5", className)} />
  ),
  li: ({ node: _node, className, ...props }) => <li {...props} className={cn("my-0.5 pl-0.5", className)} />,
  blockquote: ({ node: _node, className, ...props }) => (
    <blockquote
      {...props}
      className={cn("my-1 border-muted-foreground/30 border-l-[3px] pl-3 text-muted-foreground", className)}
    />
  ),
  h1: ({ node: _node, ...props }) => <p {...props} className="mt-1 font-semibold text-base" />,
  h2: ({ node: _node, ...props }) => <p {...props} className="mt-1 font-semibold text-[15px]" />,
  h3: ({ node: _node, ...props }) => <p {...props} className="mt-1 font-semibold" />,
  p: ({ node: _node, className, ...props }) => (
    <p {...props} className={cn("whitespace-pre-wrap break-words [&:not(:first-child)]:mt-1.5", className)} />
  ),
  table: ({ node: _node, ...props }) => (
    <div className="scrollbar-thin my-1.5 overflow-x-auto">
      <table {...props} className="w-max border-collapse text-[13px]" />
    </div>
  ),
  th: ({ node: _node, ...props }) => (
    <th {...props} className="border bg-muted/50 px-2.5 py-1 text-left font-semibold" />
  ),
  td: ({ node: _node, ...props }) => <td {...props} className="border px-2.5 py-1" />,
  hr: () => <hr className="my-2" />,
  img: ({ node: _node, alt, src }) => (
    <a
      href={typeof src === "string" ? src : undefined}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="text-primary underline"
    >
      {alt || "image"}
    </a>
  ),
};

/** Message body: GitHub-flavoured markdown, highlighted code, @mention chips. Raw HTML is never rendered. */
export const Markdown = memo(function Markdown({ body, className }: { body: string; className?: string }) {
  return (
    <div className={cn("chat-markdown text-[14.5px] leading-[1.55] text-foreground/95", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true }], rehypeMentions]}
        components={components}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
});
