import { onCleanup, onMount } from "solid-js";

import { ConnectionState } from "stoat.js";

import { useClient } from "@revolt/client";
import { useVoice } from "@revolt/rtc";

import { registerUpdateGuard } from "./serviceWorkerInterface";

const WAKE_AFTER_MS = 20_000;
const PONG_WAIT_MS = 4_000;

/**
 * Mantiene el cliente sincronizado con el servidor:
 *  - no permite actualizar la app mientras hay una llamada de voz;
 *  - al volver de dormir/segundo plano/sin red, comprueba de inmediato que la
 *    conexión sigue viva (los temporizadores se congelan en pestañas ocultas y
 *    el socket puede quedar "zombi"); si no responde, se reconecta y el
 *    servidor reenvía todo el estado, sin esperar al siguiente latido.
 */
export function AutoSync() {
  const client = useClient();
  const voice = useVoice();

  let hiddenAt = document.hidden ? Date.now() : 0;
  let checking = false;

  function verifyConnection() {
    const events = client().events;
    if (checking || events.state() !== ConnectionState.Connected) return;
    checking = true;

    let alive = false;
    const onEvent = () => (alive = true);
    events.on("event", onEvent);
    const before = events.ping();

    try {
      events.send({ type: "Ping", data: +new Date() });
    } catch {
      // socket ya cerrado: el ciclo de vida reconectará solo
      events.off("event", onEvent);
      checking = false;
      return;
    }

    setTimeout(() => {
      events.off("event", onEvent);
      checking = false;
      // Una respuesta (Pong) actualiza el ping; cualquier evento también vale
      const pongSeen = events.ping() !== before || alive;
      if (!pongSeen && events.state() === ConnectionState.Connected) {
        console.info("[sync] la conexión no responde tras despertar; reconectando");
        events.disconnect();
      }
    }, PONG_WAIT_MS);
  }

  function onVisibility() {
    if (document.hidden) {
      hiddenAt = Date.now();
    } else if (hiddenAt && Date.now() - hiddenAt > WAKE_AFTER_MS) {
      hiddenAt = 0;
      verifyConnection();
    }
  }

  onMount(() => {
    const removeGuard = registerUpdateGuard(() => {
      const s = voice.state();
      return s === "READY" || s === "DISCONNECTED";
    });
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", verifyConnection);
    onCleanup(() => {
      removeGuard();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", verifyConnection);
    });
  });

  return <></>;
}
