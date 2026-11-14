import { createSignal } from "solid-js";

export type ShortcutAction = "mute" | "deafen";

/**
 * Atajos de voz en formato "acelerador" de Electron (p. ej. "Control+Shift+M"),
 * que es tambien lo que la app de escritorio registra como atajo global.
 */

/** Accion cuyo atajo se esta grabando ahora mismo en Ajustes (null = ninguna) */
export const [activeRecorder, setActiveRecorder] =
  createSignal<ShortcutAction | null>(null);

/** El registro del atajo global en el escritorio fallo (otra app lo usa) */
export const [registrationFailed, setRegistrationFailed] = createSignal<
  Record<ShortcutAction, boolean>
>({ mute: false, deafen: false });

const NAMED_KEYS: Record<string, string> = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Space: "Space",
  Enter: "Return",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
};

const MODIFIER_KEYS = ["Control", "Shift", "Alt", "Meta", "AltGraph", "OS"];

/** Teclas que se pueden usar solas (sin Ctrl/Alt/Mays): solo F1-F24 */
const BARE_OK = /^F(?:[1-9]|1\d|2[0-4])$/;

function keyFromCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (BARE_OK.test(code)) return code;
  return NAMED_KEYS[code] ?? null;
}

/**
 * Convierte un evento de teclado en un acelerador ("Control+Shift+M").
 * Devuelve null si es solo una tecla modificadora, una tecla no admitida o
 * una tecla "normal" sin modificador (para no robar la escritura).
 */
export function eventToAccelerator(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.includes(e.key)) return null;
  const key = keyFromCode(e.code);
  if (!key) return null;

  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Control");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");

  if (mods.length === 0 && !BARE_OK.test(key)) return null;
  return [...mods, key].join("+");
}

/** Botones de raton admitidos: rueda (Mouse3), atras (Mouse4), adelante (Mouse5) */
const MOUSE_BUTTONS: Record<number, string> = {
  1: "Mouse3",
  3: "Mouse4",
  4: "Mouse5",
};

/**
 * Convierte un evento de raton en un acelerador ("Mouse4", "Control+Mouse4").
 * Solo los botones extra y la rueda: el clic izquierdo/derecho no se admite.
 * Los botones de raton solo funcionan con la app en primer plano (el sistema
 * no deja registrarlos como atajo global).
 */
export function mouseEventToAccelerator(e: MouseEvent): string | null {
  const key = MOUSE_BUTTONS[e.button];
  if (!key) return null;
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Control");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");
  return [...mods, key].join("+");
}

/** El atajo usa un boton de raton (no se puede registrar como global) */
export function isMouseAccelerator(acc: string): boolean {
  return /(?:^|\+)Mouse[345]$/.test(acc);
}

const VALID =
  /^(?:(?:Control|Alt|Shift|Super)\+){0,4}(?:[A-Z0-9]|F(?:[1-9]|1\d|2[0-4])|Up|Down|Left|Right|Space|Return|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Mouse[345])$/;

/** Valida un acelerador guardado (cadena vacia = sin asignar) */
export function isValidAccelerator(acc: unknown): acc is string {
  if (typeof acc !== "string" || acc.length > 40 || !VALID.test(acc)) {
    return false;
  }
  const parts = acc.split("+");
  return (
    parts.length > 1 || BARE_OK.test(parts[0]) || isMouseAccelerator(acc)
  );
}

const IS_MAC = navigator.platform.startsWith("Mac");

/** Texto para mostrar: "Ctrl+Shift+M" */
export function formatAccelerator(acc: string): string {
  return acc
    .split("+")
    .map((part) => {
      switch (part) {
        case "Control":
          return IS_MAC ? "⌃" : "Ctrl";
        case "Super":
          return IS_MAC ? "⌘" : "Win";
        case "Return":
          return "Enter";
        case "Mouse3":
          return "Mouse 3";
        case "Mouse4":
          return "Mouse 4";
        case "Mouse5":
          return "Mouse 5";
        default:
          return part;
      }
    })
    .join("+");
}
