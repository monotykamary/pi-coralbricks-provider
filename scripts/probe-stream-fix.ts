/**
 * Live probe: stream gpt-oss-120b through streamCoral (the extension's
 * streamSimple path) and verify the tool-call index bug is repaired — the
 * accumulated message must contain exactly one complete tool call.
 */
import { streamCoral } from "../index.ts";
import modelsData from "../models.json" with { type: "json" };

const apiKey = process.env.CORALBRICKS_API_KEY;
if (!apiKey) throw new Error("CORALBRICKS_API_KEY not set");

const modelId = process.argv[2] ?? "gpt-oss-120b";
const model = {
  ...(modelsData as any[]).find((m) => m.id === modelId)!,
  provider: "coralbricks",
  baseUrl: "https://inference.coralbricks.ai/v1",
  api: "openai-completions",
};

const context = {
  systemPrompt: "You are a helpful assistant.",
  messages: [
    { role: "user", content: [{ type: "text", text: "What is the weather in Paris? Use the tool." }] },
  ],
  tools: [
    {
      name: "get_weather",
      description: "Get current weather for a location",
      parameters: {
        type: "object",
        properties: { location: { type: "string", description: "City name" } },
        required: ["location"],
      } as any,
    },
  ],
};

const events = streamCoral(model, context, { apiKey, reasoning: "high" } as any);
let finalMessage: any = null;
for await (const event of events) {
  if (event.type === "done") finalMessage = event.message;
  if (event.type === "error") finalMessage = event.error;
}

if (!finalMessage) throw new Error("no final message");
if (finalMessage.stopReason === "error") {
  throw new Error("stream error: " + finalMessage.errorMessage);
}

const calls = (finalMessage.content ?? []).filter((c: any) => c.type === "toolCall");
console.log("stopReason:", finalMessage.stopReason);
console.log("toolCalls:", calls.length);
for (const call of calls) {
  console.log("  -", call.name, JSON.stringify(call.arguments));
}

if (calls.length !== 1) throw new Error(`expected exactly 1 tool call, got ${calls.length}`);
const args = typeof calls[0].arguments === "string" ? JSON.parse(calls[0].arguments) : calls[0].arguments;
if (!args.location || !/paris/i.test(String(args.location))) {
  throw new Error("arguments malformed: " + JSON.stringify(calls[0].arguments));
}
console.log("PASS: streamCoral produced exactly one complete tool call");
