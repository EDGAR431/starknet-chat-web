import { Accessor, createSignal, onCleanup } from "solid-js";

import { Participant, Track } from "livekit-client";
import { useIsSpeaking } from "solid-livekit-components";

/**
 * Indicador de "está hablando" estilo Discord.
 *
 * El indicador de LiveKit lo calcula el SERVIDOR (cada ~500 ms y con
 * suavizado), por lo que llega tarde, a veces no llega y a veces se queda
 * encendido. Aquí se mide el nivel de audio EN LOCAL, directamente de la
 * pista de micrófono de cada participante (la de los demás ya recibida, y la
 * propia ya procesada por la supresión de ruido), con:
 *  - ataque inmediato (se enciende en cuanto hay voz),
 *  - histéresis (umbral de apertura mayor que el de cierre, para que el ruido
 *    de fondo no lo haga parpadear),
 *  - retención corta (no se apaga en las pausas entre sílabas).
 * Si no se puede medir (sin pista aún, contexto de audio bloqueado), se usa
 * el del servidor como respaldo.
 */

/** Nivel RMS (0-1) para encenderse y para mantenerse encendido */
const OPEN_LEVEL = 0.02;
const KEEP_LEVEL = 0.01;
/** Tiempo que se mantiene encendido tras bajar del umbral */
const HOLD_MS = 280;
/** Cada cuánto se mide */
const TICK_MS = 40;

interface Detector {
  getTrack: () => MediaStreamTrack | undefined;
  onChange: (speaking: boolean | undefined) => void;
  track?: MediaStreamTrack;
  source?: MediaStreamAudioSourceNode;
  analyser?: AnalyserNode;
  data?: Uint8Array<ArrayBuffer>;
  speaking?: boolean;
  lastLoud: number;
}

const detectors = new Set<Detector>();
let ctx: AudioContext | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

function getContext(): AudioContext | undefined {
  try {
    ctx ??= new AudioContext({ latencyHint: "interactive" });
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return undefined;
  }
}

function disconnect(d: Detector) {
  try {
    d.source?.disconnect();
  } catch {
    /* ignorar */
  }
  d.source = d.analyser = d.data = undefined;
  d.track = undefined;
}

function tick() {
  const context = getContext();
  const now = performance.now();
  for (const d of detectors) {
    const track = d.getTrack();

    // la pista cambió (se publicó, se cambió de micrófono...): reconectar
    if (track !== d.track) {
      disconnect(d);
      d.track = track;
      if (track && context && track.readyState === "live") {
        try {
          d.source = context.createMediaStreamSource(new MediaStream([track]));
          d.analyser = context.createAnalyser();
          d.analyser.fftSize = 512;
          d.analyser.smoothingTimeConstant = 0;
          d.source.connect(d.analyser);
          d.data = new Uint8Array(d.analyser.fftSize);
        } catch {
          disconnect(d);
        }
      }
    }

    let result: boolean | undefined;
    if (d.analyser && d.data && context?.state === "running") {
      d.analyser.getByteTimeDomainData(d.data);
      let sum = 0;
      for (const v of d.data) {
        const x = (v - 128) / 128;
        sum += x * x;
      }
      const rms = Math.sqrt(sum / d.data.length);
      const threshold = d.speaking ? KEEP_LEVEL : OPEN_LEVEL;
      if (rms >= threshold) d.lastLoud = now;
      result = now - d.lastLoud < HOLD_MS;
    } else {
      result = undefined; // no se puede medir: respaldo del servidor
    }

    if (result !== d.speaking) {
      d.speaking = result;
      d.onChange(result);
    }
  }
}

function register(d: Detector): () => void {
  detectors.add(d);
  timer ??= setInterval(tick, TICK_MS);
  return () => {
    detectors.delete(d);
    disconnect(d);
    if (!detectors.size && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/**
 * Hook: ¿está hablando este participante ahora mismo?
 * Misma forma de uso que `useIsSpeaking` de LiveKit.
 */
export function useSpeaking(participant: Participant): Accessor<boolean> {
  const server = useIsSpeaking(participant);
  const [local, setLocal] = createSignal<boolean | undefined>(undefined);

  const dispose = register({
    getTrack: () => {
      const pub = participant.getTrackPublication(Track.Source.Microphone);
      // un micrófono silenciado nunca cuenta como "hablando"
      if (!pub || pub.isMuted) return undefined;
      return pub.track?.mediaStreamTrack;
    },
    onChange: setLocal,
    lastLoud: -Infinity,
  });
  onCleanup(dispose);

  return () => {
    const pub = participant.getTrackPublication(Track.Source.Microphone);
    if (pub?.isMuted) return false;
    const l = local();
    return l === undefined ? !!server() : l;
  };
}
