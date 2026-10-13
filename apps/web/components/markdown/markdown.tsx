"use client";

import { isReservedHandle } from "@ocw/contracts";
import { code } from "@streamdown/code";
import Link from "next/link";
import { createContext, memo, useContext, useMemo } from "react";
import {
  type Components,
  type ControlsConfig,
  defaultRehypePlugins,
  defaultUrlTransform,
  Streamdown,
  type UrlTransform,
} from "streamdown";
import { cn } from "@/lib/utils";
import { type HastNode, rehypeMentions } from "./rehype-mentions";
import { safeUrl } from "./safe-url";

/**
 * The one Markdown renderer (D-05, CHAT-05): channel messages, thread replies, DMs, bot output and the Work Zone
 * stream, on streamdown (streaming-safe parsing, block memoisation) with shiki highlighting from @streamdown/code.
 *
 * Security: the rehype list is explicit and never contains streamdown's raw-HTML plugin, so HTML in a message is
 * shown as text; images become links before the hardening plugin runs (no remote pixels); rehype-harden refuses
 * every non-http(s)/mailto URL and `safeUrl` (urlTransform, the authority) re-checks what a browser would parse.
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
const urlTransform: UrlTransform = (url, key, node) => safeUrl(defaultUrlTransform(url, key, node));

const LINK_REL = "noopener noreferrer nofollow";

/** Code blocks above this size are not highlighted (a pasted log must never freeze the tab, T-04-02-04). */
const HIGHLIGHT_MAX_CHARS = 20_000;

function textLength(node: HastNode): number {
  return node.type === "text"
    ? (node.value?.length ?? 0)
    : (node.children ?? []).reduce((n, c) => n + textLength(c), 0);
}

/**
 * Before hardening: every image becomes a link to its URL (alt text as label), so no `<img>` ever reaches the
 * DOM and the link rules decide its URL; oversized code blocks lose their language so shiki skips them.
 */
function rehypeImagesAsLinksAndPlainLargeCode() {
  const visit = (node: HastNode) => {
    if (node.type === "element" && node.tagName === "img") {
      const alt =
        typeof node.properties?.alt === "string" && node.properties.alt ? node.properties.alt : "image";
      node.tagName = "a";
      node.properties = { href: node.properties?.src, dataImageLink: "" };
      node.children = [{ type: "text", value: alt }];
      return;
    }
    if (node.type === "element" && node.tagName === "code" && textLength(node) > HIGHLIGHT_MAX_CHARS) {
      node.properties = { ...node.properties, className: [] };
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  return visit;
}

/** A relative reference: no scheme, not root- or protocol-relative, not a bare fragment or query. */
const isRelative = (href: string) => !/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^[/\\#?]/u.test(href);

/**
 * Document variant with `resolveHref` only (memory files, 07.2-10): before hardening, every relative link (never an
 * image turned into a link) is handed to the resolver. A result becomes an in-app link (`data-in-app`), which still
 * goes through the hardening plugin and `safeUrl` like any other link; null renders the link text as plain text.
 * External, root-relative and fragment links are left to the usual rules.
 */
function rehypeInAppLinks(options: { resolve: (href: string) => string | null }) {
  const visit = (node: HastNode) => {
    for (const child of node.children ?? []) {
      const props = child.properties ?? {};
      if (child.type === "element" && child.tagName === "a" && !("dataImageLink" in props)) {
        const href = typeof props.href === "string" ? props.href.trim() : "";
        if (href && isRelative(href)) {
          const target = options.resolve(href);
          if (target) child.properties = { href: target, dataInApp: "" };
          else {
            child.tagName = "span";
            child.properties = {};
          }
        }
      }
      visit(child);
    }
  };
  return visit;
}

/** streamdown's hardening plugin with our policy (it ships it; no second copy of rehype-harden). */
const hardenPlugin = (defaultRehypePlugins.harden as [unknown, unknown])[0];

const HARDEN = [
  hardenPlugin,
  {
    // "*" admits only http(s) and root-relative paths; mailto passes as a safe protocol. safeUrl narrows the rest.
    allowedLinkPrefixes: ["*"],
    allowedImagePrefixes: [],
    allowDataImages: false,
    allowedProtocols: [],
    linkBlockPolicy: "text-only",
    imageBlockPolicy: "text-only",
  },
] as const;

const REHYPE_PLUGINS = [rehypeImagesAsLinksAndPlainLargeCode, HARDEN, rehypeMentions] as const;

const PLUGINS = { code };

/** Copy on code blocks; no downloads, no table/image/diagram controls. */
const CONTROLS: ControlsConfig = {
  code: { copy: true, download: false },
  table: false,
  image: false,
  mermaid: false,
};

// ---------------------------------------------------------------- shared components

/** A `@handle` chip (people and bots from MentionContext; unknown handles stay plain text). Also used by snippets. */
export function MentionChip({ handle, children }: { handle: string; children: React.ReactNode }) {
  const { handles, myHandle } = useContext(MentionContext);
  // @channel / @here / @everyone: a broadcast, never a person (Pitfall 6); no directory entry needed.
  if (isReservedHandle(handle)) {
    return (
      <span
        data-testid="mention-all"
        title={handle === "here" ? "Notified everyone online" : "Notified everyone in the channel"}
        className="rounded-[4px] bg-amber-400/25 px-0.5 font-semibold text-amber-900 dark:bg-amber-400/20 dark:text-amber-200"
      >
        {children}
      </span>
    );
  }
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

/** The props streamdown passes to an element override (hast properties as React props, plus `node`). */
interface Props {
  node?: unknown;
  children?: React.ReactNode;
  className?: string;
  href?: unknown;
  src?: unknown;
  alt?: unknown;
  start?: unknown;
}

function shared(variant: MarkdownVariant): Components {
  const linkClass =
    variant === "chat"
      ? "font-medium text-primary underline-offset-2 hover:underline"
      : "text-primary underline-offset-4 hover:underline";
  return {
    span: ({ node: _node, ...props }: Props) => {
      const handle = (props as Record<string, unknown>)["data-mention"];
      if (typeof handle === "string") return <MentionChip handle={handle}>{props.children}</MentionChip>;
      return <span {...props} />;
    },
    a: ({ node: _node, className, href, children, ...rest }: Props) => {
      const extra = rest as Record<string, unknown>;
      const image = "data-image-link" in extra;
      // A memory link resolved by `resolveHref` (already through harden and safeUrl): client navigation, same tab.
      if ("data-in-app" in extra && typeof href === "string") {
        return (
          <Link href={href} data-in-app="" className={cn(linkClass, className)}>
            {children}
          </Link>
        );
      }
      return (
        <a
          href={typeof href === "string" ? href : undefined}
          className={image ? "text-primary underline" : cn(linkClass, className)}
          target="_blank"
          rel={LINK_REL}
        >
          {children}
        </a>
      );
    },
    // Defence in depth: an image never renders as an image.
    img: ({ alt, src }: Props) => (
      <a
        href={typeof src === "string" ? src : undefined}
        target="_blank"
        rel={LINK_REL}
        className="text-primary underline"
      >
        {typeof alt === "string" && alt ? alt : "image"}
      </a>
    ),
    strong: ({ children }: Props) => <strong>{children}</strong>,
    thead: ({ children }: Props) => <thead>{children}</thead>,
    tbody: ({ children }: Props) => <tbody>{children}</tbody>,
    tr: ({ children }: Props) => <tr>{children}</tr>,
  };
}

// ---------------------------------------------------------------- chat variant (compact)

const chatComponents: Components = {
  ...shared("chat"),
  inlineCode: ({ node: _node, className, children }: Props) => (
    <code
      className={cn(
        "rounded-[5px] border bg-muted/70 px-1 py-px font-mono text-[0.86em] text-rose-600 dark:bg-white/5 dark:text-rose-300",
        className,
      )}
    >
      {children}
    </code>
  ),
  ul: ({ children }: Props) => <ul className="my-1 list-disc pl-5">{children}</ul>,
  ol: ({ children, start }: Props) => (
    <ol className="my-1 list-decimal pl-5" start={typeof start === "number" ? start : undefined}>
      {children}
    </ol>
  ),
  li: ({ children }: Props) => <li className="my-0.5 pl-0.5">{children}</li>,
  blockquote: ({ children }: Props) => (
    <blockquote className="my-1 border-muted-foreground/30 border-l-[3px] pl-3 text-muted-foreground">
      {children}
    </blockquote>
  ),
  h1: ({ children }: Props) => <p className="mt-1 font-semibold text-base">{children}</p>,
  h2: ({ children }: Props) => <p className="mt-1 font-semibold text-[15px]">{children}</p>,
  h3: ({ children }: Props) => <p className="mt-1 font-semibold">{children}</p>,
  h4: ({ children }: Props) => <p className="mt-1 font-semibold">{children}</p>,
  h5: ({ children }: Props) => <p className="mt-1 font-semibold">{children}</p>,
  h6: ({ children }: Props) => <p className="mt-1 font-semibold">{children}</p>,
  p: ({ children }: Props) => (
    <p className="whitespace-pre-wrap break-words [&:not(:first-child)]:mt-1.5">{children}</p>
  ),
  table: ({ children }: Props) => (
    <div className="scrollbar-thin my-1.5 overflow-x-auto">
      <table className="w-max border-collapse text-[13px]">{children}</table>
    </div>
  ),
  th: ({ children }: Props) => (
    <th className="border bg-muted/50 px-2.5 py-1 text-left font-semibold">{children}</th>
  ),
  td: ({ children }: Props) => <td className="border px-2.5 py-1">{children}</td>,
  hr: () => <hr className="my-2" />,
};

// ---------------------------------------------------------------- document variant (Work Zone)

type HeadingDepth = 1 | 2 | 3 | 4 | 5 | 6;
const DEPTHS: readonly HeadingDepth[] = [1, 2, 3, 4, 5, 6];

/** The document look of a Markdown heading, keyed by its Markdown depth (`#` = 1), whatever its HTML tag. */
const DOCUMENT_HEADING_CLASS: Record<HeadingDepth, string> = {
  1: "mt-4 mb-2 font-semibold text-base first:mt-0",
  2: "mt-4 mb-2 font-semibold text-[15px] first:mt-0",
  3: "mt-3 mb-1.5 font-semibold text-sm first:mt-0",
  4: "mt-3 mb-1.5 font-semibold text-sm first:mt-0",
  5: "mt-3 mb-1.5 font-semibold text-sm first:mt-0",
  6: "mt-3 mb-1.5 font-semibold text-sm first:mt-0",
};

/** h1…h6 overrides that keep each depth's look and take the HTML level from `levelOf(depth)` (clamped to 1…6). */
function documentHeadings(levelOf: (depth: HeadingDepth) => number): Components {
  const out: Record<string, (p: Props) => React.ReactNode> = {};
  for (const depth of DEPTHS) {
    const Tag = `h${Math.min(6, Math.max(1, levelOf(depth)))}` as `h${HeadingDepth}`;
    out[`h${depth}`] = ({ children }: Props) => (
      <Tag className={DOCUMENT_HEADING_CLASS[depth]}>{children}</Tag>
    );
  }
  return out as Components;
}

/**
 * The shallowest ATX heading depth in the text (`#` = 1), skipping fenced code; 1 when there is none. With
 * `headingLevel`, that depth renders at `headingLevel` and deeper ones follow it, so a file that starts at `##` does
 * not skip a level under the page's own heading (axe heading-order).
 */
function topHeadingDepth(text: string): number {
  let top = 6;
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (marker) {
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const depth = /^ {0,3}(#{1,6})(?:[ \t]|$)/u.exec(line)?.[1]?.length;
    if (depth !== undefined && depth < top) top = depth;
  }
  return top;
}

const leveledComponents = new Map<number, Components>();

/** The document components with Markdown depth `top` rendered as `h{level}` (cached: one object per shift). */
function documentComponentsAt(level: number, top: number): Components {
  const shift = level - top;
  let components = leveledComponents.get(shift);
  if (!components) {
    components = { ...documentComponents, ...documentHeadings((depth) => depth + shift) };
    leveledComponents.set(shift, components);
  }
  return components;
}

const documentComponents: Components = {
  ...shared("document"),
  inlineCode: ({ node: _node, children }: Props) => (
    <code className="rounded-[5px] bg-muted px-1.5 py-0.5 font-mono text-[0.86em] text-foreground">
      {children}
    </code>
  ),
  ...documentHeadings((depth) => (depth <= 2 ? 3 : 4)),
  p: ({ children }: Props) => <p className="my-2 leading-relaxed first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }: Props) => (
    <ul className="my-2 list-disc space-y-1 pl-5 marker:text-muted-foreground">{children}</ul>
  ),
  ol: ({ children, start }: Props) => (
    <ol
      className="my-2 list-decimal space-y-1 pl-5 marker:text-muted-foreground"
      start={typeof start === "number" ? start : undefined}
    >
      {children}
    </ol>
  ),
  li: ({ children }: Props) => <li className="pl-0.5">{children}</li>,
  blockquote: ({ children }: Props) => (
    <blockquote className="my-2 border-l-2 border-primary/40 pl-3 text-muted-foreground">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-4 border-border" />,
  table: ({ children }: Props) => (
    <div className="scrollbar-thin my-3 overflow-x-auto rounded-lg border">
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </div>
  ),
  th: ({ children }: Props) => (
    <th className="border-b bg-muted/50 px-3 py-1.5 text-left font-medium">{children}</th>
  ),
  td: ({ children }: Props) => <td className="border-b px-3 py-1.5 align-top last:border-b-0">{children}</td>,
};

const COMPONENTS: Record<MarkdownVariant, Components> = {
  chat: chatComponents,
  document: documentComponents,
};

const ROOT_CLASS: Record<MarkdownVariant, string> = {
  chat: "ocw-markdown chat-markdown text-[14.5px] leading-[1.55] text-foreground/95",
  document: "ocw-markdown min-w-0 break-words text-[14px]",
};

/**
 * `variant` "chat": compact (headings as bold paragraphs, tight spacing, 14.5 px). "document": the Work Zone
 * styles (real headings, wider spacing). `streaming`: the text is a partial answer still arriving (unterminated
 * fences and emphasis are completed for display).
 */
export const Markdown = memo(function Markdown({
  text,
  variant = "chat",
  streaming = false,
  className,
  resolveHref,
  headingLevel,
}: {
  text: string;
  variant?: MarkdownVariant;
  streaming?: boolean;
  className?: string;
  /**
   * Document variant only: maps a relative link to an in-app href (opened in place, same tab), or null to render its
   * text without a link. Pass a stable function (useCallback): it keys the plugin list.
   */
  resolveHref?: (href: string) => string | null;
  /**
   * Document variant only: the HTML level of the text's top heading, so its outline continues the page's (memory
   * files: 2, under the file name's h1). Unset keeps the Work Zone tags (h3/h4). The look never changes.
   */
  headingLevel?: HeadingDepth;
}) {
  const rehypePlugins = useMemo(
    () =>
      variant === "document" && resolveHref
        ? [
            rehypeImagesAsLinksAndPlainLargeCode,
            [rehypeInAppLinks, { resolve: resolveHref }],
            HARDEN,
            rehypeMentions,
          ]
        : REHYPE_PLUGINS,
    [variant, resolveHref],
  );
  const top = variant === "document" && headingLevel ? topHeadingDepth(text) : null;
  const components =
    top !== null && headingLevel ? documentComponentsAt(headingLevel, top) : COMPONENTS[variant];
  return (
    <div className={cn(ROOT_CLASS[variant], className)} data-variant={variant}>
      <Streamdown
        mode={streaming ? "streaming" : "static"}
        parseIncompleteMarkdown={streaming}
        isAnimating={streaming}
        // Explicit list: never streamdown's raw-HTML plugin (D-05).
        rehypePlugins={rehypePlugins as never}
        urlTransform={urlTransform}
        plugins={PLUGINS}
        controls={CONTROLS}
        lineNumbers={false}
        components={components}
        // streamdown's wrapper adds space-y-4 between blocks; spacing comes from each element instead.
        className="space-y-0"
      >
        {text}
      </Streamdown>
    </div>
  );
});
