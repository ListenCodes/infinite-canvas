import { createDecipheriv } from "node:crypto";

function decrypt(key: Buffer, nonce: Buffer, encoded: string): Buffer {
  const value = Buffer.from(encoded, "base64");
  if (value.length <= 16) throw new Error("Encrypted credential is malformed");
  const ciphertext = value.subarray(0, -16);
  const tag = value.subarray(-16);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function decryptCredential(
  masterKeyBase64: string,
  encryptedDataKey: string,
  encryptedSecret: string,
  nonceBase64: string,
): string {
  const masterKey = Buffer.from(masterKeyBase64, "base64");
  const nonce = Buffer.from(nonceBase64, "base64");
  if (masterKey.length !== 32 || nonce.length !== 12) throw new Error("Credential envelope has invalid key or nonce length");
  const dataKey = decrypt(masterKey, nonce, encryptedDataKey);
  if (dataKey.length !== 32) throw new Error("Credential data key has invalid length");
  try {
    return decrypt(dataKey, nonce, encryptedSecret).toString("utf8");
  } finally {
    dataKey.fill(0);
  }
}
