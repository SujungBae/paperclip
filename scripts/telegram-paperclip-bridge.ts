import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

type JsonObject = Record<string, unknown>;

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
};

type TelegramMessage = {
  message_id: number;
  chat?: {
    id: number;
    type?: string;
  };
  from?: {
    id?: number;
    username?: string;
    first_name?: string;
    last_name?: string;
  };
  text?: string;
};

type PaperclipAgent = {
  id: string;
  name: string;
  role: string;
};

type PaperclipIssueSummary = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  updatedAt: string | null;
};

type PaperclipApprovalSummary = {
  id: string;
  type: string;
  status: string;
  requestedByAgentId: string | null;
  createdAt: string | null;
};

const TELEGRAM_API_BASE = "https://api.telegram.org";
const DEFAULT_PAPERCLIP_API_URL = "http://127.0.0.1:3100";
const DEFAULT_OFFSET_FILE = path.resolve(".paperclip-local", "telegram-bridge-offset.json");
const POLL_TIMEOUT_SECONDS = 30;

function env(name: string, fallback = ""): string {
  const value = process.env[name];
  if (typeof value !== "string") return fallback;
  return value.trim();
}

function requireEnv(name: string): string {
  const value = env(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function maybeNumber(value: string): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCommand(text: string): { command: string; body: string } {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return { command: "task", body: trimmed };
  }
  const firstSpace = trimmed.indexOf(" ");
  const rawCommand = firstSpace === -1 ? trimmed.slice(1) : trimmed.slice(1, firstSpace);
  const body = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
  const command = rawCommand.split("@")[0]?.toLowerCase() ?? "";
  return { command, body };
}

function splitTitleAndDescription(body: string): { title: string; description: string | null } {
  const normalized = body.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return {
      title: "Telegram task",
      description: null,
    };
  }
  const [firstLine, ...rest] = normalized.split("\n");
  const title = firstLine.trim().slice(0, 160) || "Telegram task";
  const description = rest.join("\n").trim() || normalized;
  return { title, description };
}

async function readOffset(offsetFile: string): Promise<number | null> {
  try {
    const raw = await fs.readFile(offsetFile, "utf8");
    const parsed = JSON.parse(raw) as { lastUpdateId?: number };
    return Number.isFinite(parsed.lastUpdateId) ? (parsed.lastUpdateId as number) : null;
  } catch {
    return null;
  }
}

async function writeOffset(offsetFile: string, lastUpdateId: number): Promise<void> {
  await fs.mkdir(path.dirname(offsetFile), { recursive: true });
  await fs.writeFile(offsetFile, JSON.stringify({ lastUpdateId }, null, 2));
}

class TelegramPaperclipBridge {
  private readonly telegramToken: string;
  private readonly telegramApiUrl: string;
  private readonly paperclipApiUrl: string;
  private readonly boardApiKey: string | null;
  private readonly companyId: string;
  private readonly ceoAgentId: string | null;
  private readonly allowedChatId: number | null;
  private readonly offsetFile: string;
  private readonly pollIntervalMs: number;
  private offset: number | null = null;

  constructor() {
    this.telegramToken = requireEnv("TELEGRAM_BOT_TOKEN");
    this.telegramApiUrl = `${TELEGRAM_API_BASE}/bot${this.telegramToken}`;
    this.paperclipApiUrl = env("PAPERCLIP_API_URL", DEFAULT_PAPERCLIP_API_URL).replace(/\/+$/, "");
    this.boardApiKey = env("PAPERCLIP_API_KEY") || null;
    this.companyId = requireEnv("PAPERCLIP_COMPANY_ID");
    this.ceoAgentId = env("PAPERCLIP_CEO_AGENT_ID") || null;
    this.allowedChatId = maybeNumber(env("TELEGRAM_ALLOWED_CHAT_ID"));
    this.offsetFile = env("TELEGRAM_BRIDGE_OFFSET_FILE", DEFAULT_OFFSET_FILE);
    this.pollIntervalMs = Math.max(1000, maybeNumber(env("TELEGRAM_BRIDGE_POLL_INTERVAL_MS")) ?? 2000);
  }

  async run(): Promise<void> {
    this.offset = await readOffset(this.offsetFile);
    console.log(
      `[telegram-bridge] listening: company=${this.companyId} ceo=${this.ceoAgentId ?? "auto"} api=${this.paperclipApiUrl}`,
    );

    while (true) {
      try {
        const updates = await this.fetchUpdates();
        for (const update of updates) {
          await this.handleUpdate(update);
          this.offset = update.update_id + 1;
          await writeOffset(this.offsetFile, this.offset);
        }
      } catch (error) {
        console.error(`[telegram-bridge] poll error: ${asErrorMessage(error)}`);
        await this.sleep(3000);
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  async runOnce(): Promise<void> {
    this.offset = await readOffset(this.offsetFile);
    const updates = await this.fetchUpdates();
    for (const update of updates) {
      await this.handleUpdate(update);
      this.offset = update.update_id + 1;
      await writeOffset(this.offsetFile, this.offset);
    }
  }

  private async fetchUpdates(): Promise<TelegramUpdate[]> {
    const body = {
      timeout: POLL_TIMEOUT_SECONDS,
      ...(this.offset !== null ? { offset: this.offset } : {}),
      allowed_updates: ["message"],
    };
    const result = await this.telegramApi("getUpdates", body);
    return Array.isArray(result) ? (result as TelegramUpdate[]) : [];
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    const chatId = message?.chat?.id ?? null;
    const text = message?.text?.trim() ?? "";
    if (!message || !chatId || !text) return;
    if (this.allowedChatId !== null && chatId !== this.allowedChatId) {
      await this.sendMessage(chatId, "This bot is not authorized for this chat.");
      return;
    }

    const { command, body } = parseCommand(text);

    try {
      switch (command) {
        case "start":
        case "help":
          await this.sendMessage(chatId, this.helpText());
          return;
        case "task":
        case "issue":
          await this.handleCreateIssue(chatId, body, message);
          return;
        case "status":
          await this.handleStatus(chatId);
          return;
        case "issues":
          await this.handleIssues(chatId);
          return;
        case "approvals":
          await this.handleApprovals(chatId);
          return;
        case "ping":
          await this.sendMessage(chatId, "Paperclip bridge is alive.");
          return;
        default:
          await this.sendMessage(chatId, this.helpText(`Unknown command: /${command}`));
      }
    } catch (error) {
      await this.sendMessage(chatId, `Failed: ${asErrorMessage(error)}`);
    }
  }

  private async handleCreateIssue(chatId: number, body: string, message: TelegramMessage): Promise<void> {
    if (!body.trim()) {
      await this.sendMessage(chatId, "Usage: /task <title or multi-line task>");
      return;
    }

    const ceo = await this.resolveCeoAgent();
    const { title, description } = splitTitleAndDescription(body);
    const sender = [
      message.from?.first_name,
      message.from?.last_name,
      message.from?.username ? `(@${message.from.username})` : null,
    ].filter(Boolean).join(" ");

    const finalDescription = [
      description,
      "",
      "---",
      "Source: Telegram",
      sender ? `Sender: ${sender}` : null,
      `Chat ID: ${chatId}`,
      `Telegram message ID: ${message.message_id}`,
    ].filter((value): value is string => Boolean(value)).join("\n");

    const issue = await this.paperclipApi(`/api/companies/${this.companyId}/issues`, {
      method: "POST",
      body: JSON.stringify({
        title,
        description: finalDescription,
        status: "todo",
        priority: "medium",
        assigneeAgentId: ceo.id,
      }),
    });

    const identifier = typeof issue.identifier === "string" ? issue.identifier : "(unknown)";
    await this.sendMessage(
      chatId,
      [
        `Created issue ${identifier}`,
        `CEO: ${ceo.name}`,
        `Title: ${title}`,
      ].join("\n"),
    );
  }

  private async handleStatus(chatId: number): Promise<void> {
    const [agents, issues, approvals] = await Promise.all([
      this.listAgents(),
      this.listIssues(),
      this.listPendingApprovals(),
    ]);

    const activeIssues = issues.filter((issue) => issue.status === "in_progress").length;
    const blockedIssues = issues.filter((issue) => issue.status === "blocked").length;
    const todoIssues = issues.filter((issue) => issue.status === "todo").length;
    const recentIssues = this.formatIssueLines(issues, agents, 5);

    await this.sendMessage(
      chatId,
      [
        "Paperclip status",
        `Agents: ${agents.length}`,
        `Issues: ${issues.length} total, ${activeIssues} in progress, ${blockedIssues} blocked, ${todoIssues} todo`,
        `Pending approvals: ${approvals.length}`,
        "",
        "Recent issues:",
        ...(recentIssues.length ? recentIssues : ["- none"]),
      ].join("\n"),
    );
  }

  private async handleIssues(chatId: number): Promise<void> {
    const [agents, issues] = await Promise.all([this.listAgents(), this.listIssues()]);
    const lines = this.formatIssueLines(issues, agents, 10);

    await this.sendMessage(
      chatId,
      [
        "Recent issues",
        ...(lines.length ? lines : ["- none"]),
      ].join("\n"),
    );
  }

  private async handleApprovals(chatId: number): Promise<void> {
    const [agents, approvals] = await Promise.all([this.listAgents(), this.listPendingApprovals()]);
    const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]));
    const lines = approvals
      .sort((a, b) => this.sortByDateDesc(a.createdAt, b.createdAt))
      .slice(0, 10)
      .map((approval) => {
        const requester = approval.requestedByAgentId ? agentNames.get(approval.requestedByAgentId) ?? "unknown" : "board";
        return `- ${approval.type} [${approval.status}] by ${requester} (${approval.id.slice(0, 8)})`;
      });

    await this.sendMessage(
      chatId,
      [
        "Pending approvals",
        ...(lines.length ? lines : ["- none"]),
      ].join("\n"),
    );
  }

  private async resolveCeoAgent(): Promise<PaperclipAgent> {
    if (this.ceoAgentId) {
      const agent = await this.paperclipApi(`/api/agents/${this.ceoAgentId}`);
      return {
        id: String(agent.id),
        name: String(agent.name ?? agent.id),
        role: String(agent.role ?? ""),
      };
    }

    const agents = await this.paperclipApi(`/api/companies/${this.companyId}/agents`);
    if (!Array.isArray(agents)) {
      throw new Error("Unexpected agents response");
    }

    const ceo = agents.find((agent) => {
      if (!agent || typeof agent !== "object") return false;
      const record = agent as JsonObject;
      return record.role === "ceo" && record.status !== "terminated";
    });

    if (!ceo) {
      throw new Error("No CEO agent found for this company. Set PAPERCLIP_CEO_AGENT_ID explicitly.");
    }

    return {
      id: String((ceo as JsonObject).id),
      name: String((ceo as JsonObject).name ?? (ceo as JsonObject).id),
      role: "ceo",
    };
  }

  private async listAgents(): Promise<PaperclipAgent[]> {
    const agents = await this.paperclipApi(`/api/companies/${this.companyId}/agents`);
    if (!Array.isArray(agents)) {
      throw new Error("Unexpected agents response");
    }

    return agents
      .filter((agent): agent is JsonObject => Boolean(agent) && typeof agent === "object")
      .map((agent) => ({
        id: String(agent.id),
        name: String(agent.name ?? agent.id),
        role: String(agent.role ?? ""),
      }));
  }

  private async listIssues(): Promise<PaperclipIssueSummary[]> {
    const issues = await this.paperclipApi(`/api/companies/${this.companyId}/issues`);
    if (!Array.isArray(issues)) {
      throw new Error("Unexpected issues response");
    }

    return issues
      .filter((issue): issue is JsonObject => Boolean(issue) && typeof issue === "object")
      .map((issue) => ({
        id: String(issue.id),
        identifier: typeof issue.identifier === "string" ? issue.identifier : null,
        title: String(issue.title ?? "(untitled)"),
        status: String(issue.status ?? "unknown"),
        priority: String(issue.priority ?? "unknown"),
        assigneeAgentId: typeof issue.assigneeAgentId === "string" ? issue.assigneeAgentId : null,
        updatedAt: typeof issue.updatedAt === "string" ? issue.updatedAt : null,
      }));
  }

  private async listPendingApprovals(): Promise<PaperclipApprovalSummary[]> {
    const approvals = await this.paperclipApi(`/api/companies/${this.companyId}/approvals?status=pending`);
    if (!Array.isArray(approvals)) {
      throw new Error("Unexpected approvals response");
    }

    return approvals
      .filter((approval): approval is JsonObject => Boolean(approval) && typeof approval === "object")
      .map((approval) => ({
        id: String(approval.id),
        type: String(approval.type ?? "unknown"),
        status: String(approval.status ?? "unknown"),
        requestedByAgentId: typeof approval.requestedByAgentId === "string" ? approval.requestedByAgentId : null,
        createdAt: typeof approval.createdAt === "string" ? approval.createdAt : null,
      }));
  }

  private formatIssueLines(
    issues: PaperclipIssueSummary[],
    agents: PaperclipAgent[],
    limit: number,
  ): string[] {
    const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]));
    return issues
      .sort((a, b) => this.sortByDateDesc(a.updatedAt, b.updatedAt))
      .slice(0, limit)
      .map((issue) => {
        const assignee = issue.assigneeAgentId ? agentNames.get(issue.assigneeAgentId) ?? "unknown" : "unassigned";
        const identifier = issue.identifier ?? issue.id.slice(0, 8);
        return `- ${identifier} [${issue.status}] ${issue.title} -> ${assignee}`;
      });
  }

  private sortByDateDesc(a: string | null, b: string | null): number {
    const left = a ? Date.parse(a) : 0;
    const right = b ? Date.parse(b) : 0;
    return right - left;
  }

  private async telegramApi(method: string, body: JsonObject): Promise<unknown> {
    const response = await fetch(`${this.telegramApiUrl}/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const payload = await response.json() as { ok?: boolean; result?: unknown; description?: string };
    if (!response.ok || payload.ok !== true) {
      throw new Error(payload.description ?? `Telegram API ${method} failed (${response.status})`);
    }
    return payload.result;
  }

  private async sendMessage(chatId: number, text: string): Promise<void> {
    await this.telegramApi("sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    });
  }

  private async paperclipApi(endpoint: string, init?: RequestInit): Promise<any> {
    const headers = new Headers(init?.headers ?? {});
    headers.set("content-type", "application/json");
    if (this.boardApiKey) {
      headers.set("authorization", `Bearer ${this.boardApiKey}`);
    }

    const response = await fetch(`${this.paperclipApiUrl}${endpoint}`, {
      ...init,
      headers,
    });

    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const errorMessage =
        payload && typeof payload === "object" && payload !== null && "error" in payload
          ? String((payload as JsonObject).error)
          : `Paperclip API failed (${response.status})`;
      throw new Error(errorMessage);
    }
    return payload;
  }

  private helpText(prefix?: string): string {
    return [
      ...(prefix ? [prefix, ""] : []),
      "Commands:",
      "/task <title or multi-line task>",
      "/issue <title or multi-line task>",
      "/status",
      "/issues",
      "/approvals",
      "/ping",
      "/help",
    ].join("\n");
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

async function main() {
  const command = process.argv[2]?.trim().toLowerCase() ?? "run";
  if (command === "once") {
    const bridge = new TelegramPaperclipBridge();
    await bridge.runOnce();
    return;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    console.log([
      "Usage:",
      "  tsx scripts/telegram-paperclip-bridge.ts run",
      "  tsx scripts/telegram-paperclip-bridge.ts once",
      "",
      "Required env:",
      "  TELEGRAM_BOT_TOKEN",
      "  PAPERCLIP_COMPANY_ID",
      "",
      "Optional env:",
      "  PAPERCLIP_API_URL=http://127.0.0.1:3100",
      "  PAPERCLIP_API_KEY=<board bearer token when auth is enabled>",
      "  PAPERCLIP_CEO_AGENT_ID=<explicit CEO agent id>",
      "  TELEGRAM_ALLOWED_CHAT_ID=<single authorized chat id>",
      `  TELEGRAM_BRIDGE_OFFSET_FILE=${DEFAULT_OFFSET_FILE}`,
      "",
      "Telegram commands:",
      "  /task <text>",
      "  /status",
      "  /issues",
      "  /approvals",
    ].join("\n"));
    return;
  }
  const bridge = new TelegramPaperclipBridge();
  await bridge.run();
}

main().catch((error) => {
  console.error(`[telegram-bridge] fatal: ${asErrorMessage(error)}`);
  process.exitCode = 1;
});
