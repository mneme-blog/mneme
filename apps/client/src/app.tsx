import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Icon, type IconName } from './ui/Icon';
import { Wordmark } from './ui/Wordmark';
import { ConnectionDot, connLabel, SyncProgressBar } from './ui/primitives';
import { useIsDesktop } from './hooks/useMediaQuery';
import { useTheme } from './hooks/useTheme';
import { useAppData, type SyncStatus } from './state/data';
import type { Journal } from './data/sample';
import type { TemplateRecord } from './sync/engine';
import { Onboarding } from './screens/Onboarding';
import { JournalsScreen, NewJournalSheet, EditJournalSheet } from './screens/Journals';
import { JournalEntriesScreen } from './screens/JournalEntries';
import { CalendarScreen } from './screens/Calendar';
import { EditorScreen } from './screens/Editor';
import { RotatePhraseSheet } from './ui/RotatePhrase';
import { DeleteVaultSheet } from './ui/DeleteVault';
import { DeviceUnlockSheet } from './ui/DeviceUnlock';
import { ImportDayOneSheet } from './ui/ImportDayOne';
import { TemplatesSheet } from './ui/Templates';
import { SearchSheet } from './ui/Search';
import { PreferencesSheet } from './ui/Preferences';
import { PendingApproval } from './ui/PendingApproval';
import { DeleteJournalSheet } from './ui/DeleteJournal';
import { AiSettingsSheet } from './ui/AiSettings';
import { AskJournalSheet } from './ui/AskJournal';
import { GuidedInterviewSheet } from './ui/GuidedInterview';
import { InterviewTypesSheet } from './ui/InterviewTypes';
import { VideoInterviewSheet } from './ui/VideoInterview';
import { ComposeChooser } from './ui/ComposeChooser';
import { BadgeCelebration } from './ui/BadgeCelebration';
import { useBadges } from './hooks/useBadges';
import type { InterviewType } from './sync/engine';
import { t } from './i18n';

// 'journal' is the mobile-only drill-in: the entry list of one notebook.
type Flow = 'journals' | 'journal' | 'calendar' | 'editor';

// ── DESKTOP sidebar ─────────────────────────────────────────
function Sidebar({ flow, setFlow, journals, activeJournalId, onNew, onOpenJournal, status, ownerId, onTemplates, onSearch, onPreferences, onAsk, onInterview }: {
  flow: Flow;
  setFlow: (f: Flow) => void;
  journals: Journal[];
  /** Notebook the editor's open entry belongs to — that row lights up instead of "Write". */
  activeJournalId: string | null;
  /** The primary CTA — start a fresh entry (in the active notebook if there is one). */
  onNew: () => void;
  onOpenJournal: (j: Journal) => void;
  status: SyncStatus;
  ownerId: string | null;
  onTemplates: () => void;
  onSearch: () => void;
  onPreferences: () => void;
  /** null while the AI assistant is disabled — the row hides itself. */
  onAsk: (() => void) | null;
  /** null while the AI assistant is disabled — the row hides itself. */
  onInterview: (() => void) | null;
}): VNode {
  // Fold the outbox depth into the footer so a sync in progress (e.g. just after
  // a bulk import) is visible from every screen, not only the journals list.
  const { pendingCount, saving } = useAppData();
  const syncing = status === 'online' && (saving || pendingCount > 0);
  const nav = (key: Flow, icon: IconName, label: string): VNode => {
    const active = flow === key;
    return (
      <button
        onClick={() => setFlow(key)}
        style={{ display: 'flex', alignItems: 'center', gap: 11, width: '100%', textAlign: 'start', cursor: 'pointer', padding: '9px 11px', borderRadius: 10, border: 'none', background: active ? 'var(--accent-soft)' : 'transparent', color: active ? 'var(--accent-ink)' : 'var(--ink-2)', fontFamily: 'var(--ui)', fontSize: 14, fontWeight: active ? 600 : 500 }}
        onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--surface)'; }}
        onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
      >
        <Icon name={icon} size={19} /> {label}
      </button>
    );
  };
  return (
    <div style={{ width: 238, flexShrink: 0, borderInlineEnd: '1px solid var(--line)', background: 'var(--surface-2)', display: 'flex', flexDirection: 'column', padding: '18px 14px' }}>
      <div style={{ padding: '4px 8px 18px' }}><Wordmark size={22} /></div>

      {/* Primary CTA — the clear, present way to begin a journal entry. Accent
          fill (matching the mobile compose FAB) so it reads as THE action. */}
      <button
        onClick={onNew}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%', boxSizing: 'border-box', cursor: 'pointer', padding: '11px 14px', marginBottom: 10, borderRadius: 11, border: 'none', background: 'var(--accent)', color: '#fff', fontFamily: 'var(--ui)', fontSize: 14, fontWeight: 600, boxShadow: '0 2px 8px rgba(120,60,30,.28)' }}
        onMouseEnter={(e) => { e.currentTarget.style.filter = 'brightness(1.05)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.filter = 'none'; }}
      >
        <Icon name="plus" size={18} color="#fff" /> {t('shell.newEntry')}
      </button>

      {/* Search field — opens the vault-wide search palette (also ⌘/Ctrl+K). */}
      <button
        onClick={onSearch}
        style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', boxSizing: 'border-box', cursor: 'text', padding: '8px 11px', marginBottom: 10, borderRadius: 10, border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--ink-3)', fontFamily: 'var(--ui)', fontSize: 13.5, textAlign: 'left' }}
        onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--accent-line)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--line)'; }}
      >
        <Icon name="search" size={16} />
        <span style={{ flex: 1 }}>{t('common.search')}</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, border: '1px solid var(--line)', borderRadius: 6, padding: '1px 5px' }}>⌘K</span>
      </button>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {nav('journals', 'books', t('shell.nav.journals'))}
        {nav('calendar', 'cal', t('shell.nav.calendar'))}
        {/* Templates open as a sheet, not a flow — styled to match the nav rows. */}
        <button
          onClick={onTemplates}
          style={{ display: 'flex', alignItems: 'center', gap: 11, width: '100%', textAlign: 'start', cursor: 'pointer', padding: '9px 11px', borderRadius: 10, border: 'none', background: 'transparent', color: 'var(--ink-2)', fontFamily: 'var(--ui)', fontSize: 14, fontWeight: 500 }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          <Icon name="copy" size={19} /> {t('shell.nav.templates')}
        </button>
        {/* Only when the AI assistant is enabled (ui/AiSettings.tsx) — a sheet, like Templates. */}
        {onAsk && (
          <button
            onClick={onAsk}
            style={{ display: 'flex', alignItems: 'center', gap: 11, width: '100%', textAlign: 'start', cursor: 'pointer', padding: '9px 11px', borderRadius: 10, border: 'none', background: 'transparent', color: 'var(--ink-2)', fontFamily: 'var(--ui)', fontSize: 14, fontWeight: 500 }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <Icon name="feather" size={19} /> {t('shell.nav.ask')}
          </button>
        )}
        {onInterview && (
          <button
            onClick={onInterview}
            style={{ display: 'flex', alignItems: 'center', gap: 11, width: '100%', textAlign: 'start', cursor: 'pointer', padding: '9px 11px', borderRadius: 10, border: 'none', background: 'transparent', color: 'var(--ink-2)', fontFamily: 'var(--ui)', fontSize: 14, fontWeight: 500 }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <Icon name="mic" size={19} /> {t('shell.nav.interview')}
          </button>
        )}
      </div>

      <div style={{ fontFamily: 'var(--ui)', fontSize: 11, fontWeight: 700, letterSpacing: 0.7, textTransform: 'uppercase', color: 'var(--ink-3)', padding: '20px 10px 8px' }}>{t('shell.notebooks')}</div>
      <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 1 }}>
        {journals.map((j) => {
          const active = activeJournalId === j.id;
          return (
            <button
              key={j.id}
              onClick={() => onOpenJournal(j)}
              style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'start', cursor: 'pointer', padding: '8px 10px', borderRadius: 9, border: 'none', background: active ? 'var(--accent-soft)' : 'transparent', color: active ? 'var(--accent-ink)' : 'var(--ink)', fontFamily: 'var(--ui)', fontSize: 13.5, fontWeight: active ? 600 : 500 }}
              onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--surface)'; }}
              onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
            >
              <span style={{ width: 11, height: 11, borderRadius: 3, background: j.color, flexShrink: 0 }} />
              <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{j.name}</span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: active ? 'var(--accent-ink)' : 'var(--ink-3)' }}>{j.count}</span>
            </button>
          );
        })}
      </div>

      {/* Footer: the identity row IS the preferences button — every vault
          action (lock, rotate, delete, AI, appearance) lives in the dialog. */}
      <div style={{ borderTop: '1px solid var(--line)', paddingTop: 10, marginTop: 8 }}>
        {syncing && <div style={{ marginBottom: 10 }}><SyncProgressBar /></div>}
        <button
          title={t('shell.preferences')}
          onClick={onPreferences}
          style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'start', cursor: 'pointer', padding: '7px 8px', borderRadius: 12, border: 'none', background: 'transparent' }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          <div style={{ width: 32, height: 32, borderRadius: 999, flexShrink: 0, background: 'linear-gradient(145deg, var(--accent), var(--accent-ink))', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontFamily: 'var(--serif)', fontSize: 15, fontWeight: 600 }}>V</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            {/* Truncated like the admin dashboard's vault label (full id +
                actions live in the preferences dialog). */}
            <div style={{ fontFamily: 'var(--mono)', fontSize: 12.5, fontWeight: 600, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {ownerId ? `${ownerId.slice(0, 8)}…` : t('shell.yourVault')}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              {syncing ? (
                <span class="mneme-pulse" style={{ width: 7, height: 7, borderRadius: 999, background: 'var(--accent)', flexShrink: 0, display: 'inline-block' }} />
              ) : (
                <ConnectionDot status={status} size={7} />
              )}
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)' }}>{syncing ? (pendingCount > 0 ? t('shell.footer.syncingCount', { count: pendingCount }) : t('shell.footer.syncing')) : connLabel(status).toLowerCase()}</span>
            </div>
          </div>
          <Icon name="settings" size={17} color="var(--ink-3)" />
        </button>
      </div>
    </div>
  );
}

// ── MOBILE bottom nav ───────────────────────────────────────
function MobileNav({ flow, setFlow, onCompose, onSettings, onSearch }: {
  flow: Flow;
  setFlow: (f: Flow) => void;
  onCompose: () => void;
  onSettings: () => void;
  onSearch: () => void;
}): VNode {
  const item = (active: boolean, icon: IconName, label: string, onClick: () => void): VNode => (
    <button
      onClick={onClick}
      style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px 0', color: active ? 'var(--accent-ink)' : 'var(--ink-3)' }}
    >
      <Icon name={icon} size={23} stroke={active ? 2 : 1.7} />
      <span style={{ fontFamily: 'var(--ui)', fontSize: 10.5, fontWeight: active ? 700 : 500 }}>{label}</span>
    </button>
  );
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 40, paddingBottom: 22, paddingTop: 8, display: 'flex', alignItems: 'center', background: 'var(--surface-glass)', backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)', borderTop: '1px solid var(--line)' }}>
      {/* Sync progress rides the top edge of the bar — self-hides when fully synced. */}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 0 }}><SyncProgressBar flush /></div>
      {item(flow === 'journals', 'books', t('shell.nav.journals'), () => setFlow('journals'))}
      {item(flow === 'calendar', 'cal', t('shell.nav.calendar'), () => setFlow('calendar'))}
      <div style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
        <button onClick={onCompose} style={{ width: 54, height: 54, borderRadius: 999, background: 'var(--accent)', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: -22, boxShadow: '0 6px 18px rgba(120,60,30,.35), 0 0 0 5px var(--paper)' }}>
          <Icon name="feather" size={24} color="#fff" />
        </button>
      </div>
      {item(false, 'search', t('common.search'), onSearch)}
      {item(false, 'settings', t('common.settings'), onSettings)}
    </div>
  );
}

export function App(): VNode {
  const desk = useIsDesktop();
  const theme = useTheme();
  const { status, hasVault, vaultMethod, ownerId, pendingApproval, approvalHint, retryApproval, bootstrapping, entries, journals, templates, aiSettings, newJournal, updateJournal, deleteJournal, signIn, unlock, unlockWithKey, setDeviceUnlock, lock, createEntry, rotatePhrase, deleteVault } = useAppData();
  // Gamification badges: derived from the decrypted entries; celebrates one
  // newly earned badge at a time (state/badges.ts, quiet catch-up on first run).
  const badges = useBadges();
  const [flow, setFlowRaw] = useState<Flow>('journals');
  const [modal, setModal] = useState(false);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [deleteVaultOpen, setDeleteVaultOpen] = useState(false);
  const [deviceUnlockOpen, setDeviceUnlockOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [interviewOpen, setInterviewOpen] = useState(false);
  const [interviewTypesOpen, setInterviewTypesOpen] = useState(false);
  // The on-camera interview: same types, answered as video clips. Reached from
  // the written interview's picker (and the mobile compose chooser), so it
  // carries the type that was chosen there.
  const [videoInterview, setVideoInterview] = useState<{ start?: InterviewType; journalId?: string } | null>(null);
  // Mobile compose chooser (the feather FAB) + the interview it picked (the
  // preselected start plus the notebook the FAB was in).
  const [composeOpen, setComposeOpen] = useState(false);
  const [interviewStart, setInterviewStart] = useState<{ start: InterviewType | 'freeform'; journalId?: string } | null>(null);
  // Which notebook the typed-"delete" confirmation sheet is for (null → closed).
  const [deleteJournalId, setDeleteJournalId] = useState<string | null>(null);
  const [editJournalId, setEditJournalId] = useState<string | null>(null);
  // Which entry the editor is currently editing (null → editor shows its empty state).
  const [openEntryId, setOpenEntryId] = useState<string | null>(null);
  // Which notebook the mobile 'journal' flow is showing.
  const [openJournalId, setOpenJournalId] = useState<string | null>(null);
  // Where the mobile editor's back button returns to (the flow it was entered from).
  const [editorReturn, setEditorReturn] = useState<Flow>('journals');

  // ⌘/Ctrl+K opens search from anywhere (once unlocked).
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'k') {
        ev.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // App never unmounts across a lock — the locked branch is an early return, so
  // every open sheet/flow would otherwise survive into the next unlock (e.g.
  // deleting a vault leaves the Delete-vault sheet armed, then re-shows it over
  // the freshly created vault). Reset all transient UI when the vault locks so
  // each unlock — same vault or a brand-new one — starts on a clean slate.
  useEffect(() => {
    if (status !== 'locked') return;
    setFlowRaw('journals');
    setModal(false);
    setRotateOpen(false);
    setDeleteVaultOpen(false);
    setDeviceUnlockOpen(false);
    setImportOpen(false);
    setTemplatesOpen(false);
    setPrefsOpen(false);
    setSearchOpen(false);
    setAiSettingsOpen(false);
    setAskOpen(false);
    setInterviewOpen(false);
    setInterviewTypesOpen(false);
    setComposeOpen(false);
    setInterviewStart(null);
    setDeleteJournalId(null);
    setOpenEntryId(null);
    setOpenJournalId(null);
    setEditorReturn('journals');
  }, [status]);

  // Locked until a mnemonic — or the passphrase over a sealed seed — unlocks an
  // in-memory identity. Hold rendering until the keystore check resolves so a
  // device with a sealed seed starts on the unlock view, not a welcome flash.
  if (status === 'locked') {
    if (hasVault === null) return <div style={{ height: '100%', background: 'var(--paper)' }} />;
    return (
      <div style={{ height: '100%' }}>
        <Onboarding desk={desk} hasVault={hasVault} unlockMethod={vaultMethod} onEnter={signIn} onUnlock={unlock} onUnlockWithKey={unlockWithKey} />
      </div>
    );
  }

  // The relay (REQUIRE_APPROVAL) accepted this device but the operator hasn't
  // approved the vault yet — block the app behind the pending screen until they do.
  if (pendingApproval) {
    return (
      <PendingApproval
        hint={approvalHint}
        checking={status === 'connecting'}
        onRetry={retryApproval}
        onSignOut={lock}
      />
    );
  }

  const setFlow = (f: Flow) => setFlowRaw(f);

  // Open an existing entry in the editor, remembering which flow to return to.
  const openEntry = (id: string) => {
    if (flow !== 'editor') setEditorReturn(flow);
    setOpenEntryId(id);
    setFlow('editor');
  };

  // Create a fresh empty entry (encrypted + queued for the relay) and open it.
  const newEntry = (journalId?: string) => {
    const entry = createEntry({ journalId: journalId ?? journals[0]?.id ?? 'j-personal' });
    openEntry(entry.id);
  };

  // Start a new entry pre-filled from a template ("Use" in the templates sheet,
  // or a "Start from" pick when creating a journal).
  const newEntryFromTemplate = (t: TemplateRecord, journalId?: string) => {
    const entry = createEntry({
      journalId: journalId ?? journals[0]?.id ?? 'j-personal',
      bodyJson: t.bodyJson,
      bodyText: t.bodyText,
    });
    openEntry(entry.id);
  };

  // Opening a notebook: on mobile it drills into the notebook's entry list (the
  // editor is full-screen there, so jumping straight into the latest entry left
  // no way to browse or pick another one). On desktop it jumps to the most
  // recent entry — the editor's left pane already shows the journal-scoped list.
  // While the first sync is still running, an empty notebook stays on the
  // journals screen on desktop (the syncing notice explains why) instead of
  // silently creating a blank entry for content that just hasn't arrived yet.
  const openJournal = (j: Journal) => {
    if (!desk) {
      setOpenJournalId(j.id);
      setFlow('journal');
      return;
    }
    const latest = entries.filter((e) => e.journalId === j.id).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (latest) openEntry(latest.id);
    else if (!bootstrapping) newEntry(j.id);
  };

  const openJournalObj = journals.find((j) => j.id === openJournalId);

  // While the editor is open, the active context is the notebook its entry lives
  // in — the sidebar lights that row instead of the redundant "Write" item.
  const activeJournalId =
    flow === 'editor' ? entries.find((e) => e.id === openEntryId)?.journalId ?? null : null;

  const screen = (() => {
    if (flow === 'calendar') return <CalendarScreen desk={desk} onOpenEntry={(id) => (id ? openEntry(id) : newEntry())} />;
    if (flow === 'editor') {
      return (
        <EditorScreen
          desk={desk}
          entryId={openEntryId}
          onBack={() => setFlow(editorReturn)}
          onSelectEntry={openEntry}
          onNew={newEntry}
          // Mobile delete: return to the notebook's own entry list, not the
          // library — the journal you were writing in stays the active context.
          onDeleted={(journalId) => {
            const j = journalId ? journals.find((x) => x.id === journalId) : undefined;
            if (j) {
              setOpenJournalId(j.id);
              setFlow('journal');
            } else {
              setFlow('journals');
            }
          }}
        />
      );
    }
    if (flow === 'journal' && !desk && openJournalObj) {
      return (
        <JournalEntriesScreen
          journal={openJournalObj}
          onBack={() => setFlow('journals')}
          onOpenEntry={openEntry}
          onNew={() => newEntry(openJournalObj.id)}
          onEdit={() => setEditJournalId(openJournalObj.id)}
          onDelete={() => setDeleteJournalId(openJournalObj.id)}
          syncing={bootstrapping}
        />
      );
    }
    return <JournalsScreen desk={desk} journals={journals} onOpen={openJournal} onNew={() => setModal(true)} onEdit={(j) => setEditJournalId(j.id)} onDelete={(j) => setDeleteJournalId(j.id)} onSearch={() => setSearchOpen(true)} onSettings={() => setPrefsOpen(true)} syncing={bootstrapping} />;
  })();

  // A picked result closes the palette and opens the entry in the editor.
  const searchSheet = searchOpen && (
    <SearchSheet desk={desk} onClose={() => setSearchOpen(false)} onOpen={(id) => { setSearchOpen(false); openEntry(id); }} />
  );

  // The sheet's warning copy needs the live journal (name + entry count).
  const deleteJournalTarget = journals.find((j) => j.id === deleteJournalId);
  const deleteJournalSheet = deleteJournalTarget && (
    <DeleteJournalSheet
      desk={desk}
      journal={deleteJournalTarget}
      onClose={() => setDeleteJournalId(null)}
      onDelete={() => {
        deleteJournal(deleteJournalTarget.id);
        setDeleteJournalId(null);
        // The mobile drill-in was showing this notebook — return to the library.
        if (flow === 'journal' && openJournalId === deleteJournalTarget.id) setFlow('journals');
      }}
    />
  );

  const editJournalTarget = journals.find((j) => j.id === editJournalId);
  const editJournalSheet = editJournalTarget && (
    <EditJournalSheet
      desk={desk}
      journal={editJournalTarget}
      onClose={() => setEditJournalId(null)}
      onSave={(patch) => {
        updateJournal(editJournalTarget.id, patch);
        setEditJournalId(null);
      }}
    />
  );

  const onCreateJournal = (j: Journal, template?: TemplateRecord) => {
    newJournal(j);
    setModal(false);
    // "Start from" a template → the journal opens straight into its first entry.
    if (template) newEntryFromTemplate(template, j.id);
  };

  if (desk) {
    return (
      <div style={{ height: '100%', display: 'flex', background: 'var(--paper)', position: 'relative' }}>
        <Sidebar flow={flow} setFlow={setFlow} journals={journals} activeJournalId={activeJournalId} onNew={() => newEntry(activeJournalId ?? undefined)} onOpenJournal={openJournal} status={status} ownerId={ownerId} onTemplates={() => setTemplatesOpen(true)} onSearch={() => setSearchOpen(true)} onPreferences={() => setPrefsOpen(true)} onAsk={aiSettings?.enabled ? () => setAskOpen(true) : null} onInterview={aiSettings?.enabled ? () => setInterviewOpen(true) : null} />
        <div style={{ flex: 1, minWidth: 0 }}>{screen}</div>
        {/* Non-modal companions: flex siblings, so the app stays usable beside them. */}
        {askOpen && <AskJournalSheet desk onClose={() => setAskOpen(false)} />}
        {interviewOpen && <GuidedInterviewSheet desk onClose={() => setInterviewOpen(false)} onOpenEntry={openEntry} onManageTypes={() => setInterviewTypesOpen(true)} onVideo={(it) => setVideoInterview({ start: it })} />}
        {videoInterview && <VideoInterviewSheet desk onClose={() => setVideoInterview(null)} onOpenEntry={openEntry} onManageTypes={() => setInterviewTypesOpen(true)} initial={videoInterview.start} journalId={videoInterview.journalId} />}
        {searchSheet}
        {deleteJournalSheet}
        {editJournalSheet}
        {prefsOpen && <PreferencesSheet desk theme={theme} onClose={() => setPrefsOpen(false)} ownerId={ownerId} status={status} onLock={lock} onRotate={() => setRotateOpen(true)} onDeviceUnlock={() => setDeviceUnlockOpen(true)} onImport={() => setImportOpen(true)} onDeleteVault={() => setDeleteVaultOpen(true)} onAiSettings={() => setAiSettingsOpen(true)} onInterviewTypes={aiSettings?.enabled ? () => setInterviewTypesOpen(true) : null} />}
        {modal && <NewJournalSheet desk templates={templates.filter((t) => !t.deleted)} onClose={() => setModal(false)} onCreate={onCreateJournal} />}
        {templatesOpen && <TemplatesSheet desk onClose={() => setTemplatesOpen(false)} onUse={(t) => { setTemplatesOpen(false); newEntryFromTemplate(t); }} />}
        {rotateOpen && <RotatePhraseSheet desk onClose={() => setRotateOpen(false)} rotate={rotatePhrase} />}
        {deleteVaultOpen && <DeleteVaultSheet desk onClose={() => setDeleteVaultOpen(false)} deleteVault={deleteVault} />}
        {deviceUnlockOpen && <DeviceUnlockSheet desk onClose={() => setDeviceUnlockOpen(false)} method={vaultMethod} apply={setDeviceUnlock} />}
        {importOpen && <ImportDayOneSheet desk onClose={() => setImportOpen(false)} />}
        {aiSettingsOpen && <AiSettingsSheet desk onClose={() => setAiSettingsOpen(false)} />}
        {interviewTypesOpen && <InterviewTypesSheet desk onClose={() => setInterviewTypesOpen(false)} />}
        {badges.celebration && <BadgeCelebration id={badges.celebration} onDismiss={badges.dismissCelebration} />}
      </div>
    );
  }

  // mobile
  const showNav = flow === 'journals' || flow === 'journal' || flow === 'calendar';
  return (
    <div style={{ height: '100%', position: 'relative', background: 'var(--paper)' }}>
      {screen}
      {/* Inside a notebook the Journals tab stays lit and compose writes into it. */}
      {/* Settings in the bottom nav goes straight to the preferences sheet —
          it holds the journal/assistant/vault rows the old settings sheet had. */}
      {showNav && <MobileNav flow={flow === 'journal' ? 'journals' : flow} setFlow={setFlow} onCompose={() => setComposeOpen(true)} onSettings={() => setPrefsOpen(true)} onSearch={() => setSearchOpen(true)} />}
      {/* The FAB opens a chooser (empty / interview / template) instead of
          silently minting a blank entry; inside a notebook every path still
          writes into that notebook, like the FAB used to. */}
      {composeOpen && (
        <ComposeChooser
          onClose={() => setComposeOpen(false)}
          onEmpty={() => { setComposeOpen(false); newEntry(flow === 'journal' ? openJournalObj?.id : undefined); }}
          onInterview={aiSettings?.enabled ? (start) => { setComposeOpen(false); setInterviewStart({ start, journalId: flow === 'journal' ? openJournalObj?.id : undefined }); setInterviewOpen(true); } : null}
          onVideoInterview={aiSettings?.enabled ? (start) => { setComposeOpen(false); setVideoInterview({ start, journalId: flow === 'journal' ? openJournalObj?.id : undefined }); } : null}
          onTemplate={(tpl) => { setComposeOpen(false); newEntryFromTemplate(tpl, flow === 'journal' ? openJournalObj?.id : undefined); }}
        />
      )}
      {searchSheet}
      {deleteJournalSheet}
      {modal && <NewJournalSheet desk={false} templates={templates.filter((t) => !t.deleted)} onClose={() => setModal(false)} onCreate={onCreateJournal} />}
      {prefsOpen && <PreferencesSheet desk={false} theme={theme} onClose={() => setPrefsOpen(false)} ownerId={ownerId} status={status} onLock={lock} onRotate={() => setRotateOpen(true)} onDeviceUnlock={() => setDeviceUnlockOpen(true)} onImport={() => setImportOpen(true)} onDeleteVault={() => setDeleteVaultOpen(true)} onAiSettings={() => setAiSettingsOpen(true)} onTemplates={() => setTemplatesOpen(true)} onAsk={aiSettings?.enabled ? () => setAskOpen(true) : null} onInterview={aiSettings?.enabled ? () => setInterviewOpen(true) : null} onInterviewTypes={aiSettings?.enabled ? () => setInterviewTypesOpen(true) : null} />}
      {templatesOpen && <TemplatesSheet desk={false} onClose={() => setTemplatesOpen(false)} onUse={(t) => { setTemplatesOpen(false); newEntryFromTemplate(t); }} />}
      {rotateOpen && <RotatePhraseSheet desk={false} onClose={() => setRotateOpen(false)} rotate={rotatePhrase} />}
      {deleteVaultOpen && <DeleteVaultSheet desk={false} onClose={() => setDeleteVaultOpen(false)} deleteVault={deleteVault} />}
      {deviceUnlockOpen && <DeviceUnlockSheet desk={false} onClose={() => setDeviceUnlockOpen(false)} method={vaultMethod} apply={setDeviceUnlock} />}
      {importOpen && <ImportDayOneSheet desk={false} onClose={() => setImportOpen(false)} />}
      {aiSettingsOpen && <AiSettingsSheet desk={false} onClose={() => setAiSettingsOpen(false)} />}
      {askOpen && <AskJournalSheet desk={false} onClose={() => setAskOpen(false)} />}
      {interviewOpen && <GuidedInterviewSheet desk={false} onClose={() => { setInterviewOpen(false); setInterviewStart(null); }} onOpenEntry={openEntry} onManageTypes={() => setInterviewTypesOpen(true)} initial={interviewStart?.start} journalId={interviewStart?.journalId} onVideo={(it) => setVideoInterview({ start: it, journalId: interviewStart?.journalId })} />}
      {videoInterview && <VideoInterviewSheet desk={false} onClose={() => setVideoInterview(null)} onOpenEntry={openEntry} onManageTypes={() => setInterviewTypesOpen(true)} initial={videoInterview.start} journalId={videoInterview.journalId} />}
      {interviewTypesOpen && <InterviewTypesSheet desk={false} onClose={() => setInterviewTypesOpen(false)} />}
      {badges.celebration && <BadgeCelebration id={badges.celebration} onDismiss={badges.dismissCelebration} />}
    </div>
  );
}
