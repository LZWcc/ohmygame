import { useEffect, useRef, useState } from "react";
import type { PluginDraft, PluginSetupState, PluginSetupSummary } from "../shared/plugin-setup.js";
import type { PluginDetail } from "../shared/plugins.js";
import { pluginComponentKey } from "../shared/plugins.js";
import { preferredAgentModel } from "../shared/agent-models.js";
import { clampReasoningLevel } from "../shared/reasoning.js";
import { abortPluginSetup, installPluginDraft, listPluginSetups, promptPluginSetup, readPluginDraft,
  readPluginDraftFile, readPluginSetup, readPlugin, readPluginSkill, testPluginDraft, updatePluginSettings, waitForRuntime } from "./api.js";
import { AgentTimeline } from "./agent-timeline.js";
import { useAgentModels } from "./model-selector.js";
import { PromptBox } from "./prompt-box.js";
import { PluginConfigurationPanel, PluginMcpPanel } from "./plugin-controls.js";
import { WorkspaceFileBrowser } from "./coding-workspace.js";
import { HighlightedCode } from "./highlighted-code.js";
import { MarkdownContent } from "./markdown-content.js";
import { WorkspaceTabs, type WorkspaceTabOption } from "./workspace-tabs.js";
import { WorkspaceShell, WorkspaceAgentPane, WorkspaceBackButton } from "./workspace-shell.js";
import { ComposerActions } from "./composer-actions.js";
import { readChatLayout } from "./chat-layout.js";
import { pluginBuilderHash, pluginHash, settingsHash } from "./routes.js";
import { useReadyRuntimeGeneration } from "./runtime-connection.js";
import { readPluginBuilderInput, savePluginBuilderInput } from "./plugin-builder-drafts.js";
import { openPluginBuilder } from "./plugin-builder-navigation.js";
import { ArrowLeft, Check, ChevronRight, FileCode2, FileText, Folder, LoaderCircle, Package, MessageSquarePlus, PanelToggle,
  Plug, RefreshCw, Settings, WandSparkles } from "./icons.js";
import "./plugin-builder.css";

export function PluginBuilderSessions() {
  const generation = useReadyRuntimeGeneration();
  const [sessions, setSessions] = useState<PluginSetupSummary[]>([]);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    void waitForRuntime().then(listPluginSetups).then(items => { if (active) setSessions(items); })
      .catch(cause => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [generation]);
  if (error) return <p className="plugins-inline-error" role="alert">Could not load builder workspaces. {error}</p>;
  if (!sessions.length) return null;
  return <section className="plugin-builder-recents" aria-label="Plugin workspaces">
    <h2>Continue building</h2>
    <div>{sessions.map(session => <a href={pluginBuilderHash(session.id)} key={session.id}>
      <Package size={18} /><span><strong>{session.title}</strong><small>{statusLabel(session.status)}</small></span><ChevronRight size={14} />
    </a>)}</div>
  </section>;
}

type BuilderView = "overview" | "files" | "configuration" | "checks";
const TABS: WorkspaceTabOption<BuilderView>[] = [
  { id: "overview", label: "Overview", icon: Package }, { id: "files", label: "Files", icon: FileCode2 },
  { id: "configuration", label: "Setup", icon: Settings }, { id: "checks", label: "Checks", icon: Check },
];

export function PluginBuilder({ sessionId }: { sessionId: string }) {
  const generation = useReadyRuntimeGeneration();
  const catalog = useAgentModels();
  const [state, setState] = useState<PluginSetupState>();
  const [draft, setDraft] = useState<PluginDraft>();
  const [installed, setInstalled] = useState<PluginDetail>();
  const [input, setInput] = useState(() => readPluginBuilderInput(sessionId, typeof window === "undefined" ? undefined : window.localStorage));
  const [view, setView] = useState<BuilderView>("overview");
  const [error, setError] = useState<string>();
  const [operation, setOperation] = useState<string>();
  const [retry, setRetry] = useState(0);
  const [fileRequest, updateFileRequest] = useState<{ path: string; id: number }>();
  const [chatLayout] = useState(readChatLayout);
  const [agentCollapsed, setAgentCollapsed] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const timeline = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const draftPlugin = draft?.plugin;
  const plugin = draftPlugin ?? installed;
  const model = preferredAgentModel(catalog.models, input.model ?? state?.model, catalog.defaultModel);
  const reasoning = model ? clampReasoningLevel(input.reasoningLevel ?? state?.reasoningLevel ?? catalog.defaultReasoningLevel, model.reasoningLevels) : undefined;
  const disabled = Boolean(state?.busy || operation);
  const upToDate = Boolean(draft?.revision && draft.revision === draft.installedRevision);

  useEffect(() => { savePluginBuilderInput(sessionId, input, window.localStorage); }, [sessionId, input]);
  useEffect(() => {
    if (!state || !model || input.model) return;
    setInput(current => ({ ...current, model: { provider: model.provider, id: model.id }, reasoningLevel: reasoning }));
  }, [state?.id, model?.provider, model?.id]);
  useEffect(() => {
    let active = true;
    setError(undefined);
    void (async () => {
      await waitForRuntime();
      const next = await readPluginSetup(sessionId);
      const preview = await readPluginDraft(sessionId);
      const currentPlugin = next.pluginId ? await readPlugin(next.pluginId) : undefined;
      if (active) { setState(next); setDraft(preview); setInstalled(currentPlugin); }
    })().catch(cause => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [sessionId, generation, retry]);
  useEffect(() => {
    if (!state?.busy) return;
    let active = true, inFlight = false;
    const timer = window.setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void readPluginSetup(sessionId).then(async next => {
        if (!active) return;
        if (!next.busy) {
          const preview = await readPluginDraft(sessionId);
          const currentPlugin = next.pluginId ? await readPlugin(next.pluginId) : undefined;
          if (active) { setState(next); setDraft(preview); setInstalled(currentPlugin); setError(undefined); }
        } else { setState(next); setError(undefined); }
      }).catch(cause => { if (active) setError(message(cause)); }).finally(() => { inFlight = false; });
    }, 700);
    return () => { active = false; window.clearInterval(timer); };
  }, [sessionId, state?.busy]);
  useEffect(() => {
    if (state?.turns.length && following.current && timeline.current) timeline.current.scrollTop = timeline.current.scrollHeight;
  }, [state?.turns, state?.activity]);

  async function action(name: string, run: () => Promise<void>) {
    if (disabled) return;
    setOperation(name); setError(undefined);
    try { await run(); } catch (cause) { setError(message(cause)); }
    finally { setOperation(undefined); }
  }
  async function refresh() {
    const [next, preview] = await Promise.all([readPluginSetup(sessionId), readPluginDraft(sessionId)]);
    setState(next); setDraft(preview);
    if (next.pluginId) setInstalled(await readPlugin(next.pluginId));
  }
  async function send() {
    if (!state || !model || !input.prompt.trim() || disabled) return;
    const sent = input.prompt;
    await action("sending", async () => {
      const next = await promptPluginSetup(sessionId, sent, { provider: model.provider, id: model.id }, reasoning);
      setInput(current => current.prompt === sent ? { ...current, prompt: "" } : current);
      following.current = true;
      setState(next);
      if (!next.busy) await refresh();
    });
  }
  function prefill(prompt: string) {
    setAgentCollapsed(false);
    setInput(current => ({ ...current, prompt: current.prompt.trim() ? `${current.prompt.trimEnd()}\n\n${prompt}` : prompt }));
    requestAnimationFrame(() => textarea.current?.focus());
  }

  const goToPlugins = () => { window.location.hash = settingsHash("plugins"); };
  return <WorkspaceShell className="plugin-builder-shell" chatLayout={chatLayout} agentCollapsed={agentCollapsed}
    onHome={goToPlugins} homeLabel="Back to plugins" homeIcon={ArrowLeft} onExpandAgent={() => setAgentCollapsed(false)}
    agent={<WorkspaceAgentPane label="Plugin assistant"
      actions={<>
        <button className="icon-button pane-header-action" type="button" disabled={disabled} title="New plugin" aria-label="New plugin"
          onClick={() => void action("creating", () => openPluginBuilder())}>
          {operation === "creating" ? <LoaderCircle className="spin" size={14} /> : <MessageSquarePlus size={14} />}
        </button>
        <button className="icon-button pane-header-action" type="button" onClick={() => setAgentCollapsed(true)} title="Hide agent" aria-label="Hide agent"><PanelToggle size={14} /></button>
      </>}
      bodyRef={timeline} onScroll={event => {
        const element = event.currentTarget;
        following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      }}>
        <div className="timeline" aria-live="polite">
          {!state && !error ? <p className="plugin-builder-working" role="status"><LoaderCircle className="spin" size={13} />Opening your workspace…</p> : null}
          {state ? <AgentTimeline turns={state.turns} onAddToChat={prefill} onOpenWorkspaceFile={file => { setView("files"); setFileRequest(file); }} /> : null}
          {state?.busy && !state.turns.some(turn => turn.items.some(item => item.type === "agentMessage" && item.status === "inProgress")) ? <p className="plugin-builder-working" role="status"><LoaderCircle className="spin" size={13} />{activityLabel(state.activity)}</p> : null}
          {state?.status === "interrupted" ? <p className="plugin-builder-notice" role="status">This run was interrupted. Your conversation and files are saved; send a message to continue.</p> : null}
        </div>
        <div className="composer">
          {error || state?.error ? <p className="plugin-builder-error" role="alert">{error ?? state?.error}{!state ? <button type="button" onClick={() => setRetry(value => value + 1)}>Retry</button> : null}</p> : null}
          <PromptBox value={input.prompt} onChange={prompt => setInput(current => ({ ...current, prompt }))} onSubmit={() => void send()}
            textareaRef={textarea} variant="project" disabled={!state} placeholder="Describe what your plugin should do…"
            actions={<ComposerActions models={catalog.models} status={catalog.status} value={model} reasoningLevel={reasoning} disabled={disabled}
              onChange={(selected, level) => setInput(current => ({ ...current, model: { provider: selected.provider, id: selected.id }, reasoningLevel: level }))}
              onReasoningChange={level => setInput(current => ({ ...current, reasoningLevel: level }))}
              showStop={Boolean(state?.busy)} sendLabel="Send plugin request" stopLabel="Stop assistant"
              sendDisabled={!state || !model || !input.prompt.trim() || disabled}
              onStop={() => { void abortPluginSetup(sessionId).catch(cause => setError(message(cause))); }}
            />} />
        </div>
    </WorkspaceAgentPane>}
  >
      <section className="viewer-pane plugin-builder-preview" aria-label="Plugin preview" data-active-tab={view === "files" ? "code" : view}>
        <header className="pane-header viewer-header window-drag-handle">
          <span className="workspace-navigation-drag-exclusion" aria-hidden="true" />
          <div className={`viewer-navigation${chatLayout === "right" ? " is-chat-right" : ""}`}>
            {chatLayout === "right" ? <>
              <WorkspaceBackButton onClick={goToPlugins} label="Back to plugins" icon={ArrowLeft} />
              {agentCollapsed ? <button className="icon-button pane-header-action" type="button" title="Show agent" aria-label="Show agent" onClick={() => setAgentCollapsed(false)}><PanelToggle size={14} /></button> : null}
            </> : null}
            <WorkspaceTabs tabs={TABS} active={view} onChange={setView} label="Plugin views" />
          </div>
          <div className="viewer-publish">
            <button className="icon-button pane-header-action" aria-label="Refresh plugin preview" title="Refresh plugin preview" type="button" disabled={disabled} onClick={() => void action("refreshing", refresh)}><RefreshCw size={14} /></button>
            {state?.pluginId ? <button className="icon-button pane-header-action" type="button" title="Open plugin" aria-label="Open plugin" onClick={() => { window.location.hash = pluginHash(state.pluginId!); }}><ChevronRight size={14} /></button> : null}
            {draftPlugin ? <button className="publish-button workspace-publish-button" type="button" disabled={disabled || Boolean(draft?.errors.length) || upToDate} onClick={() => void action("installing", async () => {
              if (!draft?.revision) return;
              setState(await installPluginDraft(sessionId, draft.revision)); await refresh();
            })}>{operation === "installing" ? <LoaderCircle className="spin" size={14} /> : upToDate ? <Check size={14} /> : <Package size={14} />}<span>{upToDate ? "Installed" : state?.pluginId ? "Update plugin" : "Install plugin"}</span></button> : null}
          </div>
        </header>
        <div className={`plugin-builder-preview-content is-${view}`}>
          {view === "overview" && draft?.errors.length ? <p className="plugin-builder-error" role="alert">The draft needs changes: {draft.errors.join(" ")}</p> : null}
          {view === "overview" ? plugin ? <PluginOverview plugin={plugin} installed={upToDate || Boolean(installed && !draftPlugin)} onChooseView={setView} onChooseFile={file => { setView("files"); setFileRequest(file); }} onTry={prefill} /> : <EmptyView icon={Package} title="Plugin preview" text="Your plugin's skills, tools, and setup appear here when a draft is ready." /> : null}
          {view === "files" ? <PluginFiles sessionId={sessionId} draft={draft} installed={installed} request={fileRequest} /> : null}
          {view === "configuration" ? plugin ? <>
            <div className="plugin-builder-section-title"><h2>Configuration</h2><p>Enter service credentials here. They are stored separately from the plugin and conversation.</p></div>
            <fieldset className="plugin-builder-config" disabled={disabled}>
              <PluginConfigurationPanel key={`${sessionId}:${draft?.revision ?? plugin.id}`} plugin={plugin} setupId={draftPlugin ? sessionId : undefined} onChanged={() => void refresh().catch(cause => setError(message(cause)))} />
            </fieldset>
            {!Object.keys(plugin.configuration ?? {}).length ? <p className="plugin-builder-notice">This plugin has no configuration fields.</p> : null}
            {!draftPlugin && installed ? <PluginMcpPanel plugin={installed} onChanged={() => void refresh().catch(cause => setError(message(cause)))} onAssist={() => { setView("overview"); prefill("Inspect this plugin's configuration and diagnose any connection problems. Report what needs to be changed before making changes."); }} onToggle={(id, enabled) => void action("configuring", async () => {
              const components = Object.fromEntries([
                ...installed.skills.map(skill => [pluginComponentKey("skill", skill.id), skill.enabled]),
                ...(installed.mcpServers ?? []).map(server => [pluginComponentKey("mcp", server.id), server.enabled]),
              ]);
              await updatePluginSettings(installed.id, { enabled: installed.enabled, components: { ...components, [pluginComponentKey("mcp", id)]: enabled } });
              await refresh();
            })} /> : null}
            {draftPlugin?.mcpServers?.some(server => server.transport === "http") ? <p className="plugin-builder-notice">If a service needs browser authorization, install the plugin and authorize it from its plugin page.</p> : null}
          </> : <EmptyView icon={Settings} title="No configuration yet" text="Fields appear when the plugin draft is ready." /> : null}
          {view === "checks" ? !draft?.path && installed ? <div className="plugin-builder-section-title"><h2>Check your plugin</h2><p>Test connected services and manage authorization in Configuration. Try a workflow from the plugin page in a project.</p><button type="button" className="plugin-detail-secondary" onClick={() => setView("configuration")}>Check connections<ChevronRight size={14} /></button></div> : <PluginChecks draft={draft} disabled={disabled} operation={operation} onConfigure={() => setView("configuration")} onTest={server => void action(`test:${server}`, async () => {
            if (!draft?.revision) return;
            await testPluginDraft(sessionId, server, draft.revision); await refresh();
          })} /> : null}
        </div>
      </section>
  </WorkspaceShell>;
  // File selections from the chat share the same preview as the file browser.
  function setFileRequest(file: string) { updateFileRequest({ path: file, id: Date.now() }); }
}

function PluginOverview({ plugin, installed, onChooseView, onChooseFile, onTry }: {
  plugin: PluginDetail; installed: boolean; onChooseView: (view: BuilderView) => void; onChooseFile: (file: string) => void; onTry: (prompt: string) => void;
}) {
  return <div className="plugin-builder-overview">
    <div className="plugin-builder-overview-heading"><div className="plugin-builder-icon"><Package size={26} /></div><span>{installed ? "INSTALLED PLUGIN" : "PLUGIN DRAFT"}</span><h2>{plugin.displayName}</h2><p>{plugin.description}</p><small>Version {plugin.version ?? "unversioned"}</small></div>
    {installed ? <div className="plugin-builder-result" role="status"><Check size={16} /><span>Installed in your studio. Open the plugin page to try it in a project.</span><a href={pluginHash(plugin.id)}>Open plugin<ChevronRight size={14} /></a></div> : null}
    {plugin.longDescription ? <div className="plugin-builder-description"><MarkdownContent text={plugin.longDescription} /></div> : null}
    <section><div className="plugin-builder-section-heading"><h3>Skills</h3><span>{plugin.skills.length}</span></div>{plugin.skills.length ? plugin.skills.map(skill => <button className="plugin-builder-component" type="button" key={skill.id} onClick={() => onChooseFile(skill.id)}><FileText size={17} /><span><strong>{skill.name}</strong><small>{skill.description ?? "Workflow instructions"}</small></span><ChevronRight size={14} /></button>) : <p className="plugin-builder-muted">No Skills in this plugin.</p>}</section>
    <section><div className="plugin-builder-section-heading"><h3>MCP services</h3><span>{plugin.mcpServers?.length ?? 0}</span></div>{plugin.mcpServers?.length ? plugin.mcpServers.map(server => <button className="plugin-builder-component" type="button" key={server.id} onClick={() => onChooseView("checks")}><Plug size={17} /><span><strong>{server.name}</strong><small>{server.transport === "stdio" ? "Local command" : "HTTP service"}</small></span><ChevronRight size={14} /></button>) : <p className="plugin-builder-muted">No connected services required.</p>}</section>
    {Object.keys(plugin.configuration ?? {}).length ? <section><div className="plugin-builder-section-heading"><h3>Configuration</h3><button type="button" onClick={() => onChooseView("configuration")}>Configure<ChevronRight size={13} /></button></div><div className="plugin-builder-fields">{Object.entries(plugin.configuration ?? {}).map(([id, field]) => <span key={id}>{field.label}<small>{field.type === "secret" ? "Credential" : field.type}{field.required ? " · Required" : " · Optional"}</small></span>)}</div></section> : null}
    {plugin.defaultPrompts?.length ? <section><div className="plugin-builder-section-heading"><h3>Example requests</h3></div>{plugin.defaultPrompts.map(prompt => <div className="plugin-builder-example" key={prompt}><p>{prompt}</p><button type="button" onClick={() => onTry(`Refine the plugin so it handles this example well:\n${prompt}`)}>Refine this example<ChevronRight size={13} /></button></div>)}</section> : null}
  </div>;
}

function PluginFiles({ sessionId, draft, installed, request }: { sessionId: string; draft?: PluginDraft; installed?: PluginDetail; request?: { path: string; id: number } }) {
  const [selected, setSelected] = useState<string>();
  const [file, setFile] = useState<{ path: string; content: string }>();
  const [error, setError] = useState<string>();
  const [source, setSource] = useState(false);
  const files = draft?.path ? draft.files : installed?.skills.map(skill => ({ path: skill.id, size: 0 })) ?? [];
  const active = files.some(file => file.path === selected) ? selected : files.find(file => file.path.endsWith("SKILL.md"))?.path ?? files[0]?.path;
  useEffect(() => {
    if (!request) return;
    const match = files.find(file => request.path.endsWith(file.path));
    if (match) setSelected(match.path);
  }, [request?.id, draft?.revision]);
  useEffect(() => {
    if (!active) return;
    let current = true;
    setFile(undefined); setError(undefined);
    void (draft?.path ? readPluginDraftFile(sessionId, active) : installed ? readPluginSkill(installed.id, active).then(file => ({ path: active, content: file.content })) : Promise.reject(new Error("No plugin file selected"))).then(next => { if (current) setFile(next); })
      .catch(cause => { if (current) setError(message(cause)); });
    return () => { current = false; };
  }, [sessionId, active, draft?.revision, installed?.id]);
  if (!files.length) return <EmptyView icon={Folder} title="No draft files yet" text="The plugin's manifest, Skills, and supporting files appear here after the agent prepares a draft." />;
  return <WorkspaceFileBrowser files={files} selectedPath={active} onSelect={setSelected} loading={!file && !error} error={error}
    selectedFile={file ? { ...file, size: files.find(entry => entry.path === file.path)?.size ?? 0, binary: false } : undefined}
    fileActions={active?.endsWith(".md") ? <div className="file-open-actions"><button type="button" title={source ? "Read document" : "View source"} aria-label={source ? "Read document" : "View source"} onClick={() => setSource(value => !value)}>{source ? <FileText size={14} /> : <FileCode2 size={14} />}</button></div> : null}
    renderFile={file => file.path.endsWith(".md") && !source
      ? <div className="plugin-builder-file-markdown"><MarkdownContent text={(file.content ?? "").replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")} /></div>
      : <HighlightedCode path={file.path} content={file.content ?? ""} />}
  />;
}

function PluginChecks({ draft, disabled, operation, onConfigure, onTest }: {
  draft?: PluginDraft; disabled: boolean; operation?: string; onConfigure: () => void; onTest: (server: string) => void;
}) {
  if (!draft?.path) return <EmptyView icon={Check} title="Checks start with a draft" text="Once the plugin is prepared, check its package and test any connected services." />;
  return <div className="plugin-builder-checks">
    <div className="plugin-builder-section-title"><h2>Check your plugin</h2><p>Package checks, service connections, and workflow testing are separate steps.</p></div>
    <div className={`plugin-builder-check ${draft.errors.length ? "has-error" : "is-passed"}`}><Check size={18} /><span><strong>Package structure</strong><small>{draft.errors.length ? "The draft needs changes before installation." : "Manifest, declared Skills, MCP definitions, and file paths are valid."}</small></span><small>{draft.errors.length ? "Needs changes" : "Passed"}</small></div>
    {draft.errors.map(error => <p className="plugin-builder-error" role="alert" key={error}>{error}</p>)}
    {draft.plugin?.mcpServers?.map(server => {
      const check = draft.checks?.[server.id];
      const current = check?.revision === draft.revision;
      const result = current ? check?.result : undefined;
      return <div className="plugin-builder-service-check" key={server.id}><div className="plugin-builder-check"><Plug size={18} /><span><strong>{server.name}</strong><small>{result?.status === "connected" ? `Connected · ${result.toolCount} tool${result.toolCount === 1 ? "" : "s"} discovered` : result?.status === "needs-auth" ? "Authorization required. Install and authorize from the plugin page." : result?.status === "failed" ? "Connection failed" : check ? "Draft changed. Run this check again." : "Connection has not been tested."}</small></span><button className="plugin-detail-secondary" type="button" disabled={disabled || Boolean(draft.errors.length)} onClick={() => onTest(server.id)}>{operation === `test:${server.id}` ? <LoaderCircle className="spin" size={12} /> : null}Test connection</button></div>{result?.message ? <details className="plugin-builder-notice"><summary>Connection details</summary><pre>{result.message}</pre></details> : null}</div>;
    })}
    {Object.keys(draft.plugin?.configuration ?? {}).length ? <button className="plugin-detail-secondary" type="button" onClick={onConfigure}>Review configuration<ChevronRight size={14} /></button> : null}
    <div className="plugin-builder-check"><WandSparkles size={18} /><span><strong>Workflow behavior</strong><small>After installing, use an example request in a project to check the actual result.</small></span><small>Not tested</small></div>
  </div>;
}

function EmptyView({ icon: Icon, title, text }: { icon: typeof Package; title: string; text: string }) {
  return <div className="plugin-builder-preview-empty"><div className="plugin-builder-icon"><Icon size={20} /></div><h2>{title}</h2><p>{text}</p></div>;
}
function statusLabel(status: PluginSetupSummary["status"]): string {
  return { idle: "Ready to build", working: "Building…", ready: "Draft ready to review", installed: "Installed", interrupted: "Run interrupted", error: "Needs attention" }[status];
}
function activityLabel(activity?: string): string {
  return { read: "Reading plugin files…", write: "Writing plugin files…", edit: "Updating plugin files…", bash: "Working in the plugin workspace…", plugin_manage: "Preparing the plugin…" }[activity ?? ""] ?? "Working on your plugin…";
}
function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
