import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as p from "@clack/prompts";

export function getClaudeDesktopConfigPath(): string {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || "", "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
}

export function getCursorProjectConfigPath(): string {
  return path.join(process.cwd(), ".cursor", "mcp.json");
}

export function getClineConfigPath(): string {
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA || "",
      "Code",
      "User",
      "globalStorage",
      "saoudrizwan.claude-dev",
      "settings",
      "cline_mcp_settings.json",
    );
  }
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Code",
      "User",
      "globalStorage",
      "saoudrizwan.claude-dev",
      "settings",
      "cline_mcp_settings.json",
    );
  }
  return path.join(
    os.homedir(),
    ".config",
    "Code",
    "User",
    "globalStorage",
    "saoudrizwan.claude-dev",
    "settings",
    "cline_mcp_settings.json",
  );
}

export function updateMcpConfigFile(
  filePath: string,
  entry: { command: string; args: string[] },
): { success: boolean; error?: string } {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    let config: { mcpServers?: Record<string, unknown> } = { mcpServers: {} };
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf-8").trim();
      if (content) {
        config = JSON.parse(content);
      }
    }

    if (!config.mcpServers || typeof config.mcpServers !== "object") {
      config.mcpServers = {};
    }

    config.mcpServers["skill-state"] = entry;

    fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    return { success: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

export interface SetupResult {
  action: "run_stdio" | "run_http" | "exit";
  httpPort?: number;
}

export async function runInteractiveSetup(): Promise<SetupResult> {
  p.intro("⚡ SKILL.state MCP Server — Setup & Installation Wizard");

  const target = await p.select({
    message: "Куда вы хотите установить и подключить SKILL.state MCP сервер?",
    options: [
      {
        value: "claude",
        label: "Claude Desktop (глобально для всех чатов в системе)",
        hint: getClaudeDesktopConfigPath(),
      },
      {
        value: "cursor",
        label: "Cursor (только для этого проекта: .cursor/mcp.json)",
        hint: getCursorProjectConfigPath(),
      },
      {
        value: "cline",
        label: "VS Code / Cline (глобально для расширения)",
        hint: getClineConfigPath(),
      },
      {
        value: "all",
        label: "Установить во все поддерживаемые клиенты (Claude + Cursor)",
      },
      {
        value: "manual",
        label: "Не менять конфиги — просто запустить сервер сейчас",
      },
    ],
  });

  if (p.isCancel(target)) {
    p.cancel("Установка отменена.");
    process.exit(0);
  }

  if (target !== "manual") {
    const execMode = await p.select({
      message: "Какую команду использовать в конфигурационном файле?",
      options: [
        {
          value: "npx",
          label: "npx -y @bub0lehich/skill-state-mcp-server (Рекомендуется — авто-обновления)",
        },
        {
          value: "binary",
          label: "skill-state-mcp-server (Локальный бинарник из npm install -g)",
        },
      ],
    });

    if (p.isCancel(execMode)) {
      p.cancel("Установка отменена.");
      process.exit(0);
    }

    const entry =
      execMode === "npx"
        ? { command: "npx", args: ["-y", "@bub0lehich/skill-state-mcp-server"] }
        : { command: "skill-state-mcp-server", args: [] };

    const s = p.spinner();
    s.start("Сохранение конфигурации...");

    const targetsToUpdate: string[] = [];
    if (target === "claude" || target === "all") targetsToUpdate.push(getClaudeDesktopConfigPath());
    if (target === "cursor" || target === "all") targetsToUpdate.push(getCursorProjectConfigPath());
    if (target === "cline") targetsToUpdate.push(getClineConfigPath());

    const updatedPaths: string[] = [];
    for (const filePath of targetsToUpdate) {
      const res = updateMcpConfigFile(filePath, entry);
      if (res.success) {
        updatedPaths.push(filePath);
      }
    }

    s.stop("Конфигурация успешно сохранена!");

    p.note(
      updatedPaths.map((pPath) => `✔ ${pPath}`).join("\n") +
        "\n\nСервер добавлен в секцию 'mcpServers.skill-state'.",
      "Обновленные файлы конфигурации",
    );
  }

  const startNow = await p.select({
    message: "Запустить ли сервер прямо сейчас?",
    options: [
      {
        value: "stdio",
        label: "Запустить по stdio (стандартный транспорт MCP)",
      },
      {
        value: "http",
        label: "Запустить HTTP daemon на порту 3211",
      },
      {
        value: "exit",
        label: "Нет, завершить установку (конфигурация сохранена)",
      },
    ],
  });

  if (p.isCancel(startNow) || startNow === "exit") {
    p.outro("Готово! Перезапустите Claude Desktop или Cursor для применения настроек.");
    return { action: "exit" };
  }

  if (startNow === "http") {
    p.outro("Запуск HTTP сервера на http://0.0.0.0:3211/mcp ...");
    return { action: "run_http", httpPort: 3211 };
  }

  p.outro("Запуск MCP сервера по stdio...");
  return { action: "run_stdio" };
}
