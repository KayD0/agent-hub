export const FIGMA_MCP_SERVER_NAME = "figma";
export const FIGMA_MCP_SERVER_URL = "https://mcp.figma.com/mcp";

export interface McpServerSummary {
  name: string;
  authStatus: "unsupported" | "notLoggedIn" | "bearerToken" | "oAuth" | "unknown";
  toolCount: number;
}

export interface McpIntegrationGateway {
  listMcpServers(): Promise<McpServerSummary[]>;
  writeMcpServerConfig(name: string, url: string): Promise<void>;
  reloadMcpServers(): Promise<void>;
  startMcpOauthLogin(name: string): Promise<{ authorizationUrl: string }>;
}

export type FigmaIntegrationState =
  | { status: "not_configured"; detail: string }
  | { status: "authentication_required"; detail: string }
  | { status: "ready"; detail: string }
  | { status: "error"; detail: string };

export class FigmaIntegrationService {
  public constructor(private readonly gateway: McpIntegrationGateway) {}

  public async getState(): Promise<FigmaIntegrationState> {
    try {
      const server = (await this.gateway.listMcpServers()).find((candidate) => candidate.name === FIGMA_MCP_SERVER_NAME);
      if (!server) return { status: "not_configured", detail: "Figma MCPはまだ設定されていません" };
      if (server.authStatus === "notLoggedIn") return { status: "authentication_required", detail: "Figmaへのログインが必要です" };
      return {
        status: "ready",
        detail: server.toolCount > 0 ? `接続済み（${server.toolCount}ツール利用可能）` : "接続済み",
      };
    } catch (error) {
      return { status: "error", detail: errorMessage(error) };
    }
  }

  public async configure(): Promise<FigmaIntegrationState> {
    await this.gateway.writeMcpServerConfig(FIGMA_MCP_SERVER_NAME, FIGMA_MCP_SERVER_URL);
    await this.gateway.reloadMcpServers();
    return this.getState();
  }

  public startLogin(): Promise<{ authorizationUrl: string }> {
    return this.gateway.startMcpOauthLogin(FIGMA_MCP_SERVER_NAME);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
