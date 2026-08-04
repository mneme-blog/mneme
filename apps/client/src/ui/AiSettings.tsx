// AI assistant settings sheet. The feature is off by default; enabling it is
// the explicit consent step — the cloud card spells out exactly what leaves
// the device (entries used as context go, decrypted, to the chosen provider;
// the relay is never involved). The API key is sealed under a vault-derived
// key in IndexedDB (ai/settings.ts) and only ever readable while unlocked.
import type { JSX, VNode } from 'preact';
import { useState } from 'preact/hooks';
import { Icon } from './Icon';
import { Btn } from './primitives';
import { t } from '../i18n';
import { useAppData } from '../state/data';
import { makeProvider } from '../ai/provider';
import { ollamaHostLabel, ollamaScope } from '../ai/ollamaUrl';
import { resolveTranscriptionUrl } from '../ai/transcribe';
import {
  toAiError,
  defaultAiSettings,
  defaultTranscriptionSettings,
  ANTHROPIC_MODELS,
  DEFAULT_TRANSCRIPTION_MODEL,
  type AiSettings,
  type AiBackend,
  type TranscriptionSettings,
} from '../ai/types';

const pStyle: JSX.CSSProperties = { fontFamily: 'var(--ui)', fontSize: 13, lineHeight: 1.55, color: 'var(--ink-2)', margin: 0 };
const labelStyle: JSX.CSSProperties = { fontFamily: 'var(--ui)', fontSize: 12, fontWeight: 600, color: 'var(--ink-2)', marginBottom: 5, display: 'block' };
const inputStyle: JSX.CSSProperties = {
  width: '100%', boxSizing: 'border-box', fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--ink)',
  padding: '9px 11px', borderRadius: 10, background: 'var(--paper)', border: '1px solid var(--line)', outline: 'none',
};

type TestState = { state: 'idle' } | { state: 'busy' } | { state: 'ok' } | { state: 'fail'; message: string };

// The cloud privacy warning, with its emphasized word bolded. The catalog
// string carries a literal {decrypted} marker so translations place the
// emphasis wherever their grammar needs it — one key, no fragment stitching.
function cloudPrivacy(): VNode {
  const [before, after] = t('assistant.settings.cloudPrivacy').split('{decrypted}');
  return (
    <>
      {before}
      <strong>{t('assistant.settings.cloudPrivacyDecrypted')}</strong>
      {after}
    </>
  );
}

export function AiSettingsSheet({ desk, onClose }: { desk: boolean; onClose: () => void }): VNode {
  const { aiSettings, saveAiSettings } = useAppData();
  const [form, setForm] = useState<AiSettings>(() => aiSettings ?? defaultAiSettings());
  // Where the Ollama backend actually points. Recomputed as the field is typed,
  // so the badge and the copy can never claim "on this device" for a URL that
  // isn't (audit finding L4, issue #49).
  // 'invalid' counts as local: makeProvider falls back to the loopback default
  // rather than using an unusable string, so nothing leaves the device.
  const ollamaScopeNow = ollamaScope(form.ollama.baseUrl);
  const ollamaLocal = ollamaScopeNow === 'loopback' || ollamaScopeNow === 'invalid';
  const [test, setTest] = useState<TestState>({ state: 'idle' });
  const [models, setModels] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // A stored key is shown masked; typing replaces it wholesale.
  const [keyDirty, setKeyDirty] = useState(!aiSettings?.anthropic.apiKey);
  const [trKeyDirty, setTrKeyDirty] = useState(!aiSettings?.transcription?.apiKey);

  const patch = (p: Partial<AiSettings>): void => {
    setForm((f) => ({ ...f, ...p }));
    setTest({ state: 'idle' });
  };

  // Records sealed before transcription existed lack the field — treat as
  // defaults (the deployment-bundled same-origin /whisper proxy).
  const tr = form.transcription ?? defaultTranscriptionSettings();
  const patchTr = (p: Partial<TranscriptionSettings>): void => patch({ transcription: { ...tr, ...p } });
  // Same honesty rules as the Ollama URL: this setting syncs across devices and
  // decides where decrypted recordings go, so the badge must not be able to lie.
  // The stored value may be the same-origin path form — resolve before judging.
  const trResolved = resolveTranscriptionUrl(tr.baseUrl);
  const trConfigured = trResolved !== null;
  const trScope = trResolved ? ollamaScope(trResolved) : 'invalid';

  const runTest = async (): Promise<void> => {
    setTest({ state: 'busy' });
    try {
      const provider = makeProvider(form);
      await provider.verify();
      if (form.backend === 'ollama' && provider.listModels) {
        const names = await provider.listModels();
        setModels(names);
        if (!form.ollama.model && names[0]) patch({ ollama: { ...form.ollama, model: names[0] } });
      }
      setTest({ state: 'ok' });
    } catch (e) {
      const err = toAiError(e);
      setTest({
        state: 'fail',
        message:
          err.hint === 'auth'
            ? t('assistant.error.keyRejectedShort')
            : form.backend === 'ollama'
              ? t('assistant.error.ollamaUnreachable')
              : t('assistant.error.apiUnreachable', { message: err.message }),
      });
    }
  };

  const save = async (next: AiSettings | null): Promise<void> => {
    setSaving(true);
    setError('');
    try {
      await saveAiSettings(next);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const card = (backend: AiBackend, title: string, badge: VNode, body: VNode): VNode => {
    const sel = form.backend === backend;
    return (
      <div
        onClick={() => !sel && patch({ backend })}
        style={{
          borderRadius: 14, border: `1.5px solid ${sel ? 'var(--accent)' : 'var(--line)'}`,
          background: sel ? 'var(--surface)' : 'var(--paper)', padding: '13px 15px', cursor: sel ? 'default' : 'pointer',
          opacity: form.enabled ? 1 : 0.55, pointerEvents: form.enabled ? 'auto' : 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: sel ? 10 : 0 }}>
          <span style={{ width: 15, height: 15, borderRadius: 99, border: `1.5px solid ${sel ? 'var(--accent)' : 'var(--line)'}`, background: sel ? 'var(--accent)' : 'transparent', boxShadow: sel ? 'inset 0 0 0 3px var(--surface)' : 'none', flexShrink: 0 }} />
          <span style={{ fontFamily: 'var(--ui)', fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>{title}</span>
          {badge}
        </div>
        {sel && body}
      </div>
    );
  };

  return (
    <div
      onClick={onClose}
      style={{ position: 'absolute', inset: 0, zIndex: 60, background: 'rgba(30,22,16,.34)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: desk ? 'center' : 'flex-end', justifyContent: 'center' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: desk ? 480 : '100%', boxSizing: 'border-box', background: 'var(--surface)', borderRadius: desk ? 20 : '24px 24px 0 0', border: '1px solid var(--line)', padding: desk ? 26 : '20px 22px 30px', boxShadow: '0 20px 60px rgba(30,20,12,.3)', maxHeight: '90%', overflowY: 'auto' }}
      >
        {!desk && <div style={{ width: 38, height: 4, borderRadius: 9, background: 'var(--line)', margin: '0 auto 16px' }} />}
        <h3 style={{ fontFamily: 'var(--serif)', fontSize: 19, fontWeight: 500, color: 'var(--ink)', margin: '0 0 14px', display: 'flex', alignItems: 'center', gap: 9 }}>
          <Icon name="feather" size={18} color="var(--accent)" /> {t('assistant.settings.title')}
        </h3>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Master toggle */}
          <button
            onClick={() => patch({ enabled: !form.enabled })}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '12px 14px', borderRadius: 12, background: 'var(--paper)', border: '1px solid var(--line)', cursor: 'pointer', textAlign: 'start' }}
          >
            <div>
              <div style={{ fontFamily: 'var(--ui)', fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>{t('assistant.settings.enable')}</div>
              <div style={{ ...pStyle, fontSize: 12 }}>{t('assistant.settings.enableHint')}</div>
            </div>
            <span style={{ width: 38, height: 22, borderRadius: 99, flexShrink: 0, background: form.enabled ? 'var(--accent)' : 'var(--line)', position: 'relative', transition: 'background .15s' }}>
              <span style={{ position: 'absolute', top: 2, left: form.enabled ? 18 : 2, width: 18, height: 18, borderRadius: 99, background: 'var(--surface)', transition: 'left .15s' }} />
            </span>
          </button>

          {card(
            'ollama',
            'Ollama',
            ollamaLocal
              ? <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--accent-ink)', background: 'var(--accent-soft)', border: '1px solid var(--accent-line)', borderRadius: 6, padding: '2px 7px' }}>{t('assistant.badge.local')}</span>
              : <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--ink-3)', background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 6, padding: '2px 7px' }}>{t('assistant.badge.network')}</span>,
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {/* Only while the address really is loopback — this string says
                  "Nothing leaves this device", which the effective-host line
                  below would otherwise directly contradict. */}
              {ollamaLocal && <p style={pStyle}>{t('assistant.settings.ollamaHint')}</p>}
              <div>
                <span style={labelStyle}>{t('assistant.settings.serverUrl')}</span>
                <input style={inputStyle} value={form.ollama.baseUrl} onInput={(e) => patch({ ollama: { ...form.ollama, baseUrl: (e.target as HTMLInputElement).value } })} placeholder="http://localhost:11434" />
                {/* The effective destination, always. This setting syncs across
                    the vault's devices, so a value typed on one decides where
                    another ships decrypted entries — it must not be implicit. */}
                <p style={{ ...pStyle, fontSize: 11.5, marginTop: 6, color: ollamaLocal ? 'var(--ink-3)' : 'var(--accent-ink)' }}>
                  {t('assistant.settings.ollamaEffective', { host: ollamaHostLabel(form.ollama.baseUrl) })}
                </p>
                {ollamaScopeNow === 'invalid' && (
                  <p style={{ ...pStyle, fontSize: 11.5, marginTop: 4, color: 'var(--ink-3)' }}>
                    {t('assistant.settings.ollamaInvalidUrl', { host: ollamaHostLabel(form.ollama.baseUrl) })}
                  </p>
                )}
                {!ollamaLocal && (
                  <p style={{ ...pStyle, fontSize: 11.5, marginTop: 4, color: 'var(--accent-ink)' }}>
                    {t('assistant.settings.ollamaNotLocal')}
                  </p>
                )}
              </div>
              <div>
                <span style={labelStyle}>{t('assistant.settings.model')}</span>
                {models.length > 0 ? (
                  <select style={{ ...inputStyle, cursor: 'pointer' }} value={form.ollama.model} onChange={(e) => patch({ ollama: { ...form.ollama, model: (e.target as HTMLSelectElement).value } })}>
                    {models.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                ) : (
                  <input style={inputStyle} value={form.ollama.model} onInput={(e) => patch({ ollama: { ...form.ollama, model: (e.target as HTMLInputElement).value } })} placeholder={t('assistant.settings.ollamaModelPlaceholder')} />
                )}
              </div>
              <p style={{ ...pStyle, fontSize: 11.5, color: 'var(--ink-3)' }}>
                {t('assistant.settings.ollamaOriginsNote')}
              </p>
            </div>,
          )}

          {card(
            'anthropic',
            'Anthropic',
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--ink-3)', background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 6, padding: '2px 7px' }}>{t('assistant.badge.cloud')}</span>,
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '11px 13px', borderRadius: 12, background: 'var(--accent-soft)', border: '1px solid var(--accent-line)', fontFamily: 'var(--ui)', fontSize: 12.5, lineHeight: 1.5, color: 'var(--accent-ink)' }}>
                <Icon name="shield" size={16} color="var(--accent)" />
                <span>{cloudPrivacy()}</span>
              </div>
              <div>
                <span style={labelStyle}>{t('assistant.settings.apiKey')}</span>
                <input
                  style={inputStyle}
                  type="password"
                  autocomplete="off"
                  value={keyDirty ? form.anthropic.apiKey : '••••••••••••' + form.anthropic.apiKey.slice(-4)}
                  onFocus={() => { if (!keyDirty) { setKeyDirty(true); patch({ anthropic: { ...form.anthropic, apiKey: '' } }); } }}
                  onInput={(e) => patch({ anthropic: { ...form.anthropic, apiKey: (e.target as HTMLInputElement).value } })}
                  placeholder="sk-ant-…"
                />
              </div>
              <div>
                <span style={labelStyle}>Model</span>
                <select style={{ ...inputStyle, cursor: 'pointer' }} value={form.anthropic.model} onChange={(e) => patch({ anthropic: { ...form.anthropic, model: (e.target as HTMLSelectElement).value } })}>
                  {[...new Set([...ANTHROPIC_MODELS, form.anthropic.model])].map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
            </div>,
          )}

          {/* Speech-to-text for video/audio recordings — optional; off while the
              URL is empty. Any server speaking the OpenAI audio-transcriptions
              shape works: a loopback whisper server keeps recordings on-device,
              anything else is called out like the cloud chat backend. */}
          {form.enabled && (
            <div style={{ borderRadius: 14, border: '1px solid var(--line)', background: 'var(--paper)', padding: '13px 15px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontFamily: 'var(--ui)', fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>{t('assistant.transcribe.title')}</span>
                {trConfigured &&
                  (trScope === 'loopback' ? (
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--accent-ink)', background: 'var(--accent-soft)', border: '1px solid var(--accent-line)', borderRadius: 6, padding: '2px 7px' }}>{t('assistant.badge.local')}</span>
                  ) : (
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--ink-3)', background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 6, padding: '2px 7px' }}>{t('assistant.badge.network')}</span>
                  ))}
              </div>
              <p style={pStyle}>{t('assistant.transcribe.hint')}</p>
              <div>
                <span style={labelStyle}>{t('assistant.settings.serverUrl')}</span>
                <input
                  style={inputStyle}
                  value={tr.baseUrl}
                  onInput={(e) => patchTr({ baseUrl: (e.target as HTMLInputElement).value })}
                  placeholder={defaultTranscriptionSettings().baseUrl}
                />
                {trConfigured && (
                  <p style={{ ...pStyle, fontSize: 11.5, marginTop: 6, color: trScope === 'loopback' ? 'var(--ink-3)' : 'var(--accent-ink)' }}>
                    {t('assistant.transcribe.effective', { host: trResolved })}
                  </p>
                )}
                {trConfigured && trScope !== 'loopback' && (
                  <p style={{ ...pStyle, fontSize: 11.5, marginTop: 4, color: 'var(--accent-ink)' }}>
                    {t('assistant.transcribe.notLocal')}
                  </p>
                )}
              </div>
              {trConfigured && (
                <>
                  <div style={{ display: 'flex', gap: 10 }}>
                    <div style={{ flex: 1 }}>
                      <span style={labelStyle}>{t('assistant.settings.model')}</span>
                      <input
                        style={inputStyle}
                        value={tr.model}
                        onInput={(e) => patchTr({ model: (e.target as HTMLInputElement).value })}
                        placeholder={DEFAULT_TRANSCRIPTION_MODEL}
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <span style={labelStyle}>{t('assistant.settings.apiKey')}</span>
                      <input
                        style={inputStyle}
                        type="password"
                        autocomplete="off"
                        value={trKeyDirty ? tr.apiKey : '••••••••••••' + tr.apiKey.slice(-4)}
                        onFocus={() => { if (!trKeyDirty) { setTrKeyDirty(true); patchTr({ apiKey: '' }); } }}
                        onInput={(e) => patchTr({ apiKey: (e.target as HTMLInputElement).value })}
                        placeholder={t('assistant.transcribe.keyOptional')}
                      />
                    </div>
                  </div>
                  {trScope !== 'loopback' && (
                    <p style={{ ...pStyle, fontSize: 11.5, color: 'var(--ink-3)' }}>{t('assistant.transcribe.cspNote')}</p>
                  )}
                </>
              )}
            </div>
          )}

          {form.enabled && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Btn kind="ghost" size="sm" onClick={() => void runTest()}>{test.state === 'busy' ? t('assistant.settings.testing') : t('assistant.settings.test')}</Btn>
              {test.state === 'ok' && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: 'var(--ui)', fontSize: 12.5, color: 'var(--accent-ink)' }}><Icon name="check" size={14} color="var(--accent)" /> {t('assistant.settings.connected')}</span>}
              {test.state === 'fail' && <span style={{ fontFamily: 'var(--ui)', fontSize: 12.5, color: 'var(--ink-2)' }}>{test.message}</span>}
            </div>
          )}

          {error && <p style={{ ...pStyle, color: 'var(--accent-ink)' }}>{t('assistant.settings.saveFailed', { message: error })}</p>}

          <p style={{ ...pStyle, fontSize: 11.5, color: 'var(--ink-3)' }}>
            {t('assistant.settings.keyNote')}
          </p>

          <div style={{ display: 'flex', gap: 10 }}>
            <Btn kind="ghost" size="md" onClick={onClose} style={{ flex: 1 }}>{t('common.cancel')}</Btn>
            <Btn kind="primary" size="md" onClick={() => void save(form.enabled || aiSettings ? form : null)} style={{ flex: 2, opacity: saving ? 0.6 : 1 }}>
              {saving ? t('assistant.saving') : t('common.save')}
            </Btn>
          </div>
        </div>
      </div>
    </div>
  );
}
