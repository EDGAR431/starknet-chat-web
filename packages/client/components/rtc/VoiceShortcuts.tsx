import { createEffect, onCleanup, onMount } from "solid-js";

import { useState } from "@revolt/state";

import { useVoice } from "./state";
import {
  type ShortcutAction,
  activeRecorder,
  eventToAccelerator,
  isLocalOnlyAccelerator,
  mouseEventToAccelerator,
  setRegistrationFailed,
} from "./voiceShortcuts";

/** El foco esta en un campo de texto */
function isEditable(el: HTMLElement | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable
  );
}

/**
 * Atajos de teclado para silenciarse / ensordecerse en una llamada.
 *
 * - En el navegador: funcionan mientras la pestaña esta abierta y enfocada.
 * - En la app de escritorio: ademas se registran como atajos globales (solo
 *   mientras hay una llamada), asi funcionan con la app en segundo plano.
 */
export function VoiceShortcuts() {
  const state = useState();
  const voice = useVoice();

  let last = 0;

  function trigger(action: ShortcutAction) {
    if (!voice.room()) return; // solo en llamada
    // el atajo global y el del navegador pueden coincidir: evitar doble disparo
    const now = Date.now();
    if (now - last < 250) return;
    last = now;
    if (action === "mute") void voice.toggleMute();
    else void voice.toggleDeafen();
  }

  onMount(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || activeRecorder()) return;
      const acc = eventToAccelerator(e);
      if (!acc) return;

      // tecla suelta (sin Ctrl/Alt/...): no actuar mientras se escribe
      if (
        isLocalOnlyAccelerator(acc) &&
        isEditable(e.target as HTMLElement | null)
      ) {
        return;
      }

      if (acc === state.voice.muteKeybind) {
        e.preventDefault();
        trigger("mute");
      } else if (acc === state.voice.deafenKeybind) {
        e.preventDefault();
        trigger("deafen");
      }
    };

    // botones de raton (rueda, atras, adelante); solo con la app en primer plano
    const onMouse = (e: MouseEvent) => {
      if (activeRecorder()) return;
      const acc = mouseEventToAccelerator(e);
      if (!acc) return;
      if (acc !== state.voice.muteKeybind && acc !== state.voice.deafenKeybind) {
        return;
      }
      e.preventDefault(); // evita que "atras/adelante" navegue por el historial
      e.stopPropagation();
      if (e.type !== "mousedown") return;
      trigger(acc === state.voice.muteKeybind ? "mute" : "deafen");
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("mousedown", onMouse, true);
    window.addEventListener("mouseup", onMouse, true);
    window.addEventListener("auxclick", onMouse, true);
    onCleanup(() => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("mousedown", onMouse, true);
      window.removeEventListener("mouseup", onMouse, true);
      window.removeEventListener("auxclick", onMouse, true);
    });

    window.native?.onVoiceShortcut?.(trigger);
  });

  // Escritorio: registrar los atajos globales solo mientras hay llamada
  createEffect(() => {
    if (!window.native?.setVoiceShortcuts) return;
    const inCall = !!voice.room();
    // los botones de raton no se pueden registrar como atajo global
    const global = (acc: string | undefined) =>
      acc && !isLocalOnlyAccelerator(acc) ? acc : "";
    const map = inCall
      ? {
          mute: global(state.voice.muteKeybind),
          deafen: global(state.voice.deafenKeybind),
        }
      : { mute: "", deafen: "" };

    window.native
      .setVoiceShortcuts(map)
      .then((result) =>
        setRegistrationFailed({ mute: !result.mute, deafen: !result.deafen }),
      )
      .catch(() => {
        /* ignorar */
      });
  });

  return null;
}
