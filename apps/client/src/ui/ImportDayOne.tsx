// Import-from-Day-One sheet. The user picks the JSON export .zip; we parse it
// locally (nothing is uploaded), show a summary, then create encrypted entries +
// media through the normal app surface. Day One journals become Mneme notebooks.
//
// All work is local and client-side: the zip never leaves the device, and each
// imported entry/media file is encrypted on the way into the vault exactly like
// hand-authored content.
import type { JSX, VNode } from 'preact';
import { useState } from 'preact/hooks';
import { Icon } from './Icon';
import { Btn } from './primitives';
import { Sheet } from './Sheet';
import { useAppData } from '../state/data';
import { parseDayOneArchive, type DayOneArchive } from '../import/dayone';
import { importDayOne, type ImportProgress, type ImportSummary } from '../import/run';
import { t, tp } from '../i18n';

type Step = 'pick' | 'ready' | 'working' | 'done' | 'error';

const pStyle: JSX.CSSProperties = { fontFamily: 'var(--ui)', fontSize: 13.5, lineHeight: 1.55, color: 'var(--ink-2)', margin: 0 };

export function ImportDayOneSheet({ desk, onClose }: { desk: boolean; onClose: () => void }): VNode {
  const { journals, newJournal, createEntry, updateEntry, addMedia } = useAppData();
  const [step, setStep] = useState<Step>('pick');
  const [archive, setArchive] = useState<DayOneArchive | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);

  const busy = step === 'working';

  const onFile = async (file: File): Promise<void> => {
    setError('');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parsed = parseDayOneArchive(bytes);
      setArchive(parsed);
      setStep('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep('error');
    }
  };

  const run = async (): Promise<void> => {
    if (!archive) return;
    setStep('working');
    setProgress({ done: 0, total: archive.entryCount, current: '' });
    try {
      const result = await importDayOne(archive, { journals, newJournal, createEntry, updateEntry, addMedia }, setProgress);
      setSummary(result);
      setStep('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep('error');
    }
  };

  const body = ((): VNode => {
    if (step === 'working') {
      const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '6px 0' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
            <Icon name="download" size={26} color="var(--accent)" />
            <div style={{ fontFamily: 'var(--ui)', fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>{t('vault.import.working')}</div>
            <p style={{ ...pStyle, fontSize: 12.5, textAlign: 'center' }}>
              {progress?.current ? t('vault.import.writing', { title: progress.current }) : t('vault.import.encrypting')}
            </p>
          </div>
          <div style={{ height: 8, borderRadius: 999, background: 'var(--paper)', border: '1px solid var(--line)', overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', transition: 'width .2s' }} />
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--ink-3)', textAlign: 'center' }}>
            {tp('vault.import.progress', progress?.total ?? 0, { n: progress?.done ?? 0 })}
          </div>
        </div>
      );
    }

    if (step === 'done' && summary) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
            <Icon name="check" size={26} color="var(--accent)" />
            <div style={{ fontFamily: 'var(--ui)', fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>{t('vault.import.done')}</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontFamily: 'var(--ui)', fontSize: 13, color: 'var(--ink-2)' }}>
            <SummaryRow label={t('vault.import.sum.entries')} value={summary.entries} />
            <SummaryRow label={t('vault.import.sum.journals')} value={summary.journals} />
            <SummaryRow label={t('vault.import.sum.media')} value={summary.media} />
            {summary.skippedMedia > 0 && <SummaryRow label={t('vault.import.sum.skipped')} value={summary.skippedMedia} muted />}
          </div>
          <p style={{ ...pStyle, fontSize: 12.5 }}>{t('vault.import.doneBody')}</p>
          <Btn kind="primary" size="md" onClick={onClose}>{t('common.done')}</Btn>
        </div>
      );
    }

    if (step === 'error') {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={pStyle}>{t('vault.import.error')}</p>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-2)', padding: '10px 12px', borderRadius: 10, background: 'var(--paper)', border: '1px solid var(--line)', overflowWrap: 'anywhere' }}>{error}</div>
          <div style={{ display: 'flex', gap: 10 }}>
            <Btn kind="ghost" size="md" onClick={onClose} style={{ flex: 1 }}>{t('common.close')}</Btn>
            <Btn kind="primary" size="md" onClick={() => { setStep('pick'); setArchive(null); setError(''); }} style={{ flex: 2 }}>{t('vault.import.pickAnother')}</Btn>
          </div>
        </div>
      );
    }

    if (step === 'ready' && archive) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <p style={pStyle}>{t('vault.import.readyLead')}</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontFamily: 'var(--ui)', fontSize: 13, color: 'var(--ink-2)' }}>
            <SummaryRow label={t('vault.import.row.notebooks')} value={archive.journals.length} />
            <SummaryRow label={t('vault.import.row.entries')} value={archive.entryCount} />
            <SummaryRow label={t('vault.import.row.media')} value={archive.mediaCount} />
          </div>
          <p style={{ ...pStyle, fontSize: 12.5 }}>{t('vault.import.readyBody')}</p>
          <div style={{ display: 'flex', gap: 10 }}>
            <Btn kind="ghost" size="md" onClick={() => { setStep('pick'); setArchive(null); }} style={{ flex: 1 }}>{t('common.back')}</Btn>
            <Btn kind="primary" size="md" onClick={() => void run()} style={{ flex: 2 }}>{tp('vault.import.cta', archive.entryCount)}</Btn>
          </div>
        </div>
      );
    }

    // pick
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p style={pStyle}>{t('vault.import.pickBody')}</p>
        <label
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const f = e.dataTransfer?.files?.[0];
            if (f) void onFile(f);
          }}
          style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '28px 18px', borderRadius: 14,
            border: `1.5px dashed ${dragOver ? 'var(--accent)' : 'var(--line)'}`, background: dragOver ? 'var(--accent-soft)' : 'var(--paper)',
            cursor: 'pointer', textAlign: 'center',
          }}
        >
          <Icon name="download" size={24} color="var(--accent)" />
          <span style={{ fontFamily: 'var(--ui)', fontSize: 13.5, fontWeight: 600, color: 'var(--ink)' }}>{t('vault.import.dropTitle')}</span>
          <span style={{ fontFamily: 'var(--ui)', fontSize: 12, color: 'var(--ink-3)' }}>{t('vault.import.dropHint')}</span>
          <input
            type="file"
            accept=".zip,application/zip"
            style={{ display: 'none' }}
            onChange={(e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) void onFile(f); }}
          />
        </label>
      </div>
    );
  })();

  return (
    <Sheet desk={desk} onClose={busy ? undefined : onClose} scroll title={t('vault.import.title')} icon="download">
      {body}
    </Sheet>
  );
}

function SummaryRow({ label, value, muted }: { label: string; value: number; muted?: boolean }): VNode {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '7px 12px', borderRadius: 10, background: 'var(--paper)', border: '1px solid var(--line)' }}>
      <span style={{ color: muted ? 'var(--ink-3)' : 'var(--ink-2)' }}>{label}</span>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 600, color: muted ? 'var(--ink-3)' : 'var(--ink)' }}>{value}</span>
    </div>
  );
}
