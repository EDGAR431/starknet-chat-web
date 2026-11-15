import { Show, createSignal, onCleanup } from "solid-js";

import { Track } from "livekit-client";
import { styled } from "styled-system/jsx";

import { VoiceProcessor } from "@revolt/rtc/VoiceProcessor";
import { useState } from "@revolt/state";
import { CategoryButton, Column, Text } from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

/** La prueba se detiene sola, por si se olvida activada (provocaría eco) */
const AUTO_STOP_MS = 3 * 60 * 1000;

/**
 * Prueba de micrófono: el usuario se oye a sí mismo con los mismos ajustes de
 * supresión de ruido, eco y ganancia que usará en una llamada.
 */
export function MicTest() {
  const { voice } = useState();

  const [running, setRunning] = createSignal(false);
  const [level, setLevel] = createSignal(0);
  const [error, setError] = createSignal<string>();

  let stream: MediaStream | undefined;
  let processor: VoiceProcessor | undefined;
  let ctx: AudioContext | undefined;
  let meterCtx: AudioContext | undefined;
  let audioEl: HTMLAudioElement | undefined;
  let raf = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let starting = false;

  async function stop() {
    if (timer) clearTimeout(timer);
    timer = undefined;
    cancelAnimationFrame(raf);
    setRunning(false);
    setLevel(0);
    if (audioEl) {
      audioEl.pause();
      audioEl.srcObject = null;
      audioEl = undefined;
    }
    const p = processor;
    processor = undefined;
    try {
      await p?.destroy();
    } catch {
      /* ignorar */
    }
    stream?.getTracks().forEach((t) => t.stop());
    stream = undefined;
    for (const c of [ctx, meterCtx]) void c?.close().catch(() => {});
    ctx = meterCtx = undefined;
  }

  async function start() {
    if (starting || running()) return;
    starting = true;
    setError(undefined);
    try {
      const deviceId = voice.preferredAudioInputDevice;
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          echoCancellation: voice.echoCancellation,
          noiseSuppression: voice.noiseSupression === "browser",
          autoGainControl: voice.autoGainControl,
          voiceIsolation: voice.noiseSupression === "browser",
        } as MediaTrackConstraints,
      });
      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error("No se encontró ningún micrófono.");

      // mismo procesado que en las llamadas (RNNoise, DeepFilterNet3...)
      ctx = new AudioContext();
      processor = new VoiceProcessor(voice);
      await processor.init({
        kind: Track.Kind.Audio,
        track,
        audioContext: ctx,
      });
      const processed = processor.processedTrack;
      if (!processed) throw new Error("No se pudo procesar el audio.");
      const outStream = new MediaStream([processed]);

      audioEl = new Audio();
      audioEl.srcObject = outStream;
      audioEl.volume = Math.min(1, Math.max(0, voice.outputVolume));
      const sink = voice.preferredAudioOutputDevice;
      if (sink) {
        try {
          await (
            audioEl as HTMLAudioElement & {
              setSinkId?: (id: string) => Promise<void>;
            }
          ).setSinkId?.(sink);
        } catch {
          /* se usa la salida por defecto */
        }
      }
      await audioEl.play();

      // medidor de nivel de lo que se oye (ya procesado)
      meterCtx = new AudioContext();
      const analyser = meterCtx.createAnalyser();
      analyser.fftSize = 1024;
      meterCtx.createMediaStreamSource(outStream).connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      let smooth = 0;
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const v of data) {
          const x = (v - 128) / 128;
          sum += x * x;
        }
        const rms = Math.sqrt(sum / data.length);
        smooth = Math.max(Math.min(1, rms * 4), smooth * 0.85);
        setLevel(smooth);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);

      setRunning(true);
      timer = setTimeout(() => void stop(), AUTO_STOP_MS);
    } catch (err) {
      await stop();
      const name = (err as DOMException)?.name;
      setError(
        name === "NotAllowedError"
          ? "No hay permiso para usar el micrófono. Permítalo en el navegador."
          : name === "NotFoundError" || name === "OverconstrainedError"
            ? "No se encontró el micrófono elegido. Pruebe con otro."
            : `No se pudo iniciar la prueba: ${(err as Error)?.message ?? err}`,
      );
    } finally {
      starting = false;
    }
  }

  onCleanup(() => void stop());

  return (
    <Column>
      <Text class="title">Probar micrófono</Text>
      <CategoryButton.Group>
        <CategoryButton
          icon={<Symbol>{running() ? "mic_off" : "mic"}</Symbol>}
          description={
            running()
              ? "Se está oyendo a sí mismo con sus ajustes actuales. Cambie la supresión de ruido, el eco o el volumen y escuche la diferencia."
              : "Escúchese en directo con la supresión de ruido, el eco y la ganancia que ha elegido. Use auriculares para evitar el eco."
          }
          onClick={() => (running() ? void stop() : void start())}
        >
          {running() ? "Detener prueba" : "Probar micrófono"}
        </CategoryButton>
      </CategoryButton.Group>
      <Show when={running()}>
        <Meter role="meter" aria-label="Nivel del micrófono">
          <MeterFill style={{ width: `${Math.round(level() * 100)}%` }} />
        </Meter>
      </Show>
      <Show when={error()}>
        <Text class="label">{error()}</Text>
      </Show>
    </Column>
  );
}

const Meter = styled("div", {
  base: {
    height: "10px",
    borderRadius: "var(--borderRadius-circle)",
    background: "var(--md-sys-color-surface-container-highest)",
    overflow: "hidden",
  },
});

const MeterFill = styled("div", {
  base: {
    height: "100%",
    borderRadius: "inherit",
    background: "var(--md-sys-color-primary)",
    transition: "width 60ms linear",
  },
});
