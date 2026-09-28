/**
 * Puerto directo, sin cambios de lógica, del motor probado en
 * crypto-engine/engine.js (fuera de este repositorio, usado para la
 * prueba automática con Node). Cualquier cambio aquí debería
 * reflejarse también allí.
 */

export async function importPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    [],
  );
}

async function deriveSharedKey(
  myPrivateKey: CryptoKey,
  theirPublicKey: CryptoKey,
): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: "ECDH", public: theirPublicKey } as EcdhKeyDeriveParams,
    myPrivateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["wrapKey", "unwrapKey"],
  );
}

export async function generateCallKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}

export interface WrappedBundle {
  wrapped: string; // base64
  iv: string; // base64
}

function toBase64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>;
}

export async function wrapCallKeyForParticipant(
  callKey: CryptoKey,
  myPrivateKey: CryptoKey,
  participantPublicKey: CryptoKey,
): Promise<WrappedBundle> {
  const sharedKey = await deriveSharedKey(myPrivateKey, participantPublicKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.wrapKey("raw", callKey, sharedKey, {
    name: "AES-GCM",
    iv,
  });
  return { wrapped: toBase64(wrapped), iv: toBase64(iv.buffer as ArrayBuffer) };
}

export async function unwrapCallKey(
  bundle: WrappedBundle,
  myPrivateKey: CryptoKey,
  senderPublicKey: CryptoKey,
): Promise<CryptoKey> {
  const sharedKey = await deriveSharedKey(myPrivateKey, senderPublicKey);
  return crypto.subtle.unwrapKey(
    "raw",
    fromBase64(bundle.wrapped),
    sharedKey,
    { name: "AES-GCM", iv: fromBase64(bundle.iv) },
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
}

export async function exportCallKeyRaw(callKey: CryptoKey): Promise<Uint8Array> {
  const raw = await crypto.subtle.exportKey("raw", callKey);
  return new Uint8Array(raw);
}
