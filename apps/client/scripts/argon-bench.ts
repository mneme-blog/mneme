import { argon2idAsync } from '@noble/hashes/argon2.js';

const salt = new Uint8Array(16).fill(7);
const pw = new TextEncoder().encode('correct horse battery staple');

for (const [t, mMiB] of [[3, 64], [2, 128], [3, 128], [1, 256], [2, 192]] as [number, number][]) {
  const start = performance.now();
  await argon2idAsync(pw, salt, { t, m: mMiB * 1024, p: 1, dkLen: 32 });
  const ms = performance.now() - start;
  console.log(`t=${t} m=${mMiB}MiB p=1  ->  ${ms.toFixed(0)} ms`);
}
