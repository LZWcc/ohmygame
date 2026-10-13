import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type {
  OpenAIImageConnectionSettings,
  OpenAIImageModelConfiguration,
  SaveOpenAIImageConnectionRequest,
} from "../shared/contracts.js";
import {
  discoverOpenAIImageModels,
  getOpenAIImageSettings,
  removeOpenAIImageSettings,
  saveOpenAIImageSettings,
} from "./api.js";
import {
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "./icons.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const templateName = (template: OpenAIImageModelConfiguration["template"]) =>
  template === "gpt-image-1"
    ? "GPT Image 1 / 1.5 · fixed sizes"
    : "GPT Image 2 / 2.5 · flexible sizes";

export function OpenAIImageModels({
  revision,
  disabled = false,
  onChanged,
}: {
  revision: number;
  disabled?: boolean;
  onChanged: (configured: boolean) => void;
}) {
  const fieldId = useId();
  const [saved, setSaved] = useState<OpenAIImageConnectionSettings>();
  const [form, setForm] = useState<SaveOpenAIImageConnectionRequest>({
    mode: "separate",
    baseUrl: DEFAULT_BASE_URL,
    models: [],
  });
  const [busy, setBusy] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [editingConnection, setEditingConnection] = useState<
    "mode" | "key" | "url"
  >();
  const [editingModel, setEditingModel] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [manualId, setManualId] = useState("");
  const [manualTemplate, setManualTemplate] =
    useState<OpenAIImageModelConfiguration["template"]>("gpt-image-2");
  const [query, setQuery] = useState("");
  const discovery = useRef<AbortController | undefined>(undefined);
  const active = useRef(true);
  const generation = useRef(0);
  const baseline = useRef<SaveOpenAIImageConnectionRequest | undefined>(
    undefined,
  );

  function reset(settings: OpenAIImageConnectionSettings): void {
    setSaved(settings);
    const next: SaveOpenAIImageConnectionRequest = {
      mode:
        settings.mode === "connection" && !settings.connectionAvailable
          ? "separate"
          : settings.mode,
      baseUrl: settings.baseUrl,
      models: settings.models,
    };
    baseline.current = next;
    setForm(next);
    setEditing(false);
    setEditingConnection(undefined);
    setEditingModel(undefined);
    setAdding(false);
    setRemoving(false);
    setManualId("");
    setQuery("");
  }
  useEffect(() => {
    active.current = true;
    ++generation.current;
    let current = true;
    discovery.current?.abort();
    setFetching(false);
    setBusy(false);
    setError(undefined);
    setNotice(undefined);
    void getOpenAIImageSettings()
      .then((settings) => {
        if (current) reset(settings);
      })
      .catch((cause) => {
        if (current) setError(errorMessage(cause));
      });
    return () => {
      current = false;
      active.current = false;
      discovery.current?.abort();
    };
  }, [revision]);

  function field<K extends keyof SaveOpenAIImageConnectionRequest>(
    key: K,
    value: SaveOpenAIImageConnectionRequest[K],
  ): void {
    discovery.current?.abort();
    setFetching(false);
    setError(undefined);
    setNotice(undefined);
    if (["mode", "baseUrl", "apiKey"].includes(key)) setEditingModel(undefined);
    setForm((current) => ({
      ...current,
      [key]: value,
      ...(["mode", "baseUrl", "apiKey"].includes(key) ? { models: [] } : {}),
    }));
  }
  function editConnection(setting: "mode" | "key" | "url"): void {
    setEditing(true);
    setEditingConnection(setting);
    setAdding(false);
    setEditingModel(undefined);
    setError(undefined);
    setNotice(undefined);
  }
  function cancel(): void {
    discovery.current?.abort();
    setFetching(false);
    if (saved) reset(saved);
    setError(undefined);
    setNotice(undefined);
  }
  async function fetchModels(): Promise<void> {
    discovery.current?.abort();
    const controller = new AbortController();
    discovery.current = controller;
    setFetching(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const loaded = await discoverOpenAIImageModels(
        { mode: form.mode, baseUrl: form.baseUrl, apiKey: form.apiKey },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setForm((current) => ({
        ...current,
        models: [
          ...current.models,
          ...loaded.models.filter(
            (model) => !current.models.some((entry) => entry.id === model.id),
          ),
        ],
      }));
      setNotice(
        `Fetched ${loaded.models.length} image models. Enable the models you want and save.${loaded.warnings?.length ? ` ${loaded.warnings.join(" ")}` : ""}`,
      );
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (!controller.signal.aborted) setFetching(false);
    }
  }
  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    const currentGeneration = generation.current;
    setBusy(true);
    setError(undefined);
    discovery.current?.abort();
    setFetching(false);
    try {
      const settings = await saveOpenAIImageSettings(form);
      if (!active.current || currentGeneration !== generation.current) return;
      reset(settings);
      setNotice("Image connection saved.");
      onChanged(
        settings.mode === "separate"
          ? settings.configured
          : settings.mode === "connection" && settings.connectionAvailable,
      );
    } catch (cause) {
      if (active.current && currentGeneration === generation.current)
        setError(errorMessage(cause));
    } finally {
      if (active.current && currentGeneration === generation.current)
        setBusy(false);
    }
  }
  async function remove(): Promise<void> {
    const currentGeneration = generation.current;
    setBusy(true);
    setError(undefined);
    discovery.current?.abort();
    setFetching(false);
    try {
      const settings = await removeOpenAIImageSettings();
      if (!active.current || currentGeneration !== generation.current) return;
      reset(settings);
      setNotice("Image connection removed.");
      onChanged(false);
    } catch (cause) {
      if (active.current && currentGeneration === generation.current)
        setError(errorMessage(cause));
    } finally {
      if (active.current && currentGeneration === generation.current)
        setBusy(false);
    }
  }
  function addModel(): void {
    const id = manualId.trim();
    if (!id || /\s/.test(id)) {
      setError("Enter a model ID without spaces");
      return;
    }
    if (form.models.some((model) => model.id === id)) {
      setError("A model with this ID already exists");
      return;
    }
    field("models", [
      ...form.models,
      { id, name: id, template: manualTemplate, enabled: true },
    ]);
    setAdding(false);
    setManualId("");
    setQuery("");
  }
  const locked = disabled || busy;
  const sameEndpoint =
    form.baseUrl.replace(/\/+$/, "") === saved?.baseUrl.replace(/\/+$/, "");
  const canFetch =
    form.mode === "connection"
      ? saved?.connectionAvailable
      : form.mode === "separate" &&
        Boolean(form.apiKey?.trim() || (saved?.configured && sameEndpoint));
  const original = baseline.current;
  const dirty =
    original &&
    (form.apiKey?.trim() ||
      form.mode !== original.mode ||
      form.baseUrl !== original.baseUrl ||
      JSON.stringify(form.models) !== JSON.stringify(original.models));
  const models = form.models.filter(
    (model) =>
      (editing || model.enabled) &&
      `${model.name} ${model.id}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const connected =
    saved?.mode === "separate"
      ? saved.configured
      : saved?.mode === "connection" && saved.connectionAvailable;
  const enabledCount = form.models.filter((model) => model.enabled).length;
  const changeModel = (
    id: string,
    patch: Partial<OpenAIImageModelConfiguration>,
  ) =>
    field(
      "models",
      form.models.map((model) =>
        model.id === id ? { ...model, ...patch } : model,
      ),
    );

  return (
    <section
      className={`settings-detail-section provider-models${editing ? " is-editing" : ""}`}
      aria-label="Image models"
    >
      <div className="provider-models-heading">
        <h4>
          Image models <small>{saved ? enabledCount : ""}</small>
        </h4>
        {saved ? (
          <div className="provider-models-heading-actions">
            {editing ? (
              form.mode !== "disabled" ? (
                <>
                  <button
                    className="settings-secondary-button"
                    type="button"
                    disabled={locked || fetching || !canFetch}
                    onClick={() => void fetchModels()}
                  >
                    <RefreshCw
                      size={13}
                      className={fetching ? "spin" : undefined}
                    />
                    {fetching ? "Fetching…" : "Fetch models"}
                  </button>
                  <button
                    className="settings-secondary-button"
                    type="button"
                    disabled={locked || fetching}
                    aria-expanded={adding}
                    onClick={() => {
                      setAdding(!adding);
                      setEditingModel(undefined);
                    }}
                  >
                    <Plus size={13} />
                    Add model
                  </button>
                </>
              ) : null
            ) : (
              <button
                className="settings-secondary-button"
                type="button"
                aria-label={
                  connected ? "Edit image models" : "Connect image models"
                }
                disabled={locked}
                onClick={() => {
                  if (connected) {
                    setEditing(true);
                    setError(undefined);
                    setNotice(undefined);
                  } else editConnection("mode");
                }}
              >
                {connected ? <Pencil size={13} /> : <Plus size={13} />}
                {connected ? "Edit" : "Connect"}
              </button>
            )}
          </div>
        ) : null}
      </div>
      {error ? (
        <p className="settings-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="settings-success" role="status">
          {notice}
        </p>
      ) : null}
      {!saved ? (
        !error ? (
          <div className="settings-loading">
            <LoaderCircle size={16} className="spin" />
            Loading image settings
          </div>
        ) : null
      ) : (
        <form
          className="settings-detail-section"
          onSubmit={(event) => void save(event)}
        >
          {editingConnection ? (
            <div className="settings-provider-setting-editor settings-detail-section">
              <label
                className="settings-detail-field"
                htmlFor={`${fieldId}-connection`}
              >
                <span className="settings-search-field-label">
                  Image connection
                </span>
                <select
                  id={`${fieldId}-connection`}
                  className="settings-search-input"
                  value={form.mode}
                  autoFocus={editingConnection === "mode"}
                  disabled={locked}
                  onChange={(event) =>
                    field(
                      "mode",
                      event.target
                        .value as SaveOpenAIImageConnectionRequest["mode"],
                    )
                  }
                >
                  <option value="separate">
                    Separate API key and Base URL
                  </option>
                  <option
                    value="connection"
                    disabled={!saved.connectionAvailable}
                  >
                    Use chat API connection
                    {!saved.connectionAvailable ? " (API key required)" : ""}
                  </option>
                  <option value="disabled">Disabled</option>
                </select>
              </label>
              {form.mode === "separate" ? (
                <div className="provider-model-form-grid">
                  <label
                    className="settings-detail-field"
                    htmlFor={`${fieldId}-key`}
                  >
                    <span className="settings-search-field-label">
                      Image API key{" "}
                      {saved.configured && sameEndpoint ? "· configured" : ""}
                    </span>
                    <input
                      id={`${fieldId}-key`}
                      className="settings-search-input"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      value={form.apiKey ?? ""}
                      autoFocus={editingConnection === "key"}
                      disabled={locked}
                      maxLength={16_384}
                      required={!saved.configured || !sameEndpoint}
                      placeholder={
                        saved.configured && sameEndpoint
                          ? "Leave blank to keep the saved image key"
                          : "Paste the API key for this endpoint"
                      }
                      onChange={(event) => field("apiKey", event.target.value)}
                    />
                  </label>
                  <label
                    className="settings-detail-field"
                    htmlFor={`${fieldId}-url`}
                  >
                    <span className="settings-search-field-label">
                      Image Base URL
                    </span>
                    <input
                      id={`${fieldId}-url`}
                      className="settings-search-input"
                      type="url"
                      required
                      value={form.baseUrl}
                      autoFocus={editingConnection === "url"}
                      disabled={locked}
                      placeholder={DEFAULT_BASE_URL}
                      onChange={(event) => field("baseUrl", event.target.value)}
                    />
                  </label>
                </div>
              ) : form.mode === "connection" ? (
                <p className="settings-detail-hint">
                  Uses the chat API key and endpoint: {saved.connectionBaseUrl}
                </p>
              ) : null}
              <p className="settings-detail-hint">
                Images use API billing. A compatible GPT Image relay is
                supported.
              </p>
            </div>
          ) : connected || form.mode === "disabled" || editing ? (
            <div>
              {[
                {
                  label: "Connection",
                  value:
                    form.mode === "separate"
                      ? "Separate API key"
                      : form.mode === "connection"
                        ? "Chat API connection"
                        : "Disabled",
                  setting: "mode" as const,
                  ariaLabel: "Edit image connection",
                },
                ...(form.mode === "separate"
                  ? [
                      {
                        label: "API key",
                        value: "••••••••",
                        setting: "key" as const,
                        ariaLabel: "Edit image API key",
                      },
                    ]
                  : []),
                ...(form.mode !== "disabled"
                  ? [
                      {
                        label: "Base URL",
                        value:
                          form.mode === "connection"
                            ? (saved.connectionBaseUrl ?? "Unavailable")
                            : form.baseUrl,
                        setting: "url" as const,
                        ariaLabel: "Edit image Base URL",
                      },
                    ]
                  : []),
              ].map((row) => (
                <div
                  className="settings-provider-setting-row"
                  key={row.setting}
                >
                  <span className="settings-search-field-label">
                    {row.label}
                  </span>
                  <span
                    className="settings-provider-setting-value"
                    title={row.value}
                  >
                    {row.value}
                  </span>
                  {row.setting !== "url" || form.mode === "separate" ? (
                    <button
                      className="icon-button settings-provider-setting-edit"
                      type="button"
                      disabled={locked}
                      aria-label={row.ariaLabel}
                      data-tooltip={row.ariaLabel}
                      onClick={() => editConnection(row.setting)}
                    >
                      <Pencil size={15} aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <p className="settings-detail-hint">
              Connect an API key for OpenAI or a compatible GPT Image relay.
            </p>
          )}
          {form.mode !== "disabled" && (connected || editing) ? (
            <>
              {editing || enabledCount > 5 ? (
                <div className="provider-models-controls">
                  <label className="settings-provider-search">
                    <Search size={14} />
                    <input
                      aria-label="Search image models"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="Search image models"
                    />
                  </label>
                </div>
              ) : null}
              {adding ? (
                <div className="provider-model-form">
                  <label
                    className="settings-detail-field"
                    htmlFor={`${fieldId}-model`}
                  >
                    <span className="settings-search-field-label">
                      Model ID
                    </span>
                    <input
                      id={`${fieldId}-model`}
                      className="settings-search-input"
                      autoFocus
                      maxLength={200}
                      value={manualId}
                      disabled={locked}
                      onChange={(event) => {
                        const id = event.target.value;
                        setManualId(id);
                        if (/^gpt-image-1(?:[.-]|$)/.test(id))
                          setManualTemplate("gpt-image-1");
                        else if (/^gpt-image-2(?:[.-]|$)/.test(id))
                          setManualTemplate("gpt-image-2");
                      }}
                      placeholder="gpt-image-2 or the relay's model alias"
                    />
                  </label>
                  <TemplateField
                    id={`${fieldId}-template`}
                    value={manualTemplate}
                    disabled={locked}
                    onChange={setManualTemplate}
                  />
                  <div className="settings-form-actions">
                    <button
                      className="settings-secondary-button"
                      type="button"
                      disabled={locked}
                      onClick={() => setAdding(false)}
                    >
                      Cancel
                    </button>
                    <button
                      className="settings-primary-button"
                      type="button"
                      disabled={locked || !manualId.trim()}
                      onClick={addModel}
                    >
                      Add
                    </button>
                  </div>
                </div>
              ) : null}
              <div
                className="provider-models-list"
                role="list"
                aria-label="Configured image models"
                aria-busy={fetching}
              >
                {models.map((model) => {
                  const copy = (
                    <span className="provider-model-copy">
                      <strong title={model.name}>{model.name}</strong>
                      {model.name !== model.id ? (
                        <small title={model.id}>{model.id}</small>
                      ) : null}
                    </span>
                  );
                  return (
                    <Fragment key={model.id}>
                      <div
                        className={`provider-model-row${model.enabled ? "" : " is-hidden"}`}
                        role="listitem"
                      >
                        {editing ? (
                          <label>
                            <input
                              type="checkbox"
                              checked={model.enabled}
                              disabled={locked || fetching}
                              aria-label={`Enable ${model.name}`}
                              onChange={(event) =>
                                changeModel(model.id, {
                                  enabled: event.target.checked,
                                })
                              }
                            />
                            {copy}
                          </label>
                        ) : (
                          <div className="provider-model-readonly">{copy}</div>
                        )}
                        {editing ? (
                          <>
                            <button
                              className="icon-button"
                              type="button"
                              disabled={locked || fetching || adding}
                              aria-label={`Edit ${model.name}`}
                              data-tooltip={`Edit ${model.name}`}
                              aria-expanded={editingModel === model.id}
                              onClick={() =>
                                setEditingModel(
                                  editingModel === model.id
                                    ? undefined
                                    : model.id,
                                )
                              }
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              className="icon-button provider-model-delete"
                              type="button"
                              disabled={locked || fetching}
                              aria-label={`Remove ${model.id}`}
                              data-tooltip={`Remove ${model.id}`}
                              onClick={() => {
                                field(
                                  "models",
                                  form.models.filter(
                                    (entry) => entry.id !== model.id,
                                  ),
                                );
                                if (editingModel === model.id)
                                  setEditingModel(undefined);
                              }}
                            >
                              <Trash2 size={14} />
                            </button>
                          </>
                        ) : null}
                      </div>
                      {editing && editingModel === model.id ? (
                        <div className="provider-model-form">
                          <TemplateField
                            id={`${fieldId}-edit-template`}
                            modelId={model.id}
                            value={model.template}
                            disabled={locked || fetching}
                            onChange={(template) =>
                              changeModel(model.id, { template })
                            }
                          />
                        </div>
                      ) : null}
                    </Fragment>
                  );
                })}
                {!models.length ? (
                  <p className="settings-empty">
                    {query.trim()
                      ? "No image models match this search."
                      : editing
                        ? "Fetch models or add a model ID manually."
                        : "No image models enabled."}
                  </p>
                ) : null}
              </div>
            </>
          ) : null}
          {editing ? (
            <div className="provider-model-form-footer">
              {saved.configured || saved.models.length > 0 ? (
                <button
                  className="icon-button provider-model-delete"
                  type="button"
                  aria-label="Remove image connection"
                  data-tooltip="Remove image connection"
                  disabled={locked || fetching}
                  onClick={() => setRemoving(true)}
                >
                  <Trash2 size={14} />
                </button>
              ) : null}
              <div className="provider-model-form-actions">
                <button
                  className="settings-secondary-button"
                  type="button"
                  disabled={locked}
                  onClick={cancel}
                >
                  Cancel
                </button>
                <button
                  className="settings-primary-button"
                  type="submit"
                  disabled={locked || fetching || !dirty}
                >
                  {busy ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          ) : null}
          {removing ? (
            <div className="settings-provider-delete-confirmation">
              <span>
                Remove the saved image key and models? Image generation will be
                disabled.
              </span>
              <button
                className="settings-danger-button"
                type="button"
                disabled={locked}
                onClick={() => void remove()}
              >
                Remove
              </button>
              <button
                className="settings-secondary-button"
                type="button"
                disabled={locked}
                onClick={() => setRemoving(false)}
              >
                Cancel
              </button>
            </div>
          ) : null}
        </form>
      )}
    </section>
  );
}

function TemplateField({
  id,
  modelId,
  value,
  disabled,
  onChange,
}: {
  id: string;
  modelId?: string;
  value: OpenAIImageModelConfiguration["template"];
  disabled: boolean;
  onChange: (template: OpenAIImageModelConfiguration["template"]) => void;
}) {
  return (
    <label className="settings-detail-field" htmlFor={id}>
      <span className="settings-search-field-label">Capability template</span>
      <select
        id={id}
        className="settings-search-input"
        aria-label={modelId ? `Capability template for ${modelId}` : undefined}
        value={value}
        disabled={disabled}
        onChange={(event) =>
          onChange(
            event.target.value as OpenAIImageModelConfiguration["template"],
          )
        }
      >
        {(["gpt-image-1", "gpt-image-2"] as const).map((template) => (
          <option key={template} value={template}>
            {templateName(template)}
          </option>
        ))}
      </select>
    </label>
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
