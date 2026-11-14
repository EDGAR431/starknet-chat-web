import { createSignal, onCleanup } from "solid-js";

import { Participant, ParticipantEvent } from "livekit-client";

/**
 * Atributo de LiveKit con el que cada participante avisa a los demas de que
 * se ha ensordecido ("1") o ya no ("0"). Ensordecerse es una accion local
 * (silencia el microfono y deja de reproducir audio), asi que el servidor no
 * lo sabe: se difunde como atributo del participante.
 */
export const DEAFENED_ATTRIBUTE = "deafened";

/** Publica el estado propio; no falla si el servidor no concede el permiso. */
export async function publishDeafened(
  participant: Participant | undefined,
  deafened: boolean,
) {
  try {
    await (
      participant as unknown as {
        setAttributes?: (a: Record<string, string>) => Promise<void>;
      }
    )?.setAttributes?.({ [DEAFENED_ATTRIBUTE]: deafened ? "1" : "0" });
  } catch (e) {
    console.debug("No se pudo publicar el estado de ensordecido", e);
  }
}

/** Senal reactiva: ese participante se ha ensordecido a si mismo. */
export function useParticipantDeafened(participant: Participant) {
  const read = () => participant.attributes?.[DEAFENED_ATTRIBUTE] === "1";
  const [deafened, setDeafened] = createSignal(read());
  const update = () => setDeafened(read());

  participant.on(ParticipantEvent.AttributesChanged, update);
  onCleanup(() => participant.off(ParticipantEvent.AttributesChanged, update));

  return deafened;
}
