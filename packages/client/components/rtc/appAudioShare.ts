import { type LocalAudioTrack, type Room, Track } from "livekit-client";

import { voiceLog } from "./VoiceProcessor";

/**
 * Publica como "audio de la retransmisión" el PCM que manda la app de
 * escritorio (Windows) con el audio de SOLO la ventana compartida. Así no se
 * cuelan las voces de la llamada ni el resto del sistema.
 *
 * Flujo: escritorio → IPC (s16le, 48 kHz, estéreo) → AudioWorklet con buffer
 * circular → MediaStreamAudioDestination → pista publicada como
 * Track.Source.ScreenShareAudio.
 */

const WORKLET_SOURCE = `
class AppAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = 48000 * 2 * 2; // 2 s de muestras intercaladas
    this.buf = new Float32Array(this.cap);
    this.r = 0; this.w = 0; this.count = 0;
    this.port.onmessage = (e) => {
      const d = e.data; // Int16Array intercalado
      for (let i = 0; i < d.length; i++) {
        if (this.count >= this.cap) { this.r = (this.r + 2) % this.cap; this.count -= 2; }
        this.buf[this.w] = d[i] / 32768;
        this.w = (this.w + 1) % this.cap;
        this.count++;
      }
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    // Si se acumula demasiado retraso, se descarta lo más viejo
    if (this.count > 28800) {
      const drop = this.count - 9600;
      this.r = (this.r + drop) % this.cap; this.count -= drop;
    }
    for (let i = 0; i < L.length; i++) {
      if (this.count >= 2) {
        L[i] = this.buf[this.r]; R[i] = this.buf[this.r + 1];
        this.r = (this.r + 2) % this.cap; this.count -= 2;
      } else { L[i] = 0; R[i] = 0; }
    }
    return true;
  }
}
registerProcessor("app-audio-processor", AppAudioProcessor);
`;

export class AppAudioShare {
  #ctx?: AudioContext;
  #node?: AudioWorkletNode;
  #track?: LocalAudioTrack;
  #room?: Room;
  #starting?: Promise<void>;

  /** ¿Es el escritorio capaz de dar audio por aplicación? */
  static supported(): boolean {
    return !!window.native?.onAppAudioStart && !!window.native?.onAppAudioChunk;
  }

  /** Engancha los eventos del escritorio para esta retransmisión */
  listen(room: Room) {
    const native = window.native;
    if (!native?.onAppAudioStart) return;
    this.#room = room;
    native.onAppAudioStart(() => {
      this.#starting = this.#start().catch((e) => {
        voiceLog("error", "audio de la ventana: no se pudo publicar", e);
        console.error("[appAudio] no se pudo publicar:", e);
      });
    });
    native.onAppAudioChunk?.((chunk) => {
      if (!this.#node) return;
      const copy = new Uint8Array(chunk).buffer;
      const samples = new Int16Array(copy, 0, Math.floor(copy.byteLength / 2));
      this.#node.port.postMessage(samples, [samples.buffer]);
    });
    native.onAppAudioEnded?.((reason) => {
      voiceLog("warn", `audio de la ventana terminado (${reason})`);
      void this.stop(false);
    });
  }

  async #start() {
    const room = this.#room;
    if (!room) return;
    await this.#teardownLocal();

    const ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.audioWorklet.addModule(
      URL.createObjectURL(
        new Blob([WORKLET_SOURCE], { type: "application/javascript" }),
      ),
    );
    const node = new AudioWorkletNode(ctx, "app-audio-processor", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 2;
    node.connect(dest);

    this.#ctx = ctx;
    this.#node = node;

    const mediaTrack = dest.stream.getAudioTracks()[0];
    const pub = await room.localParticipant.publishTrack(mediaTrack, {
      source: Track.Source.ScreenShareAudio,
      name: "screen_share_audio",
      dtx: false,
      red: false,
    });
    this.#track = pub.track as LocalAudioTrack | undefined;
    voiceLog("info", "audio de la ventana publicado");
  }

  async #teardownLocal() {
    if (this.#track && this.#room) {
      try {
        await this.#room.localParticipant.unpublishTrack(this.#track);
      } catch {
        /* ya no estaba publicada */
      }
    }
    this.#track = undefined;
    this.#node?.disconnect();
    this.#node = undefined;
    if (this.#ctx) {
      void this.#ctx.close().catch(() => {});
      this.#ctx = undefined;
    }
  }

  /** Detiene la captura y despublica la pista */
  async stop(notifyNative = true) {
    await this.#starting?.catch(() => {});
    this.#starting = undefined;
    if (notifyNative) window.native?.stopAppAudio?.();
    await this.#teardownLocal();
  }
}
