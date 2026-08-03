import { CONFIG } from "../config";

export function generateSessionId(): string {
  // crypto.randomUUID provides 128 bits of entropy
  return crypto.randomUUID();
}

export function generateSessionCode(isGroup: boolean = false): string {
  const chars = CONFIG.SESSION_CODE_ALPHABET;
  const prefix = isGroup ? "G" : "P";
  const length = CONFIG.SESSION_CODE_LENGTH - 1; // 5 characters
  let code = prefix;
  // Use crypto.getRandomValues for secure randomness
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  
  for (let i = 0; i < length; i++) {
    code += chars[array[i] % chars.length];
  }
  return code;
}
