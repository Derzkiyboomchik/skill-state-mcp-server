#!/usr/bin/env node
/**
 * SKILL.state MCP runtime — entry point.
 *
 * Transports:
 *   stdio (default)   : canonical MCP transport for local clients such as
 *                       Claude Desktop, Cursor, or any MCP host.
 *                       Usage:  bun index.ts
 *
 *   Streamable HTTP   : for remote/shared deployment.
 *                       Usage:  bun index.ts --http --port 3211
 *                       Endpoint: http://<host>:<port>/mcp
 *                       Health:   http://<host>:<port>/health
 *
 * Both transports share the same in-memory SessionStore (see src/state.ts), so
 * skill sessions survive MCP client reconnects and are concurrency-safe.
 *
 * NOTE (stdio mode): stdout is the JSON-RPC channel. ALL diagnostics are
 * written to stderr only.
 */

import { createServer, IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { buildMcpServer, SERVER_INFO } from "./src/server.js";
import { globalSessionStore } from "./src/state.js";
import { getAsciiBanner } from "./src/banner.js";

/* ────────────────────────────── CLI args ───────────────────────────────── */

const argv = process.argv.slice(2);

function printHelp(): void {
  process.stderr.write(
    [
      getAsciiBanner(),
      "Usage:",
      "  npx @bub0lehich/skill-state-mcp-server           Run over stdio (default MCP transport)",
      "  npx @bub0lehich/skill-state-mcp-server --http    Run Streamable HTTP on /mcp (:3211)",
      "  npx @bub0lehich/skill-state-mcp-server --help    Show this help",
      "",
      "Local development:",
      "  npm start / npm run dev                          Run locally",
      "  npm test                                         Run test suite",
      "  npm run demo                                     Run end-to-end demo",
      "",
      "Environment Variables:",
      "  SKILL_STATE_MAX_SESSIONS         Max concurrent sessions (default 256)",
      "  SKILL_STATE_SESSION_TTL_HOURS    Idle TTL before eviction (default 24)",
      "  SKILL_STATE_PORT                 Default HTTP port when --port is omitted",
      "",
    ].join("\n"),
  );
}

const wantsHelp = argv.includes("--help") || argv.includes("-h") || argv.includes("--info");
const wantsHttp = argv.includes("--http");
const portFlag = argv.indexOf("--port");
const httpPort =
  (portFlag !== -1 ? Number(argv[portFlag + 1]) : NaN) ||
  Number(process.env.SKILL_STATE_PORT) ||
  3211;

if (wantsHelp) {
  printHelp();
  process.exit(0);
}

/* ─────────────────────────── stdio transport ───────────────────────────── */

async function runStdio(): Promise<void> {
  const server = buildMcpServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);

  process.stderr.write(
    `[${SERVER_INFO.name}] v${SERVER_INFO.version} ready on stdio · sessions: ${globalSessionStore.activeIds().length}\n`,
  );

  const shutdown = async (signal: string) => {
    process.stderr.write(`[${SERVER_INFO.name}] received ${signal}, shutting down\n`);
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

/* ────────────────────── Streamable HTTP transport ──────────────────────── */

interface HttpMcpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

/** MCP client sessions active over HTTP, keyed by the mcp-session-id header. */
const httpMcpSessions = new Map<string, HttpMcpSession>();

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Request body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

async function runHttp(port: number): Promise<void> {
  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // Liveness endpoint for sandbox/gateway health checks.
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          server: SERVER_INFO,
          active_skill_sessions: globalSessionStore.activeIds().length,
          active_mcp_sessions: httpMcpSessions.size,
        }),
      );
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found. MCP endpoint is POST /mcp." }));
      return;
    }

    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      // Existing MCP client session → route to its transport.
      if (sessionId && httpMcpSessions.has(sessionId)) {
        await httpMcpSessions.get(sessionId)!.transport.handleRequest(req, res);
        return;
      }

      if (req.method === "POST") {
        const body = await readJsonBody(req);

        // New MCP client session → must start with the initialize handshake.
        if (isInitializeRequest(body)) {
          const server = buildMcpServer();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableJsonResponse: true, // plain JSON responses; friendlier for gateways/curl
            onsessioninitialized: (id) => {
              httpMcpSessions.set(id, { server, transport });
              process.stderr.write(`[${SERVER_INFO.name}] MCP session opened: ${id}\n`);
            },
          });
          transport.onclose = () => {
            const id = transport.sessionId;
            if (id) {
              httpMcpSessions.delete(id);
              process.stderr.write(`[${SERVER_INFO.name}] MCP session closed: ${id}\n`);
            }
          };
          await server.connect(transport);
          await transport.handleRequest(req, res, body);
          return;
        }

        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32600, message: "Bad Request: send an initialize request first" },
            id: null,
          }),
        );
        return;
      }

      // GET/DELETE for unknown sessions.
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unknown MCP session" }));
    } catch (error) {
      process.stderr.write(`[${SERVER_INFO.name}] HTTP error: ${error}\n`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      } else {
        res.end();
      }
    }
  });

  httpServer.listen(port, () => {
    process.stderr.write(
      `[${SERVER_INFO.name}] v${SERVER_INFO.version} listening on http://0.0.0.0:${port}/mcp ` +
        `(skill sessions: ${globalSessionStore.activeIds().length})\n`,
    );
  });

  const shutdown = async (signal: string) => {
    process.stderr.write(`[${SERVER_INFO.name}] received ${signal}, shutting down\n`);
    for (const { server, transport } of httpMcpSessions.values()) {
      await transport.close();
      await server.close();
    }
    httpMcpSessions.clear();
    httpServer.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

/* ────────────────────────────── bootstrap ──────────────────────────────── */

if (wantsHttp) {
  await runHttp(httpPort);
} else {
  await runStdio();
}
