import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { updateMcpConfigFile } from "../src/installer.js";

test("updateMcpConfigFile: creates new config and adds skill-state", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-test-"));
  const configFile = path.join(tmpDir, "sub", "mcp.json");

  const entry = {
    command: "npx",
    args: ["-y", "@bub0lehich/skill-state-mcp-server"],
  };

  const res = updateMcpConfigFile(configFile, entry);
  assert.equal(res.success, true);
  assert.equal(fs.existsSync(configFile), true);

  const parsed = JSON.parse(fs.readFileSync(configFile, "utf-8"));
  assert.deepEqual(parsed.mcpServers["skill-state"], entry);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("updateMcpConfigFile: preserves existing servers in config", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-test-"));
  const configFile = path.join(tmpDir, "mcp.json");

  fs.writeFileSync(
    configFile,
    JSON.stringify({
      mcpServers: {
        other_server: { command: "node", args: ["other.js"] },
      },
    }),
    "utf-8",
  );

  const entry = {
    command: "npx",
    args: ["-y", "@bub0lehich/skill-state-mcp-server"],
  };

  const res = updateMcpConfigFile(configFile, entry);
  assert.equal(res.success, true);

  const parsed = JSON.parse(fs.readFileSync(configFile, "utf-8"));
  assert.deepEqual(parsed.mcpServers["other_server"], { command: "node", args: ["other.js"] });
  assert.deepEqual(parsed.mcpServers["skill-state"], entry);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
