import { activeDeep } from "./engine";

/**
 * Escritura en el campo que tiene el foco (campos nativos, mdui con Shadow DOM
 * y el editor de mensajes CodeMirror) sin quitarle el foco.
 */

function host(): HTMLElement | null {
  return document.activeElement as HTMLElement | null;
}

/** Inserta texto en la posición del cursor */
export function insertText(text: string): boolean {
  const el = activeDeep();
  if (!el) return false;
  if (document.execCommand("insertText", false, text)) return true;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    el.setRangeText(text, start, end, "end");
    el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        data: text,
        inputType: "insertText",
      }),
    );
    return true;
  }
  return false;
}

/** Borra el carácter anterior (o la selección) */
export function backspace(): boolean {
  const el = activeDeep();
  if (!el) return false;
  if (document.execCommand("delete")) return true;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    if (start !== end) {
      el.setRangeText("", start, end, "end");
    } else if (start > 0) {
      el.setRangeText("", start - 1, start, "end");
    } else {
      return false;
    }
    el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "deleteContentBackward",
      }),
    );
    return true;
  }
  return false;
}

function selectable(type: string): boolean {
  return ["text", "search", "url", "tel", "password", ""].includes(type);
}

/** Mueve el cursor un carácter a la izquierda (-1) o a la derecha (1) */
export function moveCaret(step: -1 | 1) {
  const el = activeDeep();
  if (!el) return;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    // Los campos de correo o número no admiten selección: se convierten en
    // texto un instante para colocar el cursor.
    const original = el instanceof HTMLInputElement ? el.type : "";
    const retype = el instanceof HTMLInputElement && !selectable(original);
    try {
      if (retype) (el as HTMLInputElement).type = "text";
      const pos = (step < 0 ? el.selectionStart : el.selectionEnd) ?? 0;
      const next = Math.max(0, Math.min(el.value.length, pos + step));
      el.setSelectionRange(next, next);
    } catch {
      // sin soporte de selección: no se mueve el cursor
    } finally {
      if (retype) {
        const caret = el.selectionStart;
        (el as HTMLInputElement).type = original;
        if (caret !== null) {
          try {
            el.setSelectionRange(caret, caret);
          } catch {
            // ignorar
          }
        }
      }
    }
    return;
  }
  const sel = window.getSelection();
  (
    sel as unknown as {
      modify?: (a: string, b: string, c: string) => void;
    } | null
  )?.modify?.(
    sel && !sel.isCollapsed ? "move" : "move",
    step < 0 ? "backward" : "forward",
    "character",
  );
}

/**
 * Pulsa Intro: en el editor de mensajes envía (lo gestiona la propia app), en
 * un formulario lo envía, y en un campo de varias líneas añade un salto.
 */
export function pressEnter() {
  const el = activeDeep();
  if (!el) return;
  const init = {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
    composed: true,
  };
  const unhandled = el.dispatchEvent(new KeyboardEvent("keydown", init));
  el.dispatchEvent(new KeyboardEvent("keyup", init));
  if (!unhandled) return; // la app ya lo trató (p. ej. enviar el mensaje)

  const form = host()?.closest("form") ?? el.closest("form");
  if (form) {
    form.requestSubmit();
  } else if (el instanceof HTMLTextAreaElement) {
    insertText("\n");
  }
}
