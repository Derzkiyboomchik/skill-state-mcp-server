import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../src/server.js";

test("McpServer: full integration test over in-memory transport", async () => {
  const server = buildMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);

  try {
    // 1. List tools
    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name);
    assert.ok(toolNames.includes("initialize_skill"));
    assert.ok(toolNames.includes("execute_step"));
    assert.ok(toolNames.includes("inject_observation"));
    assert.ok(toolNames.includes("parse_turn_response"));
    assert.ok(toolNames.includes("close_session"));

    // 2. Initialize skill
    const SECRET_REASONING = "SECRET-TEST-REASONING-XYZ-987";
    const initRes = await client.callTool({
      name: "initialize_skill",
      arguments: {
        session_id: "test-session-1",
        skill_specification: "Test Procedure: perform task 1 and 2.",
        initial_state: { step: 0, items: ["apple"] },
      },
    });
    const initData = initRes.structuredContent as Record<string, unknown>;
    assert.equal(initData.session_id, "test-session-1");

    // 3. Execute step with CoT
    const stepRes = await client.callTool({
      name: "execute_step",
      arguments: {
        session_id: "test-session-1",
        reasoning_trace: SECRET_REASONING,
        state_update: { step: 1, items: ["banana"] },
        action: "continue",
        environment_observation: "boot",
      },
    });
    const stepText = JSON.stringify(stepRes);
    // Guarantees: reasoning is NEVER retained or echoed
    assert.equal(stepText.includes(SECRET_REASONING), false, "Reasoning trace must not leak into response");

    const stepData = stepRes.structuredContent as {
      prompt_payload: { current_state: { step: number; items: string[] } };
    };
    assert.deepEqual(stepData.prompt_payload.current_state, { step: 1, items: ["banana"] });

    // 4. Inject external observation
    const injectRes = await client.callTool({
      name: "inject_observation",
      arguments: {
        session_id: "test-session-1",
        observation: "External alarm: sensor triggered",
        state_patch: { alarm: true },
      },
    });
    const injectData = injectRes.structuredContent as {
      prompt_payload: { latest_observation: string; current_state: { alarm: boolean } };
    };
    assert.equal(injectData.prompt_payload.latest_observation, "External alarm: sensor triggered");
    assert.equal(injectData.prompt_payload.current_state.alarm, true);

    // 5. Parse turn response
    const rawTurn = [
      "I am thinking about step 2.",
      "```json",
      '{"state_patch": {"alarm": null, "step": 2}, "action": "reset-alarm"}',
      "```",
    ].join("\n");
    const parseRes = await client.callTool({
      name: "parse_turn_response",
      arguments: { response_text: rawTurn },
    });
    const parseData = parseRes.structuredContent as {
      reasoning_trace: string;
      state_update: Record<string, unknown>;
      action: string;
    };
    assert.match(parseData.reasoning_trace, /I am thinking about step 2/);
    assert.deepEqual(parseData.state_update, { alarm: null, step: 2 });
    assert.equal(parseData.action, "reset-alarm");

    // 6. Inspect via resource
    const res = await client.readResource({ uri: "skill-state://test-session-1" });
    assert.ok(res.contents.length > 0);
    const resText = res.contents[0].text;
    assert.equal(resText?.includes(SECRET_REASONING), false, "Reasoning trace must not be in resource");

    // 7. Get canonical paper prompt
    const prompt = await client.getPrompt({
      name: "skill_state_paper_turn",
      arguments: { session_id: "test-session-1", compact: "true" },
    });
    const promptText = (prompt.messages[0].content as { text: string }).text;
    assert.match(promptText, /Instructions:/);
    assert.match(promptText, /Skill Execution State:/);
    assert.match(promptText, /Provide your response with:/);
    assert.equal(promptText.includes(SECRET_REASONING), false);

    // 8. Close session
    const closeRes = await client.callTool({
      name: "close_session",
      arguments: { session_id: "test-session-1" },
    });
    const closeData = closeRes.structuredContent as { closed: boolean };
    assert.equal(closeData.closed, true);
  } finally {
    await client.close();
    await server.close();
  }
});
