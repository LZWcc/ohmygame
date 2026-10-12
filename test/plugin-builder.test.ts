import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginSetupManager, registerPluginSetupRoutes } from "../src/daemon/plugin-setup.js";
import { PluginCapabilities } from "../src/daemon/plugin-capabilities.js";
import { LocalPluginStore } from "../src/daemon/local-plugins.js";
import { LocalPluginAdapter, PluginCatalogService } from "../src/daemon/plugin-catalog.js";
import { PluginSettingsStore } from "../src/daemon/plugin-settings.js";
import { readPluginBuilderInput, savePluginBuilderInput } from "../src/renderer/plugin-builder-drafts.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function environment() {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-builder-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const agentDir = path.join(directory, "pi-agent");
  await mkdir(agentDir);
  const settings = new PluginSettingsStore(directory);
  await settings.load();
  const local = new LocalPluginStore(directory);
  const capabilities = new PluginCapabilities(directory, agentDir, [local], local, settings);
  await capabilities.configuration.load();
  cleanup.push(() => capabilities.host.close());
  const catalog = new PluginCatalogService([new LocalPluginAdapter(local)], settings);
  const invalidate = vi.fn();
  function manager() { return new PluginSetupManager(directory, agentDir, capabilities, catalog, local, invalidate, async () => { throw new Error("No test model"); }); }
  const setup = manager();
  const app = Fastify();
  registerPluginSetupRoutes(app, setup);
  cleanup.push(() => app.close());
  return { directory, agentDir, settings, local, capabilities, setup, manager, app, invalidate };
}
async function writeDraft(directory: string, sessionId: string, mcp = false) {
  const root = path.join(directory, "plugin-setup", sessionId, "workspace", "design-review");
  await mkdir(path.join(root, ".ohmygame-plugin"), { recursive: true });
  await mkdir(path.join(root, "skills/review"), { recursive: true });
  await writeFile(path.join(root, ".ohmygame-plugin/plugin.json"), JSON.stringify({
    name: "design-review", version: "0.1.0", description: "Review game design documents", skills: "./skills/",
    interface: { displayName: "Design Review", defaultPrompt: ["Review my game design"] },
    ...(mcp ? { mcpServers: "./mcp.json", configuration: { key: { type: "secret", label: "API key", required: true } } } : {}),
  }));
  await writeFile(path.join(root, "skills/review/SKILL.md"), "---\nname: review\ndescription: Review a game design document.\n---\n\n# Review\n\nRead the document and prioritize improvements.");
  if (mcp) await writeFile(path.join(root, "mcp.json"), JSON.stringify({ mcpServers: { api: {
    command: process.execPath, args: [path.resolve("test/fixtures/plugin-mcp-server.mjs")], env: { API_KEY: "${config.key}" },
  } } }));
  return root;
}

describe("Plugin Builder", () => {
  it("keeps new workspaces separate, lists them after restart, and retains interrupted status", async () => {
    const { setup, directory, manager } = await environment();
    const first = await setup.create(), second = await setup.create();
    expect(second.id).not.toBe(first.id);
    await setup.close();
    const file = path.join(directory, "plugin-setup", first.id, "state.json");
    const stored = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...stored, status: "working", busy: true, model: { provider: "fixture", id: "model" } }));
    const resumed = manager(); cleanup.push(() => resumed.close());
    const listed = await resumed.list();
    expect(listed).toHaveLength(2);
    expect(listed.find(item => item.id === first.id)).toMatchObject({ status: "interrupted", model: { provider: "fixture", id: "model" } });
    expect((await resumed.read(first.id)).busy).toBe(false);
  });

  it("previews and validates an uninstalled draft, rejects a stale revision, and installs the reviewed version", async () => {
    const { setup, directory, local, app, invalidate } = await environment();
    const state = await setup.create();
    const root = await writeDraft(directory, state.id);
    const draft = await setup.prepare(state.id, root);
    expect(draft).toMatchObject({ plugin: { installed: false, displayName: "Design Review" }, errors: [] });
    expect((await local.list()).plugins).toEqual([]);
    expect((await setup.file(state.id, "skills/review/SKILL.md")).content).toContain("prioritize improvements");
    await writeFile(path.join(root, "skills/review/SKILL.md"), "---\nname: review\ndescription: Review game documents.\n---\n\nUpdated instructions.");
    const stale = await app.inject({ method: "POST", url: `/plugins/setup-sessions/${state.id}/install`, payload: { revision: draft.revision } });
    expect(stale.statusCode).toBe(409);
    const updated = await setup.draft(state.id);
    expect(updated.revision).not.toBe(draft.revision);
    const installed = await app.inject({ method: "POST", url: `/plugins/setup-sessions/${state.id}/install`, payload: { revision: updated.revision } });
    expect(installed.statusCode, installed.body).toBe(200);
    expect(installed.json()).toMatchObject({ status: "installed", pluginId: "personal:design-review" });
    expect(invalidate).toHaveBeenCalledOnce();
    expect((await setup.draft(state.id)).installedRevision).toBe(updated.revision);
    expect((await local.list()).plugins).toHaveLength(1);
    await writeFile(path.join(root, ".ohmygame-plugin/plugin.json"), "{}");
    expect((await setup.draft(state.id)).errors).not.toEqual([]);
    await expect(setup.installDraft(state.id, updated.revision!)).rejects.toThrow("manifest");
    expect((await local.list()).plugins).toHaveLength(1);
  });

  it("keeps preview paths inside the workspace, including symbolic links", async () => {
    const { setup, directory } = await environment();
    const state = await setup.create();
    const root = await writeDraft(directory, state.id);
    await setup.prepare(state.id, root);
    await writeFile(path.join(directory, "private.txt"), "outside the builder");
    await expect(setup.file(state.id, "../../../../private.txt")).rejects.toThrow("inside");
    await symlink(path.join(directory, "private.txt"), path.join(root, "outside.txt"));
    await expect(setup.file(state.id, "outside.txt")).rejects.toThrow("inside");
    expect((await setup.draft(state.id)).errors.join(" ")).toContain("symbolic links");
  });

  it("configures and probes a draft without installing it or exposing credentials, and invalidates checks after configuration changes", async () => {
    const { setup, directory, local, app } = await environment();
    const state = await setup.create();
    const root = await writeDraft(directory, state.id, true);
    const draft = await setup.prepare(state.id, root);
    expect((await setup.configuration(state.id)).missing).toEqual(["key"]);
    const saved = await app.inject({ method: "PUT", url: `/plugins/setup-sessions/${state.id}/configuration`, payload: { values: { key: "private-test-key" } } });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.body).not.toContain("private-test-key");
    const other = await setup.create();
    await setup.prepare(other.id, await writeDraft(directory, other.id, true));
    expect((await setup.configuration(other.id)).missing).toEqual(["key"]);
    const tested = await app.inject({ method: "POST", url: `/plugins/setup-sessions/${state.id}/test/api`, payload: { revision: draft.revision } });
    expect(tested.statusCode, tested.body).toBe(200);
    expect(tested.json()).toMatchObject({ status: "connected", toolCount: 1 });
    expect((await setup.draft(state.id)).checks?.api).toMatchObject({ revision: draft.revision, result: { status: "connected" } });
    expect((await local.list()).plugins).toHaveLength(0);
    const metadata = await readFile(path.join(directory, "plugin-setup", state.id, "state.json"), "utf8");
    expect(metadata).not.toContain("private-test-key");
    expect(await readFile(path.join(root, "mcp.json"), "utf8")).not.toContain("private-test-key");
    await setup.configuration(state.id, { key: "replacement-key" });
    expect((await setup.draft(state.id)).checks).toEqual({});
    await setup.installDraft(state.id, draft.revision!);
    expect((await setup.configuration(state.id)).configuredSecrets).toEqual(["key"]);
  });

  it("restores unsent input and model selection by workspace, including after malformed storage", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const input = { prompt: "未发送的请求", model: { provider: "fixture", id: "model" }, reasoningLevel: "high" as const };
    savePluginBuilderInput("one", input, storage);
    expect(readPluginBuilderInput("one", storage)).toEqual(input);
    expect(readPluginBuilderInput("two", storage)).toEqual({ prompt: "" });
    expect(readPluginBuilderInput("one", { getItem: () => "invalid JSON" })).toEqual({ prompt: "" });
  });
});
