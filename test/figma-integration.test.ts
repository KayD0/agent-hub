import assert from "node:assert/strict";
import test from "node:test";
import {
  FIGMA_MCP_SERVER_NAME,
  FIGMA_MCP_SERVER_URL,
  FigmaIntegrationService,
  McpIntegrationGateway,
  McpServerSummary,
} from "../src/application/figma-integration";

class FakeMcpGateway implements McpIntegrationGateway {
  public servers: McpServerSummary[] = [];
  public writes: Array<{ name: string; url: string }> = [];
  public reloads = 0;

  public async listMcpServers(): Promise<McpServerSummary[]> { return this.servers; }
  public async writeMcpServerConfig(name: string, url: string): Promise<void> { this.writes.push({ name, url }); }
  public async reloadMcpServers(): Promise<void> { this.reloads += 1; }
  public async startMcpOauthLogin(name: string): Promise<{ authorizationUrl: string }> {
    assert.equal(name, FIGMA_MCP_SERVER_NAME);
    return { authorizationUrl: "https://figma.example.test/oauth" };
  }
}

test("Figma integration distinguishes configuration, authentication, and ready states", async () => {
  const gateway = new FakeMcpGateway();
  const service = new FigmaIntegrationService(gateway);
  assert.equal((await service.getState()).status, "not_configured");

  gateway.servers = [{ name: "figma", authStatus: "notLoggedIn", toolCount: 0 }];
  assert.equal((await service.getState()).status, "authentication_required");

  gateway.servers = [{ name: "figma", authStatus: "oAuth", toolCount: 7 }];
  assert.deepEqual(await service.getState(), { status: "ready", detail: "接続済み（7ツール利用可能）" });
});

test("Figma integration writes the official MCP endpoint and reloads Codex", async () => {
  const gateway = new FakeMcpGateway();
  const service = new FigmaIntegrationService(gateway);

  await service.configure();

  assert.deepEqual(gateway.writes, [{ name: FIGMA_MCP_SERVER_NAME, url: FIGMA_MCP_SERVER_URL }]);
  assert.equal(gateway.reloads, 1);
  assert.deepEqual(await service.startLogin(), { authorizationUrl: "https://figma.example.test/oauth" });
});
