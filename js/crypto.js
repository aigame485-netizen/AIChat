// 暗号化・復号（AES-256-GCM + PBKDF2）。Canvasアプリの方式を流用
// 暗号文は LINE で送れるよう1行の文字列にする:  v1.<salt>.<iv>.<data>（各base64）

function toB64(buf) {
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  return btoa(bin);
}

function fromB64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function deriveKey(passphrase, salt) {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

export async function encryptText(plain, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain));
  return ['v1', toB64(salt), toB64(iv), toB64(data)].join('.');
}

// パスフレーズ違い・暗号文の破損は例外になる
export async function decryptText(cipher, passphrase) {
  const parts = String(cipher).trim().split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('暗号文の形式が違います');
  const key = await deriveKey(passphrase, fromB64(parts[1]));
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(parts[2]) }, key, fromB64(parts[3]));
  return new TextDecoder().decode(plain);
}
