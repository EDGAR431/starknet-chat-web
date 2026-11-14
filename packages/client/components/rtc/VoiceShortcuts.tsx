import { createEffect, onCleanup, onMount } from "solid-js";

import { useState } from "@revolt/state";

import { useVoice } from "./state";
import {
  type ShortcutAction,
  activeRecorder,
  eventToAccelerator,
  setRegistrationFailed,
} from "./voiceShortcuts";

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

      if (acc === state.voice.muteKeybind) {
        e.preventDefault();
        trigger("mute");
      } else if (acc === state.voice.deafenKeybind) {
        e.preventDefault();
        trigger("deafen");
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown, true));

    window.native?.onVoiceShortcut?.(trigger);
  });

  // Escritorio: registrar los atajos globales solo mientras hay llamada
  createEffect(() => {
    if (!window.native?.setVoiceShortcuts) return;
    const inCall = !!voice.room();
    const map = inCall
      ? {
          mute: state.voice.muteKeybind ?? "",
          deafen: state.voice.deafenKeybind ?? "",
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
