import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  isRecoveryWord,
  normalizeRecoveryWord,
  recoveryWordPaste,
} from "../src/recovery-input.js";

// Public BIP39 fixture, never a user's recovery phrase.
const words =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about".split(
    " ",
  );

test("a complete phrase pasted into any word preserves its absolute order", () => {
  for (const index of [0, 5, 11]) {
    const plan = recoveryWordPaste(words.join(" "), index);
    assert.equal(plan.startIndex, 0);
    assert.deepEqual(plan.words, words);
  }
});

test("a partial paste starts at the selected field and keeps word order", () => {
  const plan = recoveryWordPaste("  ABANDON\nABILITY\tABLE  ", 4);
  assert.equal(plan.startIndex, 4);
  assert.deepEqual(plan.words, ["abandon", "ability", "able"]);
});

test("overflow and oversized pastes are rejected without truncating", () => {
  assert.throws(
    () => recoveryWordPaste([...words, "about"].join(" "), 0),
    /too many words/,
  );
  assert.throws(() => recoveryWordPaste("ability able", 11), /too many words/);
  assert.throws(() => recoveryWordPaste("a".repeat(513), 0), /up to 12/);
});

test("blank pastes and a single word do not replace the whole phrase", () => {
  assert.deepEqual(recoveryWordPaste(" \n\t ", 3), {
    startIndex: 3,
    words: [],
  });
  assert.deepEqual(recoveryWordPaste(" ABOUT ", 11), {
    startIndex: 11,
    words: ["about"],
  });
});

test("invalid field positions cannot shift recovery words", () => {
  for (const index of [-1, 12, 0.5, NaN]) {
    assert.throws(() => recoveryWordPaste("about", index), /up to 12/);
  }
});

test("word validation uses the local English BIP39 list without guessing words", () => {
  assert.equal(normalizeRecoveryWord(" ABANDON "), "abandon");
  assert.equal(isRecoveryWord("ABANDON"), true);
  for (const word of [
    "",
    "aband",
    "notaword",
    "abandon about",
    "1. abandon",
    "about!",
  ]) {
    assert.equal(isRecoveryWord(word), false);
  }
});
