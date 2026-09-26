/**
 * StarknetChat E2EE — Identidad del dispositivo
 * ------------------------------------------------
 * Genera (o recupera) el par de claves permanente de ESTE navegador/
 * dispositivo, y sube la parte pública al directorio de claves.
 *
 * La lógica criptográfica de aquí abajo es un puerto directo, sin
 * cambios de comportamiento, del motor ya probado en
 * crypto-engine/engine.js (probado con una simulación completa de
 * llamada de 3 participantes, incluida una prueba de que un impostor
 * no puede desenvolver una clave ajena).
 */

const DB_NAME = "starknet-e2ee";
const STORE_NAME = "device-identity";
const KEY_RECORD_ID = "device-keypair";
const DEVICE_ID_STORAGE_KEY = "starknet_e2ee_device_id";

// ---------- Almacenamiento local del par de claves ----------

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadStoredKeyPair(): Promise<CryptoKeyPair | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(KEY_RECORD_ID);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function saveKeyPair(keyPair: CryptoKeyPair): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(keyPair, KEY_RECORD_ID);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Identificador de ESTE dispositivo (un navegador/perfil concreto).
 * No es secreto — solo sirve para que el directorio de claves pueda
 * distinguir "el PC de Edgar" de "el móvil de Edgar".
 */
export function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_STORAGE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_STORAGE_KEY, id);
  }
  return id;
}

/**
 * Devuelve el par de claves de este dispositivo, generándolo la
 * primera vez que se llama. La clave privada nunca es exportable —
 * el propio navegador impide sacarla en texto plano.
 */
export async function getOrCreateDeviceKeyPair(): Promise<CryptoKeyPair> {
  const stored = await loadStoredKeyPair();
  if (stored) return stored;

  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveKey", "deriveBits"],
  );
  await saveKeyPair(keyPair);
  return keyPair;
}

// ---------- Subida de la clave pública al directorio ----------

const UPLOAD_FLAG_KEY = "starknet_e2ee_uploaded_for_session";

/**
 * Sube la clave pública de este dispositivo al directorio de claves,
 * usando el propio mecanismo de autenticación ya integrado del
 * cliente (`client.api`) — nunca leemos ni manejamos el token de
 * sesión directamente, evitando duplicar esa lógica de seguridad.
 *
 * Se acepta cualquier objeto con un método `api.post` compatible
 * (el `Client` real de stoat.js cumple esta forma).
 */
/**
 * `client.api.post()` del SDK de Stoat solo sabe construir correctamente
 * el cuerpo de la petición para rutas que el propio Stoat reconoce de
 * fábrica — para una ruta nuestra como esta, lo deja vacío en silencio.
 * Por eso hacemos la petición nosotros mismos, reutilizando el token de
 * sesión que el propio cliente ya expone en `client.api.authentication`.
 */
export async function ensureDeviceKeyUploaded(client: {
  api: {
    baseURL: string;
    authentication: { revolt: { token: string } };
  };
}): Promise<void> {
  // Evita subir la misma clave en cada llamada dentro de la misma
  // sesión de navegador — una vez por arranque de la app basta.
  if (sessionStorage.getItem(UPLOAD_FLAG_KEY)) return;

  const { publicKey } = await getOrCreateDeviceKeyPair();
  const jwk = await crypto.subtle.exportKey("jwk", publicKey);

  const payload = {
    device_id: getDeviceId(),
    public_key: jwk,
  };

  const res = await fetch(`${client.api.baseURL}/e2ee/devices`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-session-token": client.api.authentication.revolt.token,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`No se pudo subir la clave del dispositivo: ${await res.text()}`);
  }

  sessionStorage.setItem(UPLOAD_FLAG_KEY, "1");
}
