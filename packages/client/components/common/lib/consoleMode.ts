import { createSignal } from "solid-js";

/**
 * "Modo consola": interfaz ampliada para verse desde el sofá y ayuda visual
 * de los botones del mando. Se activa con `?console=1` en la URL (se recuerda),
 * desde Ajustes → Apariencia, o automáticamente en el navegador de Xbox.
 */
const KEY = "starknet.consoleMode";

const isXbox = () => /xbox/i.test(navigator.userAgent);

function initial(): boolean {
  try {
    const q = new URLSearchParams(location.search).get("console");
    if (q === "1") {
      localStorage.setItem(KEY, "1");
      return true;
    }
    if (q === "0") {
      localStorage.setItem(KEY, "0");
      return false;
    }
    const saved = localStorage.getItem(KEY);
    if (saved !== null) return saved === "1";
  } catch {
    // almacenamiento no disponible: se decide por el navegador
  }
  return isXbox();
}

const [consoleMode, setSignal] = createSignal(initial());

/** En Xbox el sistema ya escala la interfaz; en un PC la ampliamos un poco */
const SCALE = () => (isXbox() ? 1 : 1.25);

function apply(on: boolean) {
  const root = document.documentElement;
  root.classList.toggle("console-mode", on);
  root.style.zoom = on ? String(SCALE()) : "";
}

export { consoleMode };

export function setConsoleMode(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    // ignorar
  }
  setSignal(on);
  apply(on);
}

/** Aplica el estado actual al documento (llamar una vez al arrancar) */
export function applyConsoleMode() {
  apply(consoleMode());
}

/**
 * Teclado en pantalla propio al escribir con el mando. Activado por defecto;
 * se puede desactivar si el sistema (p. ej. Xbox) ya muestra el suyo.
 */
const OSK_KEY = "starknet.osk";
const [oskEnabled, setOskSignal] = createSignal(
  (() => {
    try {
      return localStorage.getItem(OSK_KEY) !== "0";
    } catch {
      return true;
    }
  })(),
);

export { oskEnabled };

export function setOskEnabled(on: boolean) {
  try {
    localStorage.setItem(OSK_KEY, on ? "1" : "0");
  } catch {
    // ignorar
  }
  setOskSignal(on);
}
