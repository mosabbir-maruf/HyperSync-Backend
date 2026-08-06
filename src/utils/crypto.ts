import { CONFIG } from "../config";

export function generateSessionId(): string {
  return crypto.randomUUID();
}

export function generateSessionCode(isGroup: boolean = false): string {
  const chars = CONFIG.SESSION_CODE_ALPHABET;
  const prefix = isGroup ? "G" : "P";
  const length = CONFIG.SESSION_CODE_LENGTH - 1;
  let code = prefix;
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  
  for (let i = 0; i < length; i++) {
    code += chars[array[i] % chars.length];
  }
  return code;
}
