import { CONFIG } from "../config";

export function generateSessionId(): string {
  // crypto.randomUUID provides 128 bits of entropy
  return crypto.randomUUID();
}

export function generateSessionCode(): string {
  const chars = CONFIG.SESSION_CODE_ALPHABET;
  let code = "";
  // Use crypto.getRandomValues for secure randomness
  const array = new Uint8Array(CONFIG.SESSION_CODE_LENGTH);
  crypto.getRandomValues(array);
  
  for (let i = 0; i < CONFIG.SESSION_CODE_LENGTH; i++) {
    code += chars[array[i] % chars.length];
  }
  return code;
}
