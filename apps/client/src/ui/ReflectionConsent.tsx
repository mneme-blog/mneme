// The one-time opt-in for the deeper interview questions (ai/reflection.ts).
//
// Shown once per device, the first time an AI interview is started — written or
// on camera. It is a consent screen, not an announcement, so it says three
// things before it asks: what the questions do, what is selected to make them
// work, and where that text ends up. The destination line is driven by the live
// provider, exactly like ProviderBadge: under a local backend nothing leaves
// the device, and saying otherwise would be as wrong as hiding it under a cloud
// one.
//
// Declining is a real answer — it is recorded, so the overlay does not come
// back — and either answer can be changed later in Preferences → Assistant.
import type { VNode } from 'preact';
import { Icon } from './Icon';
import { Btn } from './primitives';
import { ProviderBadge } from './ProviderBadge';
import { Sheet, Z } from './Sheet';
import { t } from '../i18n';
import type { AiProvider } from '../ai/types';
import { setDeepReflection } from '../ai/reflection';

function Bullet({ icon, title, body }: { icon: 'clock' | 'feather'; title: string; body: string }): VNode {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
      <span style={{ width: 26, height: 26, borderRadius: 999, flexShrink: 0, marginTop: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--accent-soft)' }}>
        <Icon name={icon} size={14} color="var(--accent-ink)" />
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--ui)', fontSize: 13.5, fontWeight: 600, color: 'var(--ink)' }}>{title}</div>
        <div style={{ fontFamily: 'var(--ui)', fontSize: 12.5, lineHeight: 1.5, color: 'var(--ink-2)', marginTop: 2 }}>{body}</div>
      </div>
    </div>
  );
}

export function ReflectionConsent({
  provider,
  onDecide,
}: {
  provider: AiProvider;
  /** Called with the recorded answer; the caller then starts the interview. */
  onDecide: (on: boolean) => void;
}): VNode {
  const decide = (on: boolean): void => {
    setDeepReflection(on);
    onDecide(on);
  };
  return (
    // No onClose: a backdrop tap must not count as either answer. The two
    // buttons are the only way out, and both of them are a decision.
    <Sheet center role="dialog" zIndex={Z.dialog} dim="strong" width={430} scroll>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <span style={{ width: 36, height: 36, borderRadius: 999, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--accent-soft)' }}>
          <Icon name="mic" size={17} color="var(--accent-ink)" />
        </span>
        <h3 style={{ fontFamily: 'var(--serif)', fontSize: 19, fontWeight: 500, color: 'var(--ink)', margin: 0 }}>
          {t('assistant.reflect.title')}
        </h3>
      </div>

      <p style={{ fontFamily: 'var(--ui)', fontSize: 13.5, lineHeight: 1.55, color: 'var(--ink-2)', margin: '0 0 14px' }}>
        {t('assistant.reflect.intro')}
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 11, marginBottom: 14 }}>
        <Bullet icon="clock" title={t('assistant.reflect.gapTitle')} body={t('assistant.reflect.gapBody')} />
        <Bullet icon="feather" title={t('assistant.reflect.olderTitle')} body={t('assistant.reflect.olderBody')} />
      </div>

      {/* What it means for the data. The first line is true on every backend;
          the second is the one that changes with where the model runs. */}
      <div style={{ borderRadius: 12, border: '1px solid var(--line)', background: 'var(--paper)', padding: '12px 14px', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 6 }}>
          <span style={{ fontFamily: 'var(--ui)', fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: 'var(--ink-3)' }}>
            {t('assistant.reflect.dataLabel')}
          </span>
          <ProviderBadge provider={provider} />
        </div>
        <p style={{ fontFamily: 'var(--ui)', fontSize: 12.5, lineHeight: 1.55, color: 'var(--ink-2)', margin: 0 }}>
          {t('assistant.reflect.dataOnDevice')}
        </p>
        <p style={{ fontFamily: 'var(--ui)', fontSize: 12.5, lineHeight: 1.55, color: provider.local ? 'var(--ink-2)' : 'var(--accent-ink)', margin: '6px 0 0' }}>
          {provider.local ? t('assistant.reflect.dataLocal') : t('assistant.reflect.dataCloud')}
        </p>
      </div>

      <p style={{ fontFamily: 'var(--ui)', fontSize: 12, lineHeight: 1.5, color: 'var(--ink-3)', margin: '0 0 16px' }}>
        {t('assistant.reflect.changeLater')}
      </p>

      <div style={{ display: 'flex', gap: 10 }}>
        <Btn kind="ghost" size="md" onClick={() => decide(false)} style={{ flex: 1 }}>
          {t('assistant.reflect.decline')}
        </Btn>
        <Btn kind="primary" size="md" onClick={() => decide(true)} style={{ flex: 1 }}>
          {t('assistant.reflect.accept')}
        </Btn>
      </div>
    </Sheet>
  );
}
