import test from "node:test";
import assert from "node:assert/strict";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../src/server.js";

test("MCP server registers required GDS tools", async () => {
  const server = createServer();

  const handler = (server as any)._requestHandlers.get(ListToolsRequestSchema.shape.method.value);
  assert.ok(handler, "ListTools handler must be registered");

  const response = await handler({ method: "tools/list" });
  assert.ok(response.tools, "Tools list must be returned");

  const toolNames = response.tools.map((t: any) => t.name);
  assert.ok(toolNames.includes("gds_info"), "gds_info must be present");
  assert.ok(toolNames.includes("gds_stream_out"), "gds_stream_out must be present");
  assert.ok(toolNames.includes("drc_klayout"), "drc_klayout must be present");
  assert.ok(toolNames.includes("lvs_netgen"), "lvs_netgen must be present");
  assert.ok(toolNames.includes("extract_magic"), "extract_magic must be present");
  assert.ok(toolNames.includes("gds_toolchain_info"), "gds_toolchain_info must be present");

  for (const tool of response.tools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.ok(tool.description && tool.description.length > 10);
  }
});
