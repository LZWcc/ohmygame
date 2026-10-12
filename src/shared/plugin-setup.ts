import type { AgentModelRef, AgentReasoningLevel, Turn } from "./contracts.js";
import type { PluginDetail, PluginMcpResult } from "./plugins.js";
export interface PluginSetupMessage {
  role: "user" | "assistant";
  text: string;
}
export interface PluginSetupSummary {
  id: string;
  pluginId?: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  status: "idle" | "working" | "ready" | "installed" | "interrupted" | "error";
  model?: AgentModelRef;
  reasoningLevel?: AgentReasoningLevel;
}
export interface PluginSetupState extends PluginSetupSummary {
  messages: PluginSetupMessage[];
  turns: Turn[];
  busy: boolean;
  activity?: string;
  error?: string;
}
export interface PluginSetupPrompt {
  prompt: string;
  model: AgentModelRef;
  reasoningLevel?: AgentReasoningLevel;
}

export interface PluginDraft {
  path?: string;
  revision?: string;
  installedRevision?: string;
  plugin?: PluginDetail;
  files: Array<{ path: string; size: number }>;
  errors: string[];
  checks?: Record<string, { revision: string; result: PluginMcpResult }>;
}
