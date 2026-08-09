// Camera modal: live preview → record (MediaRecorder) → review → attach.
// The captured Blob never leaves this component except via onCapture; encryption
// and upload happen in the data layer (state/data.tsx addMedia). The recorder
// state machine lives in useMediaRecorder, shared with the microphone modal.
import type { VNode } from 'preact';
import { useRef } from 'preact/hooks';
import { t } from '../i18n';
import { Icon } from './Icon';
import { Btn } from './primitives';
import { Sheet, Z } from './Sheet';
import { useMediaRecorder } from './useMediaRecorder';
import { cameraConstraints, fmtDuration, pickMimeType, recorderOptions } from './recorder';

export function VideoCapture({
  desk,
  onClose,
  onCapture,
}: {
  desk: boolean;
  onClose: () => void;
  onCapture: (blob: Blob, durationMs: number) => void;
}): VNode {
  const liveRef = useRef<HTMLVideoElement | null>(null);

  const rec = useMediaRecorder({
    acquire: () => navigator.mediaDevices.getUserMedia(cameraConstraints()),
    makeRecorder: (s) => new MediaRecorder(s, recorderOptions(pickMimeType())),
    fallbackMime: 'video/webm',
    unavailableMessage: t('media.record.cameraUnavailable'),
    onStream: (s) => {
      if (liveRef.current) liveRef.current.srcObject = s;
    },
  });
  const { stage, error, elapsed, reviewUrl } = rec;

  const retake = (): void => {
    rec.retake();
    // Re-bind the still-open stream after the <video> remounts.
    requestAnimationFrame(() => {
      if (liveRef.current && rec.stream.current) liveRef.current.srcObject = rec.stream.current;
    });
  };

  const use = (): void => {
    if (rec.result.current) onCapture(rec.result.current.blob, rec.result.current.durationMs);
    onClose();
  };

  return (
    <Sheet
      desk={desk}
      onClose={onClose}
      zIndex={Z.overlay}
      dim="strong"
      width={480}
      cardStyle={{ padding: desk ? 22 : '18px 18px 28px' }}
      title={stage === 'review' ? t('media.record.reviewTitle') : t('media.record.videoTitle')}
      headerMargin="0 0 14px"
      accessory={
        <button onClick={onClose} title={t('common.close')} style={{ width: 32, height: 32, borderRadius: 10, border: '1px solid var(--line)', background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <Icon name="x" size={16} color="var(--ink-2)" />
        </button>
      }
    >
      {stage === 'error' ? (
        <div style={{ padding: '34px 10px', textAlign: 'center', color: 'var(--ink-2)', fontFamily: 'var(--ui)', fontSize: 14 }}>{error}</div>
      ) : (
        <div style={{ position: 'relative', borderRadius: 14, overflow: 'hidden', background: '#1a140e', border: '1px solid var(--line)' }}>
          {stage === 'review' && reviewUrl ? (
            <video src={reviewUrl} controls playsInline style={{ display: 'block', width: '100%', maxHeight: '52vh' }} />
          ) : (
            <video ref={liveRef} autoPlay muted playsInline style={{ display: 'block', width: '100%', maxHeight: '52vh', transform: 'scaleX(-1)' }} />
          )}
          {stage === 'recording' && (
            <span style={{ position: 'absolute', top: 10, insetInlineStart: 10, display: 'inline-flex', alignItems: 'center', gap: 7, background: 'rgba(20,14,8,.7)', borderRadius: 999, padding: '4px 11px' }}>
              <span style={{ width: 9, height: 9, borderRadius: 9, background: 'var(--danger)' }} />
              <span style={{ fontFamily: 'var(--mono)', fontSize: 12.5, color: '#fff' }}>{fmtDuration(elapsed)}</span>
            </span>
          )}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'center', gap: 10, marginTop: 16 }}>
        {stage === 'idle' && <Btn onClick={rec.startRecording} icon="video">{t('media.record.start')}</Btn>}
        {stage === 'recording' && <Btn kind="danger" onClick={rec.stopRecording}>{t('media.record.stop')}</Btn>}
        {stage === 'review' && (
          <>
            <Btn kind="ghost" onClick={retake}>{t('media.record.retake')}</Btn>
            <Btn onClick={use} icon="check">{t('media.record.useVideo')}</Btn>
          </>
        )}
        {stage === 'error' && <Btn kind="ghost" onClick={onClose}>{t('common.close')}</Btn>}
      </div>
    </Sheet>
  );
}
