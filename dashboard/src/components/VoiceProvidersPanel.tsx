/**
 * Voice provider selection and status panel.
 *
 * Allows users to:
 * - See provider readiness status (Ready / Missing API Key)
 * - Configure ElevenLabs API key and model settings (modal)
 * - Save all provider settings to .env
 */

import { useState, useEffect, useCallback } from "react";
import { get, post } from "../api";

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_MODEL_ID = "eleven_turbo_v2_5";
const DEFAULT_STT_MODEL_ID = "scribe_v1";

// ============================================================================
// TYPES
// ============================================================================

interface ProviderStatus {
  ready: boolean;
  reason?: "missing_api_key";
  detail?: string;
}

interface ProviderInfo {
  type: string;
  name: string;
  description: string;
  status: ProviderStatus;
}

interface ProvidersResponse {
  providers: ProviderInfo[];
  active: string;
}

type ModalState =
  | null
  | { kind: "elevenlabs-tts" }
  | { kind: "elevenlabs-stt" };

// ============================================================================
// EVENT HANDLERS
// ============================================================================

/** Fetch TTS providers list with status from the API */
async function fetchTtsProviders(): Promise<ProvidersResponse> {
  return get<ProvidersResponse>("/api/providers/tts");
}

/** Fetch STT providers list with status from the API */
async function fetchSttProviders(): Promise<ProvidersResponse> {
  return get<ProvidersResponse>("/api/providers/stt");
}

/** Fetch current settings from .env */
async function fetchSettings(): Promise<Record<string, string>> {
  return get<Record<string, string>>("/api/settings");
}

// ============================================================================
// COMPONENTS
// ============================================================================

/** Color-coded badge showing provider readiness */
function StatusBadge({ status }: { status: ProviderStatus }) {
  let label: string;
  let bgColor: string;
  let textColor: string;

  if (status.ready) {
    label = "Ready";
    bgColor = "rgba(34, 197, 94, 0.15)";
    textColor = "#22c55e";
  } else if (status.reason === "missing_api_key") {
    label = "Missing API Key";
    bgColor = "rgba(239, 68, 68, 0.15)";
    textColor = "#ef4444";
  } else {
    label = "Unknown";
    bgColor = "rgba(156, 163, 175, 0.15)";
    textColor = "#9ca3af";
  }

  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: "4px",
        fontSize: "11px",
        fontWeight: 600,
        background: bgColor,
        color: textColor,
      }}
    >
      {label}
    </span>
  );
}

/** Single provider row with radio button, name, description, status badge, and action button */
function ProviderRow({
  provider,
  selected,
  onSelect,
  onAction,
  actionLabel,
  actionDisabled,
}: {
  provider: ProviderInfo;
  selected: boolean;
  onSelect: () => void;
  onAction?: () => void;
  actionLabel?: string;
  actionDisabled?: boolean;
}) {
  const disabled = !provider.status.ready;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "10px",
        padding: "10px 12px",
        border: selected ? "1px solid var(--btn-primary-bg)" : "1px solid var(--border-color)",
        borderRadius: "4px",
        background: selected ? "rgba(59, 130, 246, 0.05)" : "var(--bg-main)",
        cursor: disabled ? "default" : "pointer",
        transition: "all 0.15s ease",
      }}
      onClick={disabled ? undefined : onSelect}
    >
      <input
        type="radio"
        checked={selected}
        disabled={disabled}
        onChange={disabled ? undefined : onSelect}
        style={{ margin: 0, cursor: disabled ? "default" : "pointer" }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>
            {provider.name}
          </span>
          <StatusBadge status={provider.status} />
        </div>
        <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "2px" }}>
          {provider.description}
        </div>
      </div>
      {onAction && actionLabel && (
        <button
          disabled={actionDisabled}
          onClick={(e) => {
            e.stopPropagation();
            onAction();
          }}
          style={{
            padding: "4px 12px",
            fontSize: "12px",
            background: "var(--btn-primary-bg)",
            color: "var(--btn-primary-text)",
            border: "none",
            borderRadius: "4px",
            cursor: actionDisabled ? "default" : "pointer",
            opacity: actionDisabled ? 0.6 : 1,
          }}
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

/** Shared styles for modal form fields */
const fieldStyle: React.CSSProperties = { marginBottom: 14 };
const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 500,
  color: "var(--text-primary)",
  marginBottom: 4,
};
const modalInputStyle: React.CSSProperties = { width: "100%", boxSizing: "border-box" };
const modalBtnRow: React.CSSProperties = { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 };
const cancelBtnStyle: React.CSSProperties = {
  padding: "6px 16px",
  fontSize: "13px",
  background: "var(--bg-main)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-color)",
  borderRadius: "4px",
  cursor: "pointer",
};
const applyBtnStyle: React.CSSProperties = {
  padding: "6px 16px",
  fontSize: "13px",
  background: "var(--btn-primary-bg)",
  color: "var(--btn-primary-text)",
  border: "none",
  borderRadius: "4px",
  cursor: "pointer",
};

/** Modal for configuring ElevenLabs TTS settings */
function ElevenLabsTtsModal({
  apiKey,
  modelId,
  onSave,
  onClose,
}: {
  apiKey: string;
  modelId: string;
  onSave: (values: { apiKey: string }) => void;
  onClose: () => void;
}) {
  const [localApiKey, setLocalApiKey] = useState(apiKey);

  const handleSave = () => {
    onSave({ apiKey: localApiKey });
    onClose();
  };

  return (
    <div className="modal-overlay visible" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ width: 480 }}>
        <button className="modal-close" onClick={onClose}>&times;</button>
        <h2>ElevenLabs TTS</h2>
        <p style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 16 }}>
          Configure API key for ElevenLabs text-to-speech.
        </p>

        <div style={fieldStyle}>
          <label style={labelStyle}>API Key</label>
          <input
            type="password"
            value={localApiKey}
            onChange={(e) => setLocalApiKey(e.target.value)}
            placeholder="Enter your ElevenLabs API key"
            style={modalInputStyle}
          />
        </div>
        <div style={fieldStyle}>
          <label style={labelStyle}>TTS Model ID</label>
          <input
            type="text"
            value={modelId}
            disabled
            style={{ ...modalInputStyle, opacity: 0.5, cursor: "not-allowed" }}
          />
        </div>

        <div style={modalBtnRow}>
          <button onClick={onClose} style={cancelBtnStyle}>Cancel</button>
          <button onClick={handleSave} style={applyBtnStyle}>Apply</button>
        </div>
      </div>
    </div>
  );
}

/** Modal for configuring ElevenLabs STT settings */
function ElevenLabsSttModal({
  apiKey,
  sttModelId,
  onSave,
  onClose,
}: {
  apiKey: string;
  sttModelId: string;
  onSave: (values: { apiKey: string }) => void;
  onClose: () => void;
}) {
  const [localApiKey, setLocalApiKey] = useState(apiKey);

  const handleSave = () => {
    onSave({ apiKey: localApiKey });
    onClose();
  };

  return (
    <div className="modal-overlay visible" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ width: 480 }}>
        <button className="modal-close" onClick={onClose}>&times;</button>
        <h2>ElevenLabs STT</h2>
        <p style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 16 }}>
          Configure API key for ElevenLabs speech-to-text.
        </p>

        <div style={fieldStyle}>
          <label style={labelStyle}>API Key</label>
          <input
            type="password"
            value={localApiKey}
            onChange={(e) => setLocalApiKey(e.target.value)}
            placeholder="Enter your ElevenLabs API key"
            style={modalInputStyle}
          />
        </div>
        <div style={fieldStyle}>
          <label style={labelStyle}>STT Model ID</label>
          <input
            type="text"
            value={sttModelId}
            disabled
            style={{ ...modalInputStyle, opacity: 0.5, cursor: "not-allowed" }}
          />
        </div>

        <div style={modalBtnRow}>
          <button onClick={onClose} style={cancelBtnStyle}>Cancel</button>
          <button onClick={handleSave} style={applyBtnStyle}>Apply</button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// RENDER
// ============================================================================

export function VoiceProvidersPanel() {
  const [ttsProviders, setTtsProviders] = useState<ProviderInfo[]>([]);
  const [sttProviders, setSttProviders] = useState<ProviderInfo[]>([]);
  const [activeTts, setActiveTts] = useState("elevenlabs");
  const [activeStt, setActiveStt] = useState("elevenlabs");
  const [apiKey, setApiKey] = useState("");
  const [modelId, setModelId] = useState(DEFAULT_MODEL_ID);
  const [sttModelId, setSttModelId] = useState(DEFAULT_STT_MODEL_ID);
  const [modal, setModal] = useState<ModalState>(null);

  /** Persist a partial set of keys to .env */
  const saveSettings = useCallback(async (values: Record<string, string>) => {
    try {
      await post("/api/settings", values);
    } catch {
      // Silently fail — the next voice session will use whatever is in .env
    }
  }, []);

  // Load providers and settings on mount
  useEffect(() => {
    fetchTtsProviders()
      .then((data) => {
        setTtsProviders(data.providers);
        setActiveTts(data.active);
      })
      .catch(() => {});

    fetchSttProviders()
      .then((data) => {
        setSttProviders(data.providers);
        setActiveStt(data.active);
      })
      .catch(() => {});

    fetchSettings()
      .then((data) => {
        if (data.ELEVENLABS_API_KEY) setApiKey(data.ELEVENLABS_API_KEY);
        if (data.ELEVENLABS_MODEL_ID) setModelId(data.ELEVENLABS_MODEL_ID);
        if (data.ELEVENLABS_STT_MODEL_ID) setSttModelId(data.ELEVENLABS_STT_MODEL_ID);
      })
      .catch(() => {});
  }, []);

  /** Select a TTS provider and save immediately */
  const selectTts = useCallback((type: string) => {
    setActiveTts(type);
    saveSettings({ TTS_PROVIDER: type });
  }, [saveSettings]);

  /** Select an STT provider and save immediately */
  const selectStt = useCallback((type: string) => {
    setActiveStt(type);
    saveSettings({ STT_PROVIDER: type });
  }, [saveSettings]);

  /** Get action button config for a provider row */
  const getAction = (_providerType: string, _status: ProviderStatus, section: "tts" | "stt") => {
    const kind = section === "tts" ? "elevenlabs-tts" : "elevenlabs-stt";
    return {
      label: "Configure",
      onAction: () => setModal({ kind: kind as "elevenlabs-tts" | "elevenlabs-stt" }),
    };
  };

  return (
    <>
      <div
        className="page-header"
        style={{ borderBottom: "none", padding: 0, marginBottom: 24 }}
      >
        <div>
          <h1>Voice Providers</h1>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>
            Select and configure TTS and STT providers. Changes take effect on the next voice
            session.
          </p>
        </div>
      </div>

      {/* TTS Provider Section */}
      <div className="settings-panel" style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>
          TTS Provider
        </h2>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 16 }}>
          Choose which text-to-speech engine to use.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {ttsProviders.map((p) => {
            const action = getAction(p.type, p.status, "tts");
            return (
              <ProviderRow
                key={p.type}
                provider={p}
                selected={activeTts === p.type}
                onSelect={() => selectTts(p.type)}
                onAction={action.onAction}
                actionLabel={action.label}
              />
            );
          })}
        </div>
      </div>

      {/* STT Provider Section */}
      <div className="settings-panel" style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>
          STT Provider
        </h2>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 16 }}>
          Choose which speech-to-text engine to use.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {sttProviders.map((p) => {
            const action = getAction(p.type, p.status, "stt");
            return (
              <ProviderRow
                key={p.type}
                provider={p}
                selected={activeStt === p.type}
                onSelect={() => selectStt(p.type)}
                onAction={action.onAction}
                actionLabel={action.label}
              />
            );
          })}
        </div>
      </div>

      {/* ElevenLabs TTS Configuration Modal */}
      {modal?.kind === "elevenlabs-tts" && (
        <ElevenLabsTtsModal
          apiKey={apiKey}
          modelId={modelId}
          onSave={(values) => {
            setApiKey(values.apiKey);
            saveSettings({
              ELEVENLABS_API_KEY: values.apiKey,
            });
          }}
          onClose={() => setModal(null)}
        />
      )}

      {/* ElevenLabs STT Configuration Modal */}
      {modal?.kind === "elevenlabs-stt" && (
        <ElevenLabsSttModal
          apiKey={apiKey}
          sttModelId={sttModelId}
          onSave={(values) => {
            setApiKey(values.apiKey);
            saveSettings({
              ELEVENLABS_API_KEY: values.apiKey,
            });
          }}
          onClose={() => setModal(null)}
        />
      )}
    </>
  );
}
