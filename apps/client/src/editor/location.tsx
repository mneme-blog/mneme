// Inline location: a block-level atom node embedding a frozen map card in the
// document flow. Like the media nodes (editor/media.tsx), all metadata lives in
// the node attrs and serializes into bodyJson, so it travels inside the
// encrypted entry body (§3) — the relay only ever sees random media ids and the
// opaque snapshot blob.
//
// The map is rendered once at creation (location/staticmap.ts) and stored as a
// normal `kind: 'image'` media row; the optional travel photo is another. Both
// are referenced ONLY from here (never from a mediaAttachment/gallery node), so
// they stay scoped to this card and never surface in the lightbox or the legacy
// attachment list — but docMediaIds counts them so deletion purges them.
import { Node, mergeAttributes, type Editor } from '@tiptap/core';
import { render, type VNode } from 'preact';
import { useState } from 'preact/hooks';
import { t, fmtNumber } from '../i18n';
import type { MediaAttachment } from '../sync/engine';
import { useMediaUrl, MediaLoadingBar, type MediaResolver } from '../ui/Attachments';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Icon } from '../ui/Icon';
import { haversineKm, type GeoPoint } from '../location/mercator';

export const LOCATION_NODE = 'locationMap';

export interface LocationNodeHandlers {
  resolve: MediaResolver;
  /** Called after a confirmed delete — purge the snapshot + photo bytes/relay copy. */
  onRemoved: (att: MediaAttachment) => void;
}

export interface LocationData {
  from: GeoPoint;
  to: GeoPoint | null;
  zoom: number;
  map: MediaAttachment;
  photo: MediaAttachment | null;
}

// Attrs round-trip through JSON; coerce defensively back into our shapes.
function coercePoint(raw: unknown): GeoPoint | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.lat !== 'number' || typeof p.lng !== 'number') return null;
  return { lat: p.lat, lng: p.lng, label: typeof p.label === 'string' ? p.label : '' };
}

function coerceMedia(raw: unknown): MediaAttachment | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  if (typeof a.id !== 'string' || !a.id) return null;
  return {
    id: a.id,
    kind: 'image',
    mime: String(a.mime ?? 'image/jpeg'),
    bytes: Number(a.bytes ?? 0),
    name: typeof a.name === 'string' && a.name ? a.name : undefined,
    width: typeof a.width === 'number' ? a.width : undefined,
    height: typeof a.height === 'number' ? a.height : undefined,
    createdAt: Number(a.createdAt ?? 0),
  };
}

function nodeData(attrs: Record<string, unknown>): LocationData | null {
  const from = coercePoint(attrs.from);
  const map = coerceMedia(attrs.map);
  if (!from || !map) return null; // malformed node — render nothing
  return {
    from,
    to: coercePoint(attrs.to),
    zoom: typeof attrs.zoom === 'number' ? attrs.zoom : 13,
    map,
    photo: coerceMedia(attrs.photo),
  };
}

// Inserting an atom leaves it node-selected; a trailing paragraph parks the cursor after it.
/** Insert a location card at the current selection. */
export function insertLocation(editor: Editor, data: LocationData): void {
  editor
    .chain()
    .focus()
    .insertContent([{ type: LOCATION_NODE, attrs: { ...data } }, { type: 'paragraph' }])
    .run();
}

function fmtDistance(km: number): string {
  if (km < 1) return t('editorx.location.distanceM', { n: fmtNumber(Math.round(km * 1000)) });
  if (km < 10)
    return t('editorx.location.distanceKm', {
      n: fmtNumber(km, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    });
  return t('editorx.location.distanceKm', { n: fmtNumber(Math.round(km)) });
}

// The travel photo under the map — lazily resolved, with a loading placeholder.
function LocationPhoto({ att, resolve }: { att: MediaAttachment; resolve: MediaResolver }): VNode {
  const { url, failed, retry, progress } = useMediaUrl(att, resolve);
  return (
    <div style={{ marginTop: 8, borderRadius: 12, overflow: 'hidden', border: '1px solid var(--line)', background: 'var(--surface-2)' }}>
      {url ? (
        <img src={url} alt={att.name || t('editorx.location.travelPhoto')} style={{ display: 'block', width: '100%', maxHeight: 360, objectFit: 'cover' }} />
      ) : (
        <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, color: 'var(--ink-3)' }}>
          <Icon name="image" size={18} color="var(--ink-3)" />
          {failed ? (
            <button onClick={retry} style={{ fontFamily: 'var(--ui)', fontSize: 12, fontWeight: 600, color: 'var(--accent-ink)', background: 'transparent', border: '1px solid var(--line)', borderRadius: 999, padding: '3px 10px', cursor: 'pointer' }}>
              {t('editorx.location.retry')}
            </button>
          ) : (
            <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
              <span style={{ fontFamily: 'var(--ui)', fontSize: 12 }}>{t('editorx.location.loadingPhoto')}</span>
              <MediaLoadingBar progress={progress} width={140} />
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** One location card: the frozen map, the from→to labels + distance, and the optional photo. */
export function LocationCard({
  data,
  resolve,
  onDelete,
}: {
  data: LocationData;
  resolve: MediaResolver;
  /** Called after the user confirmed; omit to hide the delete affordance. */
  onDelete?: () => void;
}): VNode {
  const { url, failed, retry } = useMediaUrl(data.map, resolve);
  const [confirming, setConfirming] = useState(false);
  const aspect = data.map.width && data.map.height ? `${data.map.width} / ${data.map.height}` : '600 / 340';
  const distance = data.to ? haversineKm(data.from, data.to) : null;

  return (
    <div style={{ borderRadius: 14, overflow: 'hidden', border: '1px solid var(--line)', background: 'var(--surface-2)' }}>
      <div style={{ position: 'relative', width: '100%', aspectRatio: aspect, background: 'var(--surface)' }}>
        {url ? (
          <img src={url} alt={t('editorx.location.mapAlt')} style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--ink-3)' }}>
            <Icon name="pin" size={22} color="var(--ink-3)" />
            {failed ? (
              <button onClick={retry} style={{ fontFamily: 'var(--ui)', fontSize: 12, fontWeight: 600, color: 'var(--accent-ink)', background: 'transparent', border: '1px solid var(--line)', borderRadius: 999, padding: '3px 10px', cursor: 'pointer' }}>
                {t('editorx.location.retry')}
              </button>
            ) : (
              <span style={{ fontFamily: 'var(--ui)', fontSize: 12 }}>{t('editorx.location.loadingMap')}</span>
            )}
          </div>
        )}
        {onDelete && (
          <button
            onClick={() => setConfirming(true)}
            title={t('editorx.location.delete')}
            style={{ position: 'absolute', top: 8, insetInlineEnd: 8, width: 28, height: 28, borderRadius: 999, border: 'none', background: 'rgba(30,22,16,.55)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#fff' }}
          >
            <Icon name="x" size={14} />
          </button>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 11px' }}>
        <Icon name="pin" size={15} color="var(--accent-ink)" />
        <span style={{ flex: 1, minWidth: 0, fontFamily: 'var(--ui)', fontSize: 13, fontWeight: 600, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {data.from.label || t('editorx.location.pinned')}
          {data.to && <span style={{ color: 'var(--ink-3)', fontWeight: 500 }}> → {data.to.label || t('editorx.location.destination')}</span>}
        </span>
        {distance !== null && (
          <span style={{ flexShrink: 0, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)' }}>{fmtDistance(distance)}</span>
        )}
      </div>

      {data.photo && <div style={{ padding: '0 11px 11px' }}><LocationPhoto att={data.photo} resolve={resolve} /></div>}

      {confirming && (
        <ConfirmDialog
          icon="pin"
          title={t('editorx.location.confirmTitle')}
          confirmLabel={t('editorx.location.delete')}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            onDelete?.();
          }}
        >
          {data.photo ? t('editorx.location.confirmBody.mapPhoto') : t('editorx.location.confirmBody.map')}{' '}
          <strong style={{ color: 'var(--ink)' }}>{t('editorx.location.cannotUndo')}</strong>
        </ConfirmDialog>
      )}
    </div>
  );
}

// Keep ProseMirror's hands off interactions with the image, buttons, and dialog.
function stopEvent(event: Event): boolean {
  const t = event.target as HTMLElement | null;
  return !!t?.closest('img, a, button, [role="dialog"]');
}

export function locationNode(handlers: LocationNodeHandlers): Node {
  return Node.create({
    name: LOCATION_NODE,
    group: 'block',
    atom: true,
    draggable: true,
    addAttributes() {
      return {
        from: { default: null },
        to: { default: null },
        zoom: { default: 13 },
        map: { default: null },
        photo: { default: null },
      };
    },
    parseHTML() {
      return [{ tag: 'div[data-location-map]' }];
    },
    renderHTML({ HTMLAttributes }) {
      return ['div', mergeAttributes(HTMLAttributes, { 'data-location-map': '' })];
    },
    addNodeView() {
      return ({ node, editor, getPos }) => {
        const dom = document.createElement('div');
        dom.className = 'mneme-location-node';
        dom.contentEditable = 'false';
        const data = nodeData(node.attrs);
        if (data) {
          // Runs only after the user confirmed in the card's dialog.
          const onDelete = (): void => {
            const pos = getPos();
            if (typeof pos !== 'number') return;
            editor.chain().focus().deleteRange({ from: pos, to: pos + node.nodeSize }).run();
            handlers.onRemoved(data.map);
            if (data.photo) handlers.onRemoved(data.photo);
          };
          render(<LocationCard data={data} resolve={handlers.resolve} onDelete={editor.isEditable ? onDelete : undefined} />, dom);
        }
        return {
          dom,
          stopEvent,
          destroy: () => render(null, dom),
        };
      };
    },
  });
}
