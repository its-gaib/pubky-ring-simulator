import { mnemonicToSeed, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { Keypair } from "@synonymdev/pubky";

const INVALID_PHRASE =
  "Enter a valid 12, 15, 18, 21, or 24-word English recovery phrase.";

/** Matches Pubky Ring's Keypair::from_mnemonic derivation in pubky-core-ffi. */
export async function keypairFromRecoveryPhrase(
  input: string,
): Promise<Keypair> {
  if (typeof input !== "string" || input.length > 512) {
    throw new Error(INVALID_PHRASE);
  }

  const phrase = input
    .normalize("NFKD")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!validateMnemonic(phrase, wordlist)) throw new Error(INVALID_PHRASE);

  // Ring uses BIP39's empty passphrase and the first 32 seed bytes directly.
  // Never substitute mnemonic entropy or an HD wallet derivation path here.
  let seed: Uint8Array | undefined;
  try {
    seed = await mnemonicToSeed(phrase, "");
    return Keypair.fromSecret(seed.subarray(0, 32));
  } catch {
    throw new Error("Could not read this recovery phrase. Try again.");
  } finally {
    seed?.fill(0);
  }
}
