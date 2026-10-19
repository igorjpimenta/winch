import { randomBytes } from "node:crypto";

const ALPHABET = "abcdefghijkmnopqrstuvwxyz23456789";

function suffix(len = 6) {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function newEpicId()  { return `EPIC-${suffix()}`;  }
export function newStoryId() { return `STORY-${suffix()}`; }
export function newTaskId()  { return `TASK-${suffix()}`;  }

export function classifyId(id) {
  if (typeof id !== "string") return null;
  if (id.startsWith("EPIC-"))  return "epic";
  if (id.startsWith("STORY-")) return "story";
  if (id.startsWith("TASK-"))  return "task";
  return null;
}
