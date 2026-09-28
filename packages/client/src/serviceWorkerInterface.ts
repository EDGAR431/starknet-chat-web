import { createSignal } from "solid-js";

import { registerSW } from "virtual:pwa-register";

/**
 * Actualización automática del cliente, al estilo de Discord.
 *
 *  1. DETECCIÓN. Cada minuto (y al volver a la ventana, recuperar la red o
 *     tras un reinicio del servidor) se consulta /version.json, una baliza que
 *     publica cada compilación. Si el identificador cambia, hay versión nueva.
 *  2. PREPARACIÓN. El service worker descarga la versión nueva en segundo
 *     plano; la antigua sigue funcionando con normalidad.
 *  3. APLICACIÓN. Solo en un momento en que no se note: ventana oculta o
 *     minimizada, usuario inactivo, sin llamada de voz, sin mensaje a medias y
 *     sin otra pestaña ocupada. En la app de escritorio se REINICIA la
 *     aplicación entera (como Discord); en el navegador se recarga la página.
 *  4. RESPALDO. Si el service worker no llega a actualizarse, se borra su caché
 *     y se recarga desde la red: nunca se queda atascado en una versión vieja.
 */

/** Función que aplica ya la actualización pendiente */
const [pendingUpdate, setPendingUpdate] = createSignal<() => void>();
export { pendingUpdate };

/** La actualización lleva un rato esperando un momento seguro (botón manual) */
const [updateWaitingLong, setWaitingLong] = createSignal(false);
export { updateWaitingLong };

/** Identificador de esta compilación, visible en Ajustes y en la consola */
const BUILD = typeof __BUILD_ID__ !== "undefined" ? __BUILD_ID__ : "dev";
(window as unknown as { __starknetBuild?: string }).__starknetBuild = BUILD;

/** Valor configurable (solo para pruebas): localStorage["starknet.<clave>"] */
function tunable(key: string, fallback: number): number {
  try {
    const v = Number(localStorage.getItem("starknet." + key));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

const POLL_MS = tunable("updatePollMs", 60_000);
const IDLE_MS = tunable("updateIdleMs", 45_000);
const HIDDEN_MS = tunable("updateHiddenMs", 4_000);
const MIN_BETWEEN_RELOADS_MS = tunable("updateMinGapMs", 3 * 60_000);
const WAITING_LONG_MS = tunable("updateLongMs", 10 * 60_000);
const WAIT_SW_MS = tunable("updateWaitSwMs", 6_000);
const RELOAD_KEY = "starknet.lastAutoReload";
const VERSION_URL = `${import.meta.env.BASE_URL}version.json`;

// ---------------------------------------------------------------- guardas

const guards = new Set<() => boolean>();

/**
 * Registra una condición que debe cumplirse para aplicar la actualización
 * (devuelve `false` para pedir que se espere, p. ej. durante una llamada).
 */
export function registerUpdateGuard(guard: () => boolean): () => void {
  guards.add(guard);
  return () => guards.delete(guard);
}

let lastActivity = Date.now();
let hiddenSince: number | null = document.hidden ? Date.now() : null;

for (const type of ["pointerdown", "keydown", "wheel", "touchstart"]) {
  window.addEventListener(type, () => (lastActivity = Date.now()), {
    passive: true,
    capture: true,
  });
}
document.addEventListener("starknet:activity", () => {
  lastActivity = Date.now();
});

function composerHasText(): boolean {
  // El editor de mensajes es CodeMirror; su marcador ("Message general") no
  // cuenta como texto escrito.
  for (const content of document.querySelectorAll<HTMLElement>(
    ".cm-content",
  )) {
    const clone = content.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(".cm-placeholder").forEach((n) => n.remove());
    if ((clone.textContent || "").trim().length > 0) return true;
  }
  return false;
}

/** ¿Es un buen momento para actualizar esta ventana sin que se note? */
function safeNow(): boolean {
  for (const guard of guards) {
    try {
      if (!guard()) return false;
    } catch {
      // una guarda defectuosa no debe bloquear las actualizaciones
    }
  }
  if (document.hidden) {
    return hiddenSince !== null && Date.now() - hiddenSince >= HIDDEN_MS;
  }
  if (composerHasText()) return false;
  return Date.now() - lastActivity >= IDLE_MS;
}

// Coordinación entre pestañas: al activar la versión nueva se recargan TODAS
// las pestañas, así que solo se activa cuando todas están libres.
const channel =
  typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel("starknet-update")
    : null;

channel?.addEventListener("message", (e) => {
  if (e.data?.type === "query") {
    channel.postMessage({ type: "answer", id: e.data.id, safe: safeNow() });
  }
});

function otherTabsSafe(): Promise<boolean> {
  if (!channel) return Promise.resolve(true);
  return new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    let ok = true;
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === "answer" && e.data.id === id && !e.data.safe) {
        ok = false;
      }
    };
    channel.addEventListener("message", onMessage);
    channel.postMessage({ type: "query", id });
    setTimeout(() => {
      channel.removeEventListener("message", onMessage);
      resolve(ok);
    }, 350);
  });
}

// ------------------------------------------------------------- aplicación

/** Evita bucles de recarga: como mucho una recarga automática cada pocos minutos */
function reloadBudgetOk(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
    return Date.now() - last >= MIN_BETWEEN_RELOADS_MS;
  } catch {
    return true;
  }
}

function markReload() {
  try {
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    // sin sessionStorage: sin límite
  }
}

let registration: ServiceWorkerRegistration | undefined;
let newBuild: string | null = null;
let pendingSince: number | null = null;
let applyingNow = false;

async function waitForWaiting(reg: ServiceWorkerRegistration, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (reg.waiting) return reg.waiting;
    await new Promise((r) => setTimeout(r, 200));
  }
  return reg.waiting;
}

/**
 * Aplica la actualización YA (botón manual y aplicación automática). Siempre
 * termina reiniciando o recargando: nunca "no hace nada".
 */
export async function applyUpdateNow(): Promise<void> {
  if (applyingNow) return;
  applyingNow = true;
  markReload();
  try {
    // Escritorio: reinicio completo de la aplicación, como Discord
    if (window.native?.relaunch) {
      window.native.relaunch();
      return;
    }

    // Navegador: activar el service worker nuevo y recargar
    const sw = navigator.serviceWorker;
    const reg = (await sw?.getRegistration()) ?? registration;
    if (reg) {
      await reg.update().catch(() => {});
      const waiting = await waitForWaiting(reg, WAIT_SW_MS);
      if (waiting) {
        const took = new Promise<void>((resolve) => {
          sw.addEventListener("controllerchange", () => resolve(), {
            once: true,
          });
          setTimeout(resolve, 3_000);
        });
        waiting.postMessage({ type: "SKIP_WAITING" });
        await took;
      } else if (newBuild) {
        // Hay versión nueva pero el service worker no la ha descargado:
        // se elimina junto con su caché para cargar de cero desde la red.
        await reg.unregister().catch(() => {});
        if (typeof caches !== "undefined") {
          for (const key of await caches.keys()) {
            await caches.delete(key).catch(() => false);
          }
        }
      }
    }
    window.location.reload();
  } finally {
    setTimeout(() => (applyingNow = false), 8_000);
  }
}

let waiter: number | undefined;
let checking = false;

function applyWhenSafe() {
  if (waiter !== undefined) return;
  const tick = async () => {
    if (!pendingUpdate() || applyingNow || checking) return;
    if (pendingSince && Date.now() - pendingSince > WAITING_LONG_MS) {
      setWaitingLong(true);
    }
    if (!safeNow() || !reloadBudgetOk()) return;
    checking = true;
    try {
      if (await otherTabsSafe()) {
        clearInterval(waiter);
        waiter = undefined;
        void applyUpdateNow();
      }
    } finally {
      checking = false;
    }
  };
  waiter = window.setInterval(tick, 5_000);
  void tick();
}

function markPending() {
  if (pendingSince === null) pendingSince = Date.now();
  setPendingUpdate(() => () => void applyUpdateNow());
  applyWhenSafe();
}

let lastCheck = 0;

/** Pregunta al servidor si hay una versión nueva del service worker */
function checkForUpdate(force = false) {
  if (!registration) return;
  if (!force && Date.now() - lastCheck < 30_000) return;
  lastCheck = Date.now();
  registration.update().catch(() => {});
}

/** Consulta la baliza /version.json (sin caché) */
let polling = false;
async function pollVersion() {
  if (polling) return;
  polling = true;
  try {
    const res = await fetch(`${VERSION_URL}?t=${Date.now()}`, {
      cache: "no-store",
    });
    if (!res.ok) return;
    const data = (await res.json()) as { build?: string };
    if (data.build && data.build !== BUILD && data.build !== newBuild) {
      newBuild = data.build;
      console.info(`[update] versión nueva detectada (${BUILD} → ${newBuild})`);
      checkForUpdate(true); // que el service worker empiece a descargarla
      markPending();
    }
  } catch {
    // servidor reiniciándose o sin red: se reintenta en la siguiente consulta
  } finally {
    polling = false;
  }
}

const updateSW = registerSW({
  onNeedRefresh() {
    // El service worker ya tiene la versión nueva lista (en espera)
    markPending();
  },
  onOfflineReady() {
    console.info("Ready to work offline =)");
  },
  onRegistered(r) {
    registration = r;
    setInterval(() => checkForUpdate(), 5 * 60_000);
    checkForUpdate();
    void pollVersion();
  },
});
void updateSW;

setInterval(pollVersion, POLL_MS);

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    hiddenSince = Date.now();
  } else {
    hiddenSince = null;
    lastActivity = Date.now();
    void pollVersion();
    checkForUpdate();
  }
});
window.addEventListener("focus", () => {
  void pollVersion();
  checkForUpdate();
});
window.addEventListener("online", () => {
  void pollVersion();
  checkForUpdate();
});

// Si tras un despliegue un fragmento antiguo ya no existe, se recarga una vez
window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault();
  if (reloadBudgetOk()) {
    markReload();
    window.location.reload();
  }
});
