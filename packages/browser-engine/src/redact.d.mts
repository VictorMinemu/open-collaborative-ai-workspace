// Types of redact.mjs (07.13 D-04, PD-02): the bots' redacting snapshot serializer, shared with the Work Zone runtime.

/** A CDP `Accessibility.AXNode`, only the fields the serializer reads. */
export interface AXValue {
  value?: unknown;
}
export interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  childIds?: string[];
  backendDOMNodeId?: number;
}

/** A field's DOM facts, read in the agent's isolated world; never its value. */
export interface FieldFacts {
  tag?: string | null;
  type?: string | null;
  autocomplete?: string | null;
  textSecurity?: string | null;
  label?: string | null;
  attrName?: string | null;
  attrId?: string | null;
  placeholder?: string | null;
  ariaLabel?: string | null;
}

/** backendDOMNodeId → facts. */
export type FactsMap = Map<number, FieldFacts>;
/** backendDOMNodeIds of fields a person typed into during a takeover. */
export type Marks = Set<number>;

export interface SnapshotNode {
  ref: string;
  role: string;
  name: string;
  value: string | null;
  redacted: boolean;
  depth: number;
}

export interface SnapshotOptions {
  maxNodes?: number;
  maxText?: number;
}

export interface Snapshot {
  nodes: SnapshotNode[];
  text: string;
  truncated: boolean;
}

export const REDACTED: "[redacted]";
export const SENSITIVE_AUTOCOMPLETE: RegExp;
export const SENSITIVE_LABEL: RegExp;

export function refFor(backendId: number): string;
export function backendIdFromRef(ref: unknown): number | null;
export function isSensitiveField(facts: FieldFacts | null | undefined, name?: string): boolean;
export function isSensitive(node: AXNode, marks?: Marks, facts?: FactsMap): boolean;
export function serializeSnapshot(
  axNodes: readonly AXNode[] | null | undefined,
  marks?: Marks,
  facts?: FactsMap,
  options?: SnapshotOptions,
): Snapshot;
