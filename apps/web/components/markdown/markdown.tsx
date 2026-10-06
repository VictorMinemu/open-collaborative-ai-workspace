"use client";

import { createContext, memo, useContext } from "react";
import ReactMarkdown, { type Components, defaultUrlTransform } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { type HastNode, rehypeMentions } from "./rehype-mentions";
import { safeUrl } from "./safe-url";

/**
 * The one Markdown renderer (D-05, CHAT-05): channel messages, thread replies, DMs, bot output and the Work Zone
 * stream. Raw HTML is never rendered (no raw-HTML plugin), links are limited to http(s), mailto and same-origin
 * paths, and images render as links (no remote pixels).
 */

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

export type MarkdownVariant = "chat" | "document";

/** The engine's default transform first, then our allowlist (the authority). */
const urlTransform = (url: string) => safeUrl(defaultUrlTransform(url));

const LINK_REL = "noopener noreferrer nofollow";

/** Code blocks above this size are not highlighted (a pasted log must never freeze the tab, T-04-02-04). */
const HIGHLIGHT_MAX_CHARS = 20_000;

function textLength(node: HastNode): number {
  return node.type === "text"
    ? (node.value?.length ?? 0)
    : (node.children ?? []).reduce((n, c) => n + textLength(c), 0);
}

/** Runs before rehype-highlight: marks oversized code blocks as plain text so highlight.js skips them. */
function rehypePlainLargeCode() {
  const visit = (node: HastNode) => {
    if (node.type === "element" && node.tagName === "code" && textLength(node) > HIGHLIGHT_MAX_CHARS) {
      node.properties = { ...node.properties, className: ["language-plaintext"] };
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  return visit;
}

// ---------------------------------------------------------------- shared components

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

/** A fenced block's code element carries a language class or its text ends with a newline; inline code never. */
function isBlockCode(className: string | undefined, children: React.ReactNode): boolean {
  return (
    /\blanguage-|\bhljs\b/.test(className ?? "") || (typeof children === "string" && children.includes("\n"))
  );
}

function shared(variant: MarkdownVariant): Components {
  const linkClass =
    variant === "chat"
      ? "font-medium text-primary underline-offset-2 hover:underline"
      : "text-primary underline-offset-4 hover:underline";
  return {
    span({ node: _node, ...props }) {
      const handle = (props as Record<string, unknown>)["data-mention"];
      if (typeof handle === "string") return <Mention handle={handle}>{props.children}</Mention>;
      return <span {...props} />;
    },
    a: ({ node: _node, className, href, children }) => (
      <a href={href} className={cn(linkClass, className)} target="_blank" rel={LINK_REL}>
        {children}
      </a>
    ),
    // Images never load remote pixels (tracking): they render as a link to the URL.
    img: ({ node: _node, alt, src }) => (
      <a
        href={typeof src === "string" ? src : undefined}
        target="_blank"
        rel={LINK_REL}
        className="text-primary underline"
      >
        {alt || "image"}
      </a>
    ),
  };
}

// ---------------------------------------------------------------- chat variant (compact)

const chatComponents: Components = {
  ...shared("chat"),
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
  code({ node: _node, className, children, ...props }) {
    const block = isBlockCode(className, children);
    return (
      <code
        {...props}
        className={cn(
          block
            ? "bg-transparent p-0"
            : "rounded-[5px] border bg-muted/70 px-1 py-px font-mono text-[0.86em] text-rose-600 dark:bg-white/5 dark:text-rose-300",
          className,
        )}
      >
        {children}
      </code>
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
};

// ---------------------------------------------------------------- document variant (Work Zone)

const documentComponents: Components = {
  ...shared("document"),
  h1: ({ children }) => <h3 className="mt-4 mb-2 font-semibold text-base first:mt-0">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-4 mb-2 font-semibold text-[15px] first:mt-0">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-3 mb-1.5 font-semibold text-sm first:mt-0">{children}</h4>,
  p: ({ children }) => <p className="my-2 leading-relaxed first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => (
    <ul className="my-2 list-disc space-y-1 pl-5 marker:text-muted-foreground">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 list-decimal space-y-1 pl-5 marker:text-muted-foreground">{children}</ol>
  ),
  li: ({ children }) => <li className="pl-0.5">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-primary/40 pl-3 text-muted-foreground">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-4 border-border" />,
  table: ({ children }) => (
    <div className="scrollbar-thin my-3 overflow-x-auto rounded-lg border">
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b bg-muted/50 px-3 py-1.5 text-left font-medium">{children}</th>
  ),
  td: ({ children }) => <td className="border-b px-3 py-1.5 align-top last:border-b-0">{children}</td>,
  pre: ({ children }) => (
    <pre className="scrollbar-thin my-3 overflow-x-auto rounded-lg border bg-muted/50 p-3 font-mono text-[12.5px] leading-relaxed dark:bg-black/30">
      {children}
    </pre>
  ),
  code: ({ className, children }) => {
    if (isBlockCode(className, children))
      return <code className={cn("font-mono", className)}>{children}</code>;
    return (
      <code className="rounded-[5px] bg-muted px-1.5 py-0.5 font-mono text-[0.86em] text-foreground">
        {children}
      </code>
    );
  },
};

const COMPONENTS: Record<MarkdownVariant, Components> = {
  chat: chatComponents,
  document: documentComponents,
};

const ROOT_CLASS: Record<MarkdownVariant, string> = {
  chat: "chat-markdown text-[14.5px] leading-[1.55] text-foreground/95",
  document: "min-w-0 break-words text-[14px]",
};

/**
 * `variant` "chat": compact (headings as bold paragraphs, tight spacing, 14.5 px). "document": the Work Zone
 * styles (real headings, wider spacing). `streaming`: the text is a partial answer still arriving.
 */
export const Markdown = memo(function Markdown({
  text,
  variant = "chat",
  streaming: _streaming,
  className,
}: {
  text: string;
  variant?: MarkdownVariant;
  streaming?: boolean;
  className?: string;
}) {
  return (
    <div className={cn(ROOT_CLASS[variant], className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // Explicit list: never a raw-HTML plugin (D-05).
        rehypePlugins={[
          rehypePlainLargeCode,
          [rehypeHighlight, { detect: true, plainText: ["plaintext"] }],
          rehypeMentions,
        ]}
        components={COMPONENTS[variant]}
        urlTransform={urlTransform}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
