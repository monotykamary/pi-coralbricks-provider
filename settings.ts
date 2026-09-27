import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type CoralApi = "chat-completions" | "responses";
export interface CoralConfig { api: CoralApi }

export function configPath(): string {
  return path.join(getAgentDir(), "extensions", "coralbricks.json");
}

function readRawConfig(): Record<string, unknown> {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Expected a JSON object");
    return raw;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export function loadConfig(): CoralConfig {
  try {
    return { api: readRawConfig().api === "responses" ? "responses" : "chat-completions" };
  } catch {
    return { api: "chat-completions" };
  }
}

/** Preserve unrelated fields; never overwrite malformed settings. */
export function saveApi(api: CoralApi): void {
  const raw = readRawConfig();
  raw.api = api;
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function registerSettingsCommand(
  pi: ExtensionAPI,
  getConfig: () => CoralConfig,
  apply: (config: CoralConfig) => void,
): void {
  pi.registerCommand("coralbricks-settings", {
    description: "Configure CoralBricks API: Chat Completions or opt-in Responses",
    async handler(_args, ctx) {
      if (!ctx.hasUI) {
        ctx.ui.notify("/coralbricks-settings requires a UI (TUI or GUI).", "error");
        return;
      }
      const values: CoralApi[] = ["chat-completions", "responses"];
      const change = (value: string): boolean => {
        if (!values.includes(value as CoralApi)) return false;
        try {
          saveApi(value as CoralApi);
        } catch {
          ctx.ui.notify(`Could not save ${configPath()}. Check its JSON and permissions; API unchanged.`, "error");
          return false;
        }
        apply({ api: value as CoralApi });
        ctx.ui.notify(`CoralBricks API: ${value} — applies to the next request.`, "info");
        return true;
      };

      if (ctx.mode !== "tui") {
        const selected = await ctx.ui.select(`CoralBricks API (current: ${getConfig().api})`, values);
        if (selected !== undefined) change(selected);
        return;
      }

      const { SettingsList, Container, Text } = await import("@earendil-works/pi-tui");
      const { getSettingsListTheme, DynamicBorder } = await import("@earendil-works/pi-coding-agent");
      await ctx.ui.custom<void>((tui, theme, _kb, done) => {
        const container = new Container();
        const border = () => new DynamicBorder((s: string) => theme.fg("border", s));
        container.addChild(border());
        container.addChild(new Text("CoralBricks settings", 1, 0));
        const list = new SettingsList([
          {
            id: "api",
            label: "API surface",
            description: "Chat Completions is the default. Responses is opt-in, replays full history with store:false; no server-side threading or background jobs.",
            currentValue: getConfig().api,
            values,
          },
        ], 3, getSettingsListTheme(), (_id, value) => {
          if (!change(value)) list.updateValue("api", getConfig().api);
        }, () => done(), { enableSearch: true });
        container.addChild(list);
        container.addChild(border());
        return {
          render: (width: number) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput(data: string) {
            list.handleInput(data);
            tui.requestRender();
          },
        };
      });
    },
  });
}
