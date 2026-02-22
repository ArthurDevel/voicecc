/**
 * Voice provider selection and status panel.
 *
 * Allows users to:
 * - Select TTS and STT providers via radio buttons
 * - See provider readiness status (Ready / Not Installed / Missing API Key / Unsupported Platform)
 * - Trigger on-demand setup for local providers (modal with live log output)
 * - Configure ElevenLabs API key and model settings (modal)
 * - Save all provider settings to .env
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { get, post } from "../api";

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";
const DEFAULT_MODEL_ID = "eleven_turbo_v2_5";
const DEFAULT_STT_MODEL_ID = "scribe_v1";

/** How often to poll for setup log updates (ms) */
const SETUP_POLL_INTERVAL_MS = 1500;

// ============================================================================
// TYPES
// ============================================================================

interface ProviderStatus {
  ready: boolean;
  reason?: "not_installed" | "missing_api_key" | "unsupported_platform";
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

interface SetupJobStatus {
  running: boolean;
  exitCode: number | null;
  log: string;
}

type ModalState =
  | null
  | { kind: "setup"; target: "local-tts" | "local-stt" }
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
  } else if (status.reason === "not_installed") {
    label = "Not Installed";
    bgColor = "rgba(234, 179, 8, 0.15)";
    textColor = "#eab308";
  } else if (status.reason === "missing_api_key") {
    label = "Missing API Key";
    bgColor = "rgba(239, 68, 68, 0.15)";
    textColor = "#ef4444";
  } else if (status.reason === "unsupported_platform") {
    label = "Unsupported Platform";
    bgColor = "rgba(156, 163, 175, 0.15)";
    textColor = "#9ca3af";
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

/** Modal for local provider setup with live log output */
function SetupModal({
  target,
  onClose,
  onComplete,
}: {
  target: "local-tts" | "local-stt";
  onClose: () => void;
  onComplete: () => void;
}) {
  const [log, setLog] = useState("");
  const [running, setRunning] = useState(true);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const startedRef = useRef(false);

  // Auto-scroll to bottom when log updates
  useEffect(() => {
    if (preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [log]);

  // Start the setup job and poll for updates
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    let cancelled = false;

    const run = async () => {
      try {
        const { jobId } = await post<{ jobId: string }>(
          `/api/providers/setup/${target}`
        );

        // Small initial delay to let the process start
        await new Promise((r) => setTimeout(r, 500));

        const poll = async (): Promise<void> => {
          if (cancelled) return;
          try {
            const status = await get<SetupJobStatus>(
              `/api/providers/setup/status/${jobId}`
            );
            setLog(status.log);

            if (status.running) {
              await new Promise((r) => setTimeout(r, SETUP_POLL_INTERVAL_MS));
              return poll();
            }

            setRunning(false);
            setExitCode(status.exitCode);
            if (status.exitCode === 0) onComplete();
          } catch {
            if (!cancelled) setRunning(false);
          }
        };

        await poll();
      } catch {
        if (!cancelled) setRunning(false);
      }
    };

    run();
    return () => { cancelled = true; };
  }, [target, onComplete]);

  const title = target === "local-tts" ? "Setting up Local TTS" : "Setting up Local STT";

  return (
    <div className="modal-overlay visible" onClick={(e) => { if (e.target === e.currentTarget && !running) onClose(); }}>
      <div className="modal" style={{ width: 640 }}>
        <button className="modal-close" onClick={onClose} disabled={running}>&times;</button>
        <h2>{title}</h2>
        <p style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 12 }}>
          {running
            ? "Installing dependencies. This may take a few minutes..."
            : exitCode === 0
              ? "Setup completed successfully."
              : "Setup failed. Check the log below for details."}
        </p>
        <pre
          ref={preRef}
          style={{
            background: "#1a1a2e",
            color: "#e0e0e0",
            padding: "12px 14px",
            borderRadius: "4px",
            fontSize: "11px",
            lineHeight: "1.5",
            maxHeight: "400px",
            overflowY: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            margin: 0,
            border: "1px solid var(--border-color)",
          }}
        >
          {log || "Starting setup...\n"}
        </pre>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
          <button
            onClick={onClose}
            disabled={running}
            style={{
              padding: "6px 16px",
              fontSize: "13px",
              background: running ? "var(--bg-main)" : "var(--btn-primary-bg)",
              color: running ? "var(--text-secondary)" : "var(--btn-primary-text)",
              border: "1px solid var(--border-color)",
              borderRadius: "4px",
              cursor: running ? "default" : "pointer",
            }}
          >
            {running ? "Running..." : "Close"}
          </button>
        </div>
      </div>
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
  voiceId,
  modelId,
  onSave,
  onClose,
}: {
  apiKey: string;
  voiceId: string;
  modelId: string;
  onSave: (values: { apiKey: string; voiceId: string; modelId: string }) => void;
  onClose: () => void;
}) {
  const [localApiKey, setLocalApiKey] = useState(apiKey);
  const [localVoiceId, setLocalVoiceId] = useState(voiceId);
  const [localModelId, setLocalModelId] = useState(modelId);

  const handleSave = () => {
    onSave({ apiKey: localApiKey, voiceId: localVoiceId, modelId: localModelId });
    onClose();
  };

  return (
    <div className="modal-overlay visible" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ width: 480 }}>
        <button className="modal-close" onClick={onClose}>&times;</button>
        <h2>ElevenLabs TTS</h2>
        <p style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 16 }}>
          Configure API key, voice, and model for ElevenLabs text-to-speech.
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
          <label style={labelStyle}>Voice ID</label>
          <input
            type="text"
            value={localVoiceId}
            onChange={(e) => setLocalVoiceId(e.target.value)}
            placeholder={DEFAULT_VOICE_ID}
            style={modalInputStyle}
          />
        </div>
        <div style={fieldStyle}>
          <label style={labelStyle}>TTS Model ID</label>
          <input
            type="text"
            value={localModelId}
            onChange={(e) => setLocalModelId(e.target.value)}
            placeholder={DEFAULT_MODEL_ID}
            style={modalInputStyle}
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
  onSave: (values: { apiKey: string; sttModelId: string }) => void;
  onClose: () => void;
}) {
  const [localApiKey, setLocalApiKey] = useState(apiKey);
  const [localSttModelId, setLocalSttModelId] = useState(sttModelId);

  const handleSave = () => {
    onSave({ apiKey: localApiKey, sttModelId: localSttModelId });
    onClose();
  };

  return (
    <div className="modal-overlay visible" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ width: 480 }}>
        <button className="modal-close" onClick={onClose}>&times;</button>
        <h2>ElevenLabs STT</h2>
        <p style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 16 }}>
          Configure API key and model for ElevenLabs speech-to-text.
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
            value={localSttModelId}
            onChange={(e) => setLocalSttModelId(e.target.value)}
            placeholder={DEFAULT_STT_MODEL_ID}
            style={modalInputStyle}
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
  const [activeTts, setActiveTts] = useState("local");
  const [activeStt, setActiveStt] = useState("local");
  const [apiKey, setApiKey] = useState("");
  const [voiceId, setVoiceId] = useState(DEFAULT_VOICE_ID);
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
        if (data.ELEVENLABS_VOICE_ID) setVoiceId(data.ELEVENLABS_VOICE_ID);
        if (data.ELEVENLABS_MODEL_ID) setModelId(data.ELEVENLABS_MODEL_ID);
        if (data.ELEVENLABS_STT_MODEL_ID) setSttModelId(data.ELEVENLABS_STT_MODEL_ID);
      })
      .catch(() => {});
  }, []);

  /** Refresh provider lists after a setup completes */
  const refreshProviders = useCallback(async () => {
    try {
      const [tts, stt] = await Promise.all([fetchTtsProviders(), fetchSttProviders()]);
      setTtsProviders(tts.providers);
      setSttProviders(stt.providers);
    } catch {
      // Ignore refresh errors
    }
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
  const getAction = (providerType: string, status: ProviderStatus, section: "tts" | "stt") => {
    if (providerType === "local" && !status.ready && status.reason === "not_installed") {
      const target = section === "tts" ? "local-tts" : "local-stt";
      return {
        label: "Setup",
        onAction: () => setModal({ kind: "setup" as const, target: target as "local-tts" | "local-stt" }),
      };
    }
    if (providerType === "elevenlabs") {
      const kind = section === "tts" ? "elevenlabs-tts" : "elevenlabs-stt";
      return {
        label: "Configure",
        onAction: () => setModal({ kind: kind as "elevenlabs-tts" | "elevenlabs-stt" }),
      };
    }
    return {};
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

      {/* Setup Modal (local provider installation) */}
      {modal?.kind === "setup" && (
        <SetupModal
          target={modal.target}
          onClose={() => setModal(null)}
          onComplete={refreshProviders}
        />
      )}

      {/* ElevenLabs TTS Configuration Modal */}
      {modal?.kind === "elevenlabs-tts" && (
        <ElevenLabsTtsModal
          apiKey={apiKey}
          voiceId={voiceId}
          modelId={modelId}
          onSave={(values) => {
            setApiKey(values.apiKey);
            setVoiceId(values.voiceId);
            setModelId(values.modelId);
            saveSettings({
              ELEVENLABS_API_KEY: values.apiKey,
              ELEVENLABS_VOICE_ID: values.voiceId,
              ELEVENLABS_MODEL_ID: values.modelId,
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
            setSttModelId(values.sttModelId);
            saveSettings({
              ELEVENLABS_API_KEY: values.apiKey,
              ELEVENLABS_STT_MODEL_ID: values.sttModelId,
            });
          }}
          onClose={() => setModal(null)}
        />
      )}
    </>
  );
}
