/**
 * Parking: continue Coral Responses turns with `previous_response_id`.
 *
 * pi replays the whole transcript on every request. With parking on, each
 * response is stored on Coral (`store: true`) and the next request sends only
 * the items that came after it (tool results, the next user message). Coral
 * keeps the parked state, sticky-routes the chain to the same replica and
 * bills only the new input.
 *
 * A chain is used only when the full input pi would have sent starts with
 * exactly the input of the parked request, followed by that response's own
 * output items. Anything else (compaction, a model switch, an edited or
 * branched history, a restart) sends the full transcript, which parks again.
 * If Coral no longer has the parent (`previous_response_not_found`), the same
 * request is re-sent once in full.
 */
import { createHash } from "node:crypto";

type Item = Record<string, unknown>;

interface ParkedTurn {
  model: string;
  /** Digests of the full input sent with the request that produced this response. */
  input: string[];
}

export interface ParkPlan {
  /** Request body to send. */
  params: Record<string, any>;
  /** Full-transcript body to re-send if the parent is gone; undefined when not chained. */
  fallback?: Record<string, any>;
  /** Digests of the full input, recorded against the response id on success. */
  input: string[];
}

const MAX_PARKED = 256;
const parked = new Map<string, ParkedTurn>();

function digest(item: unknown): string {
  return createHash("sha256").update(JSON.stringify(item)).digest("base64url");
}

function isOutputItem(item: Item): boolean {
  return item.type === "reasoning"
    || item.type === "function_call"
    || item.type === "custom_tool_call"
    || (item.type === "message" && item.role === "assistant");
}

/** The last assistant message, if it is a completed Coral Responses turn from this model. */
function parentId(messages: any[] | undefined, model: { id: string; provider: string }): string | undefined {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const msg = messages![i];
    if (msg?.role !== "assistant") continue;
    const ok = typeof msg.responseId === "string"
      && msg.provider === model.provider
      && msg.api === "openai-responses"
      && msg.model === model.id
      && msg.stopReason !== "error"
      && msg.stopReason !== "aborted";
    return ok ? msg.responseId : undefined;
  }
  return undefined;
}

export function planPark(params: Record<string, any>, messages: any[] | undefined, model: { id: string; provider: string }): ParkPlan {
  const full: Item[] = Array.isArray(params.input) ? params.input : [];
  const input = full.map(digest);
  const stored: Record<string, any> = { ...params, store: true };
  delete stored.previous_response_id;

  const id = parentId(messages, model);
  const turn = id ? parked.get(id) : undefined;
  if (!id || !turn || turn.model !== model.id || turn.input.length > input.length) return { params: stored, input };
  for (let i = 0; i < turn.input.length; i++) {
    if (turn.input[i] !== input[i]) return { params: stored, input };
  }

  // Skip the parent's own output; Coral already holds it.
  let start = turn.input.length;
  while (start < full.length && isOutputItem(full[start])) start++;
  const delta = full.slice(start);
  if (delta.length === 0 || delta.some(isOutputItem)) return { params: stored, input };

  return { params: { ...stored, previous_response_id: id, input: delta }, fallback: stored, input };
}

export function park(responseId: string, model: string, input: string[]): void {
  parked.delete(responseId);
  parked.set(responseId, { model, input });
  while (parked.size > MAX_PARKED) parked.delete(parked.keys().next().value!);
}

export function forget(responseId: string): void {
  parked.delete(responseId);
}

export function clearParked(): void {
  parked.clear();
}

export function isParentMissing(status: number, body: string): boolean {
  return (status === 404 || status === 400) && body.includes("previous_response_not_found");
}

/**
 * Wrap fetch so a chained request whose parent Coral no longer has is re-sent
 * once with the full transcript. Every other response passes through untouched.
 */
export function withParkFallback(base: typeof fetch, plan: () => ParkPlan | undefined): typeof fetch {
  return async (input: any, init?: any) => {
    const response = await base(input, init);
    const current = plan();
    if (response.ok || !current?.fallback) return response;
    const body = await response.clone().text().catch(() => "");
    if (!isParentMissing(response.status, body)) return response;
    forget(current.params.previous_response_id);
    const headers = new Headers(init?.headers);
    headers.delete("content-length");
    return base(input, { ...init, headers, body: JSON.stringify(current.fallback) });
  };
}
