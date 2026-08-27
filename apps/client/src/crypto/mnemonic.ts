// BIP39 mnemonic — the recovery phrase that IS the account (CLAUDE.md §6).
import { generateMnemonic as gen, mnemonicToSeedSync, validateMnemonic as val } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

/** A fresh 12-word phrase (128 bits of entropy). */
export function generateMnemonic(): string {
  return gen(wordlist, 128);
}

export function validateMnemonic(mnemonic: string): boolean {
  return val(mnemonic, wordlist);
}

/** BIP39 seed (64 bytes). NFKD-normalized per spec. */
export function mnemonicToSeed(mnemonic: string): Uint8Array {
  return mnemonicToSeedSync(mnemonic.normalize('NFKD'));
}

export function mnemonicWords(mnemonic: string): string[] {
  return mnemonic.trim().split(/\s+/);
}

export function wordsToMnemonic(words: string[]): string {
  return words.map((w) => w.trim().toLowerCase()).join(' ');
}
