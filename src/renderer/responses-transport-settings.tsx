import { useEffect, useId, useState } from "react";
import type { ResponsesTransportMode } from "../shared/contracts.js";
import { getResponsesTransport, updateResponsesTransport } from "./api.js";

export function ProviderResponsesTransport({
  providerId,
  disabled = false,
}: {
  providerId: string;
  disabled?: boolean;
}) {
  const id = useId();
  const [mode, setMode] = useState<ResponsesTransportMode>("auto");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(undefined);
    void getResponsesTransport(providerId)
      .then((settings) => {
        if (active) setMode(settings.mode);
      })
      .catch((cause) => {
        if (active)
          setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [providerId]);
  async function save(value: ResponsesTransportMode) {
    setSaving(true);
    setError(undefined);
    try {
      setMode((await updateResponsesTransport(providerId, value)).mode);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }
  return (
    <section
      className="settings-detail-section"
      aria-label="Responses connection settings"
    >
      <div className="settings-detail-field">
        <label className="settings-search-field-label" htmlFor={id}>
          Responses connection
        </label>
        <select
          id={id}
          className="settings-search-input"
          value={mode}
          disabled={disabled || loading || saving}
          onChange={(event) =>
            void save(event.target.value as ResponsesTransportMode)
          }
        >
          <option value="auto">Automatic</option>
          <option value="sse">HTTP / SSE</option>
          <option value="websocket">Prefer WebSocket</option>
        </select>
        <small className="settings-detail-hint">
          Automatic prefers WebSocket for official OpenAI and HTTP / SSE for
          relays. Temporary connection failures fall back to HTTP / SSE for five
          minutes. Interrupted replies retry with Reconnecting when automatic
          retry is enabled.
        </small>
      </div>
      {error ? (
        <p className="settings-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
