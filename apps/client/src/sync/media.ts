// Media transfer orchestration: chunked encryption (crypto/media.ts) over the
// relay's per-chunk endpoints (§10 step 5, server-relayed — see server
// internal/blobs). The relay stores opaque ciphertext chunks; which entry a
// media object belongs to, its mime type, and its duration live only inside
// the encrypted entry body (sync/engine.ts MediaAttachment).
import { encryptMediaChunks, decryptMediaChunks } from '../crypto/media';
import type { RelayClient } from './relay';

/** Encrypt + upload one media payload, then finalize it for other devices. */
export async function uploadMedia(
  relay: RelayClient,
  token: string,
  mediaKey: Uint8Array,
  mediaId: string,
  data: Uint8Array,
): Promise<void> {
  const chunks = encryptMediaChunks(mediaKey, mediaId, data);
  let bytes = 0;
  for (let i = 0; i < chunks.length; i++) {
    await relay.uploadMediaChunk(token, mediaId, i, chunks[i]);
    bytes += chunks[i].length;
  }
  await relay.completeMedia(token, mediaId, chunks.length, bytes);
}

/**
 * Transfer progress in ciphertext bytes. `total` comes from the relay's media
 * metadata, so it is the on-the-wire size, not the plaintext byte count on the
 * attachment — close enough for a bar, and the only figure known before the
 * bytes arrive.
 */
export type MediaProgress = (loaded: number, total: number) => void;

/** Download + decrypt one finalized media payload. */
export async function downloadMedia(
  relay: RelayClient,
  token: string,
  mediaKey: Uint8Array,
  mediaId: string,
  onProgress?: MediaProgress,
): Promise<Uint8Array> {
  const meta = await relay.mediaMeta(token, mediaId);
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  // Report 0 first: it is what tells the UI a transfer started at all (a local
  // hit resolves without ever calling this), so the bar appears immediately
  // rather than at the first chunk.
  onProgress?.(0, meta.bytes);
  for (let i = 0; i < meta.chunks; i++) {
    chunks.push(
      await relay.downloadMediaChunk(
        token,
        mediaId,
        i,
        onProgress &&
          ((n) => {
            loaded += n;
            onProgress(Math.min(loaded, meta.bytes), meta.bytes);
          }),
      ),
    );
  }
  return decryptMediaChunks(mediaKey, mediaId, chunks);
}
