import { randomBytes } from "node:crypto";

const ALPHABET = "abcdefghijkmnopqrstuvwxyz23456789";

function suffix(len = 8) {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

// Item ids are opaque: they carry no rank or kind. `items.kind` is the only
// discriminator; nothing in winch may parse a prefix.
export function newItemId() { return `ITM-${suffix()}`; }
export function newAttemptId() { return `ATT-${suffix()}`; }
export function newSessionId() { return `SES-${suffix()}`; }
export function newArtifactId() { return `ART-${suffix()}`; }
