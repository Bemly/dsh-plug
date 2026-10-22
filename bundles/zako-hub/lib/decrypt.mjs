// AES-256-CBC decryption compatible with:
//   openssl enc -aes-256-cbc -pbkdf2 -iter 200000
// Format: b"Salted__" + 8-byte salt + ciphertext.
// Key/IV = PBKDF2-SHA256(password, salt, 200000, 48 bytes).
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function bundledPassword() {
  return process.env.ZAKO_PASSWORD || 'zako-zako';
}

export function decryptBuffer(enc, password) {
  if (enc.subarray(0, 8).toString('latin1') !== 'Salted__') {
    throw new Error('payload is not in openssl Salted__ format');
  }
  const salt = enc.subarray(8, 16);
  const dk = pbkdf2Sync(password, salt, 200000, 48, 'sha256');
  const decipher = createDecipheriv('aes-256-cbc', dk.subarray(0, 32), dk.subarray(32, 48));
  return Buffer.concat([decipher.update(enc.subarray(16)), decipher.final()]);
}

export function decryptFile(path, password = bundledPassword()) {
  return decryptBuffer(readFileSync(path), password);
}
