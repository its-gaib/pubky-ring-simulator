import { wordlist } from "@scure/bip39/wordlists/english.js";

export const RECOVERY_WORD_COUNT = 12;
export const RECOVERY_WORDS = wordlist;
const dictionary = new Set(wordlist);

export function normalizeRecoveryWord(value: string): string {
  return value.normalize("NFKD").trim().toLowerCase();
}

export function isRecoveryWord(value: string): boolean {
  return dictionary.has(normalizeRecoveryWord(value));
}

/** A complete phrase replaces the grid; a partial paste starts at the active word. */
export function recoveryWordPaste(
  text: string,
  activeIndex: number,
): { startIndex: number; words: string[] } {
  if (
    text.length > 512 ||
    !Number.isInteger(activeIndex) ||
    activeIndex < 0 ||
    activeIndex >= RECOVERY_WORD_COUNT
  ) {
    throw new Error("Paste up to 12 recovery words, separated by spaces.");
  }
  const clean = normalizeRecoveryWord(text);
  const words = clean ? clean.split(/\s+/u) : [];
  const startIndex = words.length === RECOVERY_WORD_COUNT ? 0 : activeIndex;
  if (words.length > RECOVERY_WORD_COUNT - startIndex) {
    throw new Error(
      "That paste has too many words for these fields. Paste a complete 12-word phrase or fewer words here.",
    );
  }
  return { startIndex, words };
}
