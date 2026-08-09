// Location composer: pick a place (or a from→to journey), preview the frozen
// map, and optionally attach a travel photo. Address search and the one-time
// map render reach OpenStreetMap directly (a deliberate, per-insert leak,
// surfaced in the privacy note below); current-location and raw coordinates
// leak nothing. The relay is never involved — the parent encrypts the rendered
// snapshot like any photo. Structured like the capture modals (VideoCapture).
import type { VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../i18n';
import { Icon } from './Icon';
import { Btn } from './primitives';
import { Sheet, Z } from './Sheet';
import { searchAddress, reverseGeocode } from '../location/geocode';
import { renderStaticMap } from '../location/staticmap';
import type { GeoPoint } from '../location/mercator';

export interface LocationInsert {
  from: GeoPoint;
  to: GeoPoint | null;
  zoom: number;
  map: { blob: Blob; width: number; height: number };
  photo: File | null;
}

// "52.52, 13.40" → a point; rejects out-of-range values.
function parseCoords(s: string): GeoPoint | null {
  const m = s.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lng = parseFloat(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng, label: `${lat.toFixed(4)}, ${lng.toFixed(4)}` };
}

// One endpoint: a search box that resolves to a single chosen point. Accepts an
// address (Nominatim), raw "lat, lng", or the device's current location.
function PointField({
  placeholder,
  value,
  onPick,
  onClear,
  allowLocate,
}: {
  placeholder: string;
  value: GeoPoint | null;
  onPick: (p: GeoPoint) => void;
  onClear: () => void;
  allowLocate: boolean;
}): VNode {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<GeoPoint[]>([]);
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);

  useEffect(() => {
    const coords = parseCoords(q);
    if (coords) {
      setResults([coords]);
      setBusy(false);
      return;
    }
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    setBusy(true);
    const timer = setTimeout(() => {
      void searchAddress(q).then((r) => {
        setResults(r);
        setBusy(false);
      });
    }, 500); // Nominatim asks for ≤ 1 req/s
    return () => clearTimeout(timer);
  }, [q]);

  const locate = (): void => {
    if (!navigator.geolocation) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        void reverseGeocode(latitude, longitude).then((label) => {
          onPick({ lat: latitude, lng: longitude, label: label ?? `${latitude.toFixed(4)}, ${longitude.toFixed(4)}` });
          setLocating(false);
        });
      },
      () => setLocating(false),
      { enableHighAccuracy: false, timeout: 10000 },
    );
  };

  if (value) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 12px', borderRadius: 12, border: '1px solid var(--line)', background: 'var(--surface-2)' }}>
        <Icon name="pin" size={15} color="var(--accent-ink)" />
        <span style={{ flex: 1, minWidth: 0, fontFamily: 'var(--ui)', fontSize: 13.5, fontWeight: 600, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {value.label}
        </span>
        <button
          onClick={() => { setQ(''); setResults([]); onClear(); }}
          title={t('media.location.change')}
          style={{ fontFamily: 'var(--ui)', fontSize: 12.5, fontWeight: 600, color: 'var(--accent-ink)', background: 'transparent', border: 'none', cursor: 'pointer' }}
        >
          {t('media.location.change')}
        </button>
      </div>
    );
  }

  return (
    <div style={{ position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', borderRadius: 12, border: '1px solid var(--line)', background: 'var(--surface-2)' }}>
        <Icon name="search" size={15} color="var(--ink-3)" />
        <input
          value={q}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          placeholder={placeholder}
          style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', padding: '11px 0', fontFamily: 'var(--ui)', fontSize: 14, color: 'var(--ink)' }}
        />
        {busy && <span style={{ fontFamily: 'var(--ui)', fontSize: 11.5, color: 'var(--ink-3)' }}>…</span>}
      </div>

      {results.length > 0 && (
        <div style={{ marginTop: 6, borderRadius: 12, border: '1px solid var(--line)', background: 'var(--surface)', boxShadow: '0 10px 30px rgba(30,20,12,.14)', overflow: 'hidden' }}>
          {results.map((r, i) => (
            <button
              key={`${r.lat},${r.lng},${i}`}
              onClick={() => { onPick(r); setQ(''); setResults([]); }}
              style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'start', padding: '10px 12px', border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'var(--ui)', fontSize: 13.5, color: 'var(--ink)' }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-2)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <Icon name="pin" size={14} color="var(--ink-3)" />
              <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.label}</span>
            </button>
          ))}
        </div>
      )}

      {allowLocate && navigator.geolocation && (
        <button
          onClick={locate}
          style={{ marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 12px', borderRadius: 999, border: '1px solid var(--line)', background: 'transparent', cursor: 'pointer', fontFamily: 'var(--ui)', fontSize: 12.5, fontWeight: 600, color: 'var(--accent-ink)' }}
        >
          <Icon name="pin" size={14} color="var(--accent-ink)" />
          {locating ? t('media.location.locating') : t('media.location.useCurrent')}
        </button>
      )}
    </div>
  );
}

export function LocationPicker({
  desk,
  onClose,
  onInsert,
}: {
  desk: boolean;
  onClose: () => void;
  onInsert: (data: LocationInsert) => void;
}): VNode {
  const [from, setFrom] = useState<GeoPoint | null>(null);
  const [to, setTo] = useState<GeoPoint | null>(null);
  const [showTo, setShowTo] = useState(false);
  const [map, setMap] = useState<{ blob: Blob; width: number; height: number; zoom: number } | null>(null);
  const [mapUrl, setMapUrl] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);

  const [photo, setPhoto] = useState<File | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);

  // Re-render the frozen preview whenever the endpoints change; the produced
  // blob is reused on insert (no second tile fetch).
  useEffect(() => {
    if (!from) { setMap(null); setMapUrl(null); return; }
    let cancelled = false;
    let url: string | null = null;
    setRendering(true);
    void renderStaticMap({ from, to: showTo ? to : null })
      .then((res) => {
        if (cancelled) return;
        setMap(res);
        url = URL.createObjectURL(res.blob);
        setMapUrl(url);
      })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setRendering(false); });
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [from, to, showTo]);

  // Object URL lifecycle for the chosen travel photo.
  useEffect(() => {
    if (!photo) { setPhotoUrl(null); return; }
    const url = URL.createObjectURL(photo);
    setPhotoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  const canInsert = !!from && !!map;
  const insert = (): void => {
    if (!from || !map) return;
    onInsert({
      from,
      to: showTo ? to : null,
      zoom: map.zoom,
      map: { blob: map.blob, width: map.width, height: map.height },
      photo,
    });
  };

  return (
    <Sheet
      desk={desk}
      role="dialog"
      onClose={onClose}
      zIndex={Z.dialog}
      dim="strong"
      pad={desk ? 18 : 0}
      // No grab handle: this sheet opens straight into its title row.
      grabber={false}
      cardStyle={{ maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto', padding: 22 }}
      title={t('media.location.title')}
      accessory={
        <button onClick={onClose} title={t('common.close')} style={{ width: 32, height: 32, borderRadius: 999, border: 'none', background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--ink-2)' }}>
          <Icon name="x" size={18} />
        </button>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <div style={{ fontFamily: 'var(--ui)', fontSize: 11.5, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 6 }}>
            {showTo ? t('media.location.from') : t('media.location.place')}
          </div>
          <PointField placeholder={t('media.location.searchPlace')} value={from} onPick={setFrom} onClear={() => setFrom(null)} allowLocate />
        </div>

        {showTo ? (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontFamily: 'var(--ui)', fontSize: 11.5, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--ink-3)' }}>{t('media.location.to')}</span>
              <button onClick={() => { setShowTo(false); setTo(null); }} style={{ fontFamily: 'var(--ui)', fontSize: 12, fontWeight: 600, color: 'var(--ink-3)', background: 'transparent', border: 'none', cursor: 'pointer' }}>{t('common.remove')}</button>
            </div>
            <PointField placeholder={t('media.location.searchDestination')} value={to} onPick={setTo} onClear={() => setTo(null)} allowLocate />
          </div>
        ) : (
          <button
            onClick={() => setShowTo(true)}
            style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 12px', borderRadius: 999, border: '1px dashed var(--line)', background: 'transparent', cursor: 'pointer', fontFamily: 'var(--ui)', fontSize: 12.5, fontWeight: 600, color: 'var(--accent-ink)' }}
          >
            <Icon name="plus" size={14} color="var(--accent-ink)" /> {t('media.location.addDestination')}
          </button>
        )}

        {/* Live preview of the frozen map. */}
        {from && (
          <div style={{ borderRadius: 14, overflow: 'hidden', border: '1px solid var(--line)', background: 'var(--surface-2)', aspectRatio: '600 / 340', position: 'relative' }}>
            {mapUrl ? (
              <img src={mapUrl} alt={t('media.location.mapPreview')} style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--ink-3)', fontFamily: 'var(--ui)', fontSize: 12.5 }}>
                <Icon name="pin" size={18} color="var(--ink-3)" /> {rendering ? t('media.location.rendering') : t('media.location.unavailable')}
              </div>
            )}
          </div>
        )}

        {/* Optional travel photo. */}
        {photoUrl ? (
          <div style={{ position: 'relative', borderRadius: 12, overflow: 'hidden', border: '1px solid var(--line)' }}>
            <img src={photoUrl} alt={t('media.location.travelPhoto')} style={{ display: 'block', width: '100%', maxHeight: 200, objectFit: 'cover' }} />
            <button onClick={() => setPhoto(null)} title={t('media.location.removePhoto')} style={{ position: 'absolute', top: 8, insetInlineEnd: 8, width: 28, height: 28, borderRadius: 999, border: 'none', background: 'rgba(30,22,16,.55)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#fff' }}>
              <Icon name="x" size={14} />
            </button>
          </div>
        ) : (
          <button
            onClick={() => photoInput.current?.click()}
            style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 12px', borderRadius: 999, border: '1px dashed var(--line)', background: 'transparent', cursor: 'pointer', fontFamily: 'var(--ui)', fontSize: 12.5, fontWeight: 600, color: 'var(--accent-ink)' }}
          >
            <Icon name="image" size={14} color="var(--accent-ink)" /> {t('media.location.addPhoto')}
          </button>
        )}
        <input ref={photoInput} type="file" accept="image/*" onChange={(e) => { const f = (e.target as HTMLInputElement).files?.[0]; (e.target as HTMLInputElement).value = ''; if (f) setPhoto(f); }} style={{ display: 'none' }} />

        {/* Privacy note — mirrors the AI cloud-card convention. */}
        <p style={{ fontFamily: 'var(--ui)', fontSize: 11.5, lineHeight: 1.5, color: 'var(--ink-3)', margin: '2px 0 0' }}>
          {t('media.location.privacy')}
        </p>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 4 }}>
          <Btn kind="ghost" onClick={onClose}>{t('common.cancel')}</Btn>
          <Btn kind="primary" onClick={canInsert ? insert : undefined} style={canInsert ? {} : { opacity: 0.5, cursor: 'default' }}>
            {t('media.location.insert')}
          </Btn>
        </div>
      </div>
    </Sheet>
  );
}
