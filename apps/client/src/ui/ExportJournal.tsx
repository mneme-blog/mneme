// Export-a-journal sheet. Pick a notebook; the whole thing — every entry, every
// recording — is decrypted, packed into one .zip on this device, and handed to
// the browser's downloads.
//
// Two things this screen has to be honest about, and says out loud:
//  • the archive is PLAINTEXT. That is the point of an export, and it is also
//    the moment the content leaves the protection the rest of the app provides.
//  • media that lives only on another device cannot be included. The run does
//    not fail over it; it reports the gap and says what to do about it.
//
// The download itself is deliberately belt-and-braces: the automatic click is
// the normal path, and a real, visible link to the same archive stays on the
// finished screen — a click a browser silently declines to honour must not be
// the difference between having your journal and not having it.
import type { JSX, VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon } from './Icon';
import { Btn } from './primitives';
import { Sheet } from './Sheet';
import { useAppData } from '../state/data';
import { exportJournal, type ExportProgress, type ExportResult } from '../export/journal';
import { APP_VERSION } from '../buildinfo';
import { t, tp } from '../i18n';

type Step = 'pick' | 'working' | 'done' | 'error';

const pStyle: JSX.CSSProperties = {
  fontFamily: 'var(--ui)',
  fontSize: 13.5,
  lineHeight: 1.55,
  color: 'var(--ink-2)',
  margin: 0,
};

export function ExportJournalSheet({ desk, onClose }: { desk: boolean; onClose: () => void }): VNode {
  const { journals, entries, mediaBlob } = useAppData();
  const [step, setStep] = useState<Step>('pick');
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [href, setHref] = useState('');
  const [error, setError] = useState('');

  // One object URL per finished archive, revoked when the sheet closes or a
  // second export replaces it — an un-revoked URL pins the whole archive in
  // memory, and these are the largest objects the app ever makes.
  const url = useRef('');
  const release = (): void => {
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = '';
  };
  useEffect(() => release, []);

  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.journalId, (counts.get(e.journalId) ?? 0) + 1);
  const options = journals.filter((j) => (counts.get(j.id) ?? 0) > 0);

  const run = async (journalId: string): Promise<void> => {
    release();
    setError('');
    setResult(null);
    setStep('working');
    setProgress({ done: 0, total: 0, current: '' });
    try {
      const out = await exportJournal(journalId, { journals, entries, mediaBlob }, setProgress, {
        appVersion: APP_VERSION,
      });
      url.current = URL.createObjectURL(out.blob);
      setHref(url.current);
      setResult(out);
      setStep('done');
      save(url.current, out.filename);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep('error');
    }
  };

  const body = ((): VNode => {
    if (step === 'working') {
      const pct = progress?.total ? Math.round((progress.done / progress.total) * 100) : 0;
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '6px 0' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
            <Icon name="download" size={26} color="var(--accent)" />
            <div style={{ fontFamily: 'var(--ui)', fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>
              {t('vault.export.working')}
            </div>
            <p style={{ ...pStyle, fontSize: 12.5, textAlign: 'center' }}>
              {progress?.current ? t('vault.export.writing', { name: progress.current }) : ' '}
            </p>
          </div>
          <div style={{ height: 8, borderRadius: 999, background: 'var(--paper)', border: '1px solid var(--line)', overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', transition: 'width .2s' }} />
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--ink-3)', textAlign: 'center' }}>
            {t('vault.export.progress', { n: progress?.done ?? 0, count: progress?.total ?? 0 })}
          </div>
        </div>
      );
    }

    if (step === 'done' && result) {
      const { counts: c } = result.manifest;
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
            <Icon name="check" size={26} color="var(--accent)" />
            <div style={{ fontFamily: 'var(--ui)', fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>
              {t('vault.export.done')}
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-3)', overflowWrap: 'anywhere', textAlign: 'center' }}>
              {result.filename}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontFamily: 'var(--ui)', fontSize: 13, color: 'var(--ink-2)' }}>
            <SummaryRow label={t('vault.export.sum.entries')} value={c.entries} />
            <SummaryRow label={t('vault.export.sum.media')} value={c.media} />
            {c.missingMedia > 0 && <SummaryRow label={t('vault.export.sum.missing')} value={c.missingMedia} muted />}
          </div>
          <p style={{ ...pStyle, fontSize: 12.5 }}>{t('vault.export.doneBody')}</p>
          {c.missingMedia > 0 && <p style={{ ...pStyle, fontSize: 12.5 }}>{t('vault.export.missingBody')}</p>}
          {/* The fallback that makes a blocked automatic download recoverable. */}
          <a
            href={href}
            download={result.filename}
            style={{ fontFamily: 'var(--ui)', fontSize: 12.5, color: 'var(--accent)', textAlign: 'center', textDecoration: 'underline' }}
          >
            {t('vault.export.manual')}
          </a>
          <div style={{ display: 'flex', gap: 10 }}>
            <Btn kind="ghost" size="md" onClick={() => { setStep('pick'); }} style={{ flex: 1 }}>
              {t('vault.export.again')}
            </Btn>
            <Btn kind="primary" size="md" onClick={onClose} style={{ flex: 2 }}>{t('common.done')}</Btn>
          </div>
        </div>
      );
    }

    if (step === 'error') {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={pStyle}>{t('vault.export.error')}</p>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-2)', padding: '10px 12px', borderRadius: 10, background: 'var(--paper)', border: '1px solid var(--line)', overflowWrap: 'anywhere' }}>
            {error}
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <Btn kind="ghost" size="md" onClick={onClose} style={{ flex: 1 }}>{t('common.close')}</Btn>
            <Btn kind="primary" size="md" onClick={() => setStep('pick')} style={{ flex: 2 }}>{t('common.back')}</Btn>
          </div>
        </div>
      );
    }

    // pick
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p style={pStyle}>{t('vault.export.pickBody')}</p>
        {options.length === 0 ? (
          <p style={{ ...pStyle, fontSize: 12.5, color: 'var(--ink-3)' }}>{t('vault.export.empty')}</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {options.map((j) => (
              <button
                key={j.id}
                type="button"
                onClick={() => void run(j.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'start',
                  padding: '11px 13px', borderRadius: 12, background: 'var(--paper)',
                  border: '1px solid var(--line)', cursor: 'pointer', font: 'inherit', color: 'inherit',
                }}
              >
                <Icon name="book" size={18} color="var(--accent)" />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontFamily: 'var(--ui)', fontSize: 13.5, fontWeight: 600, color: 'var(--ink)', overflowWrap: 'anywhere' }}>
                    {j.name}
                  </span>
                  <span style={{ display: 'block', fontFamily: 'var(--ui)', fontSize: 12, color: 'var(--ink-3)' }}>
                    {tp('vault.export.entries', counts.get(j.id) ?? 0)}
                  </span>
                </span>
                <Icon name="arrowR" size={16} color="var(--ink-3)" dirFlip />
              </button>
            ))}
          </div>
        )}
        <p style={{ ...pStyle, fontSize: 12.5 }}>{t('vault.export.readyBody')}</p>
        <p style={{ ...pStyle, fontSize: 12.5, color: 'var(--ink-3)' }}>{t('vault.export.plaintext')}</p>
      </div>
    );
  })();

  return (
    <Sheet
      desk={desk}
      onClose={step === 'working' ? undefined : onClose}
      scroll
      title={t('vault.export.title')}
      icon="download"
    >
      {body}
    </Sheet>
  );
}

/** Hand the archive to the browser's downloads. */
function save(href: string, filename: string): void {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function SummaryRow({ label, value, muted }: { label: string; value: number; muted?: boolean }): VNode {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '7px 12px', borderRadius: 10, background: 'var(--paper)', border: '1px solid var(--line)' }}>
      <span style={{ color: muted ? 'var(--ink-3)' : 'var(--ink-2)' }}>{label}</span>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 600, color: muted ? 'var(--ink-3)' : 'var(--ink)' }}>{value}</span>
    </div>
  );
}
