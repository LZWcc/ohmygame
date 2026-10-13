import { useEffect, useId, useRef, useState, type FormEvent } from "react";
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
import { Check, LoaderCircle, Plus, RefreshCw, Trash2, X } from "./icons.js";

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
    setForm((current) => ({
      ...current,
      [key]: value,
      ...(["mode", "baseUrl", "apiKey"].includes(key) ? { models: [] } : {}),
    }));
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
  const models = form.models.filter((model) =>
    `${model.name} ${model.id}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
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
      className="settings-detail-section provider-models openai-image-models"
      aria-label="Image models"
    >
      <div className="provider-models-heading">
        <h4>
          Image models{" "}
          <small>
            {form.models.filter((model) => model.enabled).length || ""}
          </small>
        </h4>
        {saved && (saved.configured || saved.models.length > 0) ? (
          <button
            type="button"
            className="settings-secondary-button"
            disabled={locked || fetching}
            onClick={() => setRemoving(true)}
          >
            <Trash2 size={13} />
            Remove image connection
          </button>
        ) : null}
      </div>
      <p className="settings-detail-hint">
        Use an OpenAI API key or a compatible GPT Image relay. Image generation
        is billed by the configured API service separately from browser sign-in.
      </p>
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
        <form onSubmit={(event) => void save(event)}>
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
              disabled={locked}
              onChange={(event) =>
                field(
                  "mode",
                  event.target
                    .value as SaveOpenAIImageConnectionRequest["mode"],
                )
              }
            >
              <option value="separate">Separate API key and Base URL</option>
              <option value="connection" disabled={!saved.connectionAvailable}>
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
          {form.mode !== "disabled" ? (
            <>
              <div className="provider-models-controls">
                <label className="settings-provider-search">
                  <input
                    aria-label="Search image models"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search image models"
                  />
                </label>
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
                  onClick={() => setAdding(!adding)}
                >
                  <Plus size={13} />
                  Add model
                </button>
              </div>
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
                  <label
                    className="settings-detail-field"
                    htmlFor={`${fieldId}-template`}
                  >
                    <span className="settings-search-field-label">
                      Capability template
                    </span>
                    <select
                      id={`${fieldId}-template`}
                      className="settings-search-input"
                      value={manualTemplate}
                      disabled={locked}
                      onChange={(event) =>
                        setManualTemplate(
                          event.target
                            .value as OpenAIImageModelConfiguration["template"],
                        )
                      }
                    >
                      {(["gpt-image-1", "gpt-image-2"] as const).map(
                        (template) => (
                          <option key={template} value={template}>
                            {templateName(template)}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                  <div className="settings-form-actions">
                    <button
                      className="settings-secondary-button"
                      type="button"
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
                {models.map((model) => (
                  <div
                    className={`provider-model-row${model.enabled ? "" : " is-hidden"}`}
                    key={model.id}
                    role="listitem"
                  >
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
                      <span className="provider-model-copy">
                        <strong>{model.name}</strong>
                        <small>{model.id}</small>
                      </span>
                    </label>
                    <select
                      className="settings-search-input openai-image-template"
                      aria-label={`Capability template for ${model.id}`}
                      value={model.template}
                      disabled={locked || fetching}
                      onChange={(event) =>
                        changeModel(model.id, {
                          template: event.target
                            .value as OpenAIImageModelConfiguration["template"],
                        })
                      }
                    >
                      {(["gpt-image-1", "gpt-image-2"] as const).map(
                        (template) => (
                          <option key={template} value={template}>
                            {templateName(template)}
                          </option>
                        ),
                      )}
                    </select>
                    <button
                      className="icon-button"
                      type="button"
                      disabled={locked || fetching}
                      aria-label={`Remove ${model.id}`}
                      onClick={() =>
                        field(
                          "models",
                          form.models.filter((entry) => entry.id !== model.id),
                        )
                      }
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
                {!models.length ? (
                  <p className="settings-empty">
                    {form.models.length
                      ? "No image models match this search."
                      : "Fetch models or add a model ID manually."}
                  </p>
                ) : null}
              </div>
            </>
          ) : null}
          <div className="settings-form-actions">
            <button
              className="settings-secondary-button"
              type="button"
              disabled={locked || fetching || !dirty}
              onClick={() => {
                reset(saved);
                setError(undefined);
                setNotice(undefined);
              }}
            >
              Cancel changes
            </button>
            <button
              className="settings-primary-button"
              type="submit"
              disabled={locked || fetching || !dirty}
            >
              {busy ? (
                <LoaderCircle className="spin" size={13} />
              ) : (
                <Check size={13} />
              )}
              Save image settings
            </button>
          </div>
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

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
