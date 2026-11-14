import { AudioProcessorOptions, Track, TrackProcessor } from "livekit-client";
import { DeepFilterNet3Core } from "deepfilternet3-noise-filter";
import { RNNoiseNode } from "livekit-rnnoise-processor";
import { createEffect, createRoot, createSignal, on } from "solid-js";

import { CONFIGURATION } from "@revolt/common";
import { Voice } from "@revolt/state/stores/Voice";

/**
 * Estado del procesado de voz para mostrarlo en Ajustes > Voz (diagnostico):
 * motor activo y frecuencia de muestreo con la que trabaja.
 */
export const [voiceProcessorStatus, setVoiceProcessorStatus] =
  createSignal<string>("");

/** RNNoise y DeepFilterNet3 solo funcionan bien a 48 kHz */
const WORK_SAMPLE_RATE = 48000;

export class VoiceProcessor implements TrackProcessor<
  Track.Kind.Audio,
  AudioProcessorOptions
> {
  readonly name = "stoat-voice-processor";
  processedTrack?: MediaStreamTrack;

  private audioContext?: AudioContext;
  private settings: Voice;

  private noiseSuppressionNode?: AudioNode;
  private sourceNode?: MediaStreamAudioSourceNode;
  private highpassNode?: BiquadFilterNode;
  private compressorNode?: DynamicsCompressorNode;
  private gainNode?: GainNode;
  private destinationNode?: MediaStreamAudioDestinationNode;

  /**
   * Bus that soundboard playback is routed through on its way to
   * `destinationNode` — i.e. into the same track that gets published to
   * LiveKit, so a soundboard sound reaches every other call participant
   * exactly like normal mic audio (same encoding, same latency, works
   * through E2EE without any extra protocol).
   */
  private soundboardBusNode?: GainNode;

  private rnnoiseAvailable = false;
  /** Contextos donde ya se cargo el worklet de RNNoise */
  private rnnoiseContexts = new WeakSet<BaseAudioContext>();
  /**
   * Contexto propio a 48 kHz, creado solo si el que da LiveKit trabaja a otra
   * frecuencia (auriculares Bluetooth a 44,1/16 kHz, interfaces a 96 kHz...).
   * Con otra frecuencia el filtro de ruido sale distorsionado o mudo.
   */
  private ownContext?: AudioContext;

  // DeepFilterNet3 (opcional, experimental)
  private dfnCore?: DeepFilterNet3Core;
  private dfnNode?: AudioWorkletNode;
  private dfnAvailable = true;
  private dfnBroken = false;
  private watchdog?: ReturnType<typeof setInterval>;
  private inputAnalyser?: AnalyserNode;
  private outputAnalyser?: AnalyserNode;
  /** Set when RNNoise produced silence from audible input: stay in bypass */
  private rnnoiseBroken = false;

  private disposeSolidjsContext: () => void = () => {};

  constructor(voiceSettings: Voice) {
    this.settings = voiceSettings;

    // Create a solid root to track changes to the settings
    createRoot((dispose) => {
      // On input volume setting change, set the gain
      createEffect(() => {
        this.setGain(this.getSettings().inputVolume);
      });

      // On noise suppression setting change, toggle noise suppression
      createEffect(
        on(
          () => this.getSettings().noiseSupression,
          (newNoiseSuppresion, oldNoiseSuppression) => {
            // Only rebuild if noise supression has changed from enhanced to something else or vice versa
            const isNeural = (v?: string) =>
              v === "enhanced" || v === "deepfilter";
            if (
              oldNoiseSuppression &&
              oldNoiseSuppression !== newNoiseSuppresion &&
              (isNeural(newNoiseSuppresion) || isNeural(oldNoiseSuppression))
            ) {
              this.rebuild();
            }
          },
        ),
      );

      // This is needed to destroy the solid context on unload
      this.disposeSolidjsContext = dispose;
    });
  }

  private getSettings(): Voice {
    return this.settings;
  }

  private setGain(newGain: number) {
    if (this.gainNode) {
      this.gainNode.gain.value = newGain;
    }
  }

  private async rebuild() {
    const context = this.audioContext;
    if (!context) return;
    await this.prepareDeepFilter(context);
    this.updateNoiseSuppression(context);
  }

  /**
   * Prepara el nodo de DeepFilterNet3 si el usuario lo ha elegido. Si no se
   * puede cargar (sin red al CDN, contexto que no es de 48 kHz...) se marca
   * como no disponible y se usa RNNoise en su lugar.
   */
  private async prepareDeepFilter(context: AudioContext): Promise<void> {
    if (this.settings.noiseSupression !== "deepfilter") return;
    if (!this.dfnAvailable || this.dfnBroken || this.dfnNode) return;
    if (context.sampleRate !== 48000) {
      console.warn("[voice] DeepFilterNet3 necesita 48 kHz, usando RNNoise");
      this.dfnAvailable = false;
      return;
    }
    try {
      if (!this.dfnCore) {
        const bundled = new URL(
          `${import.meta.env.BASE_URL ?? "/"}dfn3`.replace(/\/\/+/g, "/"),
          window.location.origin,
        ).href;
        // Copia propia si existe (ver scripts/fetch-dfn3.sh); si no, el CDN
        // por defecto de la librería.
        let cdnUrl: string | undefined;
        try {
          const r = await fetch(`${bundled}/v3/pkg/df_bg.wasm`);
          const m = new Uint8Array((await r.arrayBuffer()).slice(0, 4));
          if (r.ok && m[0] === 0 && m[1] === 0x61 && m[2] === 0x73) {
            cdnUrl = bundled;
          }
        } catch {
          /* usar CDN por defecto */
        }
        const core = new DeepFilterNet3Core({
          sampleRate: 48000,
          noiseReductionLevel: 80,
          assetConfig: cdnUrl ? { cdnUrl } : undefined,
        });
        await core.initialize();
        this.dfnCore = core;
      }
      this.dfnNode = await this.dfnCore.createAudioWorkletNode(context);
    } catch (err) {
      console.error("[voice] DeepFilterNet3 no disponible, usando RNNoise", err);
      this.dfnAvailable = false;
      this.dfnNode = undefined;
    }
  }

  /**
   * Contexto de audio donde se monta la cadena: el de LiveKit si ya va a
   * 48 kHz; si no, uno propio a 48 kHz (el navegador remuestrea la entrada).
   */
  private workContext(base?: AudioContext): AudioContext {
    if (base && base.sampleRate === WORK_SAMPLE_RATE) {
      return base;
    }
    if (this.ownContext && this.ownContext.state !== "closed") {
      return this.ownContext;
    }
    if (!base) {
      return this.audioContext!;
    }
    console.warn(
      `[voice] el audio va a ${base.sampleRate} Hz; se usa un contexto a 48 kHz para el filtro de ruido`,
    );
    try {
      this.ownContext = new AudioContext({
        sampleRate: WORK_SAMPLE_RATE,
        latencyHint: "interactive",
      });
      void this.ownContext.resume().catch(() => {});
      return this.ownContext;
    } catch (err) {
      console.error("[voice] no se pudo crear un contexto a 48 kHz", err);
      return base;
    }
  }

  async init(opts: AudioProcessorOptions): Promise<void> {
    const context = this.workContext(opts.audioContext);
    await this.loadRnnoise(context);
    await this.prepareDeepFilter(context);
    return this.build(opts);
  }

  /**
   * Load the RNNoise worklet + wasm. Tries, in order: the configured CDN,
   * the copy bundled with the app (same origin, so no dependency on an
   * external CDN that may be blocked by a user's network/adblocker/CSP),
   * and finally the library default. If everything fails the processor
   * keeps working without noise suppression instead of muting the mic.
   */
  private async loadRnnoise(context: AudioContext): Promise<void> {
    const bundled = new URL(
      `${import.meta.env.BASE_URL ?? "/"}rnnoise/`.replace(/\/\/+/g, "/"),
      window.location.origin,
    ).href;

    const candidates = [
      CONFIGURATION.RNNOISE_WORKLET_CDN_URL,
      bundled,
      undefined, // library default CDN
    ];

    for (let cdn of candidates) {
      if (cdn !== undefined && !cdn) continue;
      // La librería exige la barra final; sin ella ignora la URL y usa su CDN
      if (cdn && !cdn.endsWith("/")) cdn += "/";
      try {
        // La librería no comprueba la respuesta: un 404 (o el index.html que
        // devuelve una SPA con 200) se guardaría como "wasm" y el worklet
        // quedaría mudo. Validamos aquí antes de cargarlo.
        if (cdn) {
          const resp = await fetch(cdn + "rnnoise.wasm");
          const magic = new Uint8Array((await resp.arrayBuffer()).slice(0, 4));
          const isWasm =
            resp.ok &&
            magic[0] === 0x00 &&
            magic[1] === 0x61 &&
            magic[2] === 0x73 &&
            magic[3] === 0x6d;
          if (!isWasm) throw new Error("rnnoise.wasm no válido en " + cdn);
        }
        await RNNoiseNode.loadModule(context, cdn);
        this.rnnoiseContexts.add(context);
        this.rnnoiseAvailable = true;
        return;
      } catch (err) {
        console.warn("[voice] RNNoise load failed from", cdn ?? "default", err);
      }
    }

    this.rnnoiseAvailable = false;
    console.error("[voice] RNNoise unavailable, continuing without it");
  }

  async restart(opts: AudioProcessorOptions): Promise<void> {
    return this.build(opts);
  }

  async destroy(): Promise<void> {
    // Destroy the solid context on processor destruction
    this.disposeSolidjsContext();
    this.audioContext = undefined;
    await this.teardown();
    if (this.ownContext) {
      void this.ownContext.close().catch(() => {});
      this.ownContext = undefined;
    }
    setVoiceProcessorStatus("");
  }

  private updateNoiseSuppression(context: AudioContext) {
    // always detach the old chain, even when it was a plain bypass:
    // otherwise the source stays wired straight to the gain node and the
    // processed and unprocessed signals get summed (or never switch).
    this.stopWatchdog();
    this.compressorNode?.disconnect();
    this.noiseSuppressionNode?.disconnect();
    this.highpassNode?.disconnect();
    this.sourceNode?.disconnect();
    this.inputAnalyser?.disconnect();
    this.outputAnalyser?.disconnect();

    let node: AudioNode | undefined;
    const wantsDfn =
      this.settings.noiseSupression === "deepfilter" &&
      this.dfnAvailable &&
      !this.dfnBroken &&
      !!this.dfnNode;
    if (wantsDfn) {
      node = this.dfnNode;
    } else if (
      (this.settings.noiseSupression === "enhanced" ||
        this.settings.noiseSupression === "deepfilter") &&
      this.rnnoiseAvailable &&
      !this.rnnoiseBroken
    ) {
      // dfnNode no usado en esta cadena: se libera
      this.dfnNode?.disconnect();
      this.dfnNode = undefined;
      try {
        node = new RNNoiseNode(this.audioContext!);
      } catch (err) {
        console.error("[voice] could not create RNNoise node", err);
        this.rnnoiseAvailable = false;
      }
    }

    const engine = node
      ? node === this.dfnNode
        ? "DeepFilterNet3"
        : "RNNoise"
      : this.settings.noiseSupression === "browser"
        ? "navegador"
        : this.settings.noiseSupression === "disabled"
          ? "desactivado"
          : "sin filtro (no se pudo cargar)";
    setVoiceProcessorStatus(
      `${engine} · ${context.sampleRate} Hz${
        this.ownContext === context ? " (remuestreado)" : ""
      }`,
    );

    if (node) {
      // Create a new highpass filter
      this.highpassNode = context.createBiquadFilter();
      this.highpassNode.type = "highpass";
      this.highpassNode.frequency.value = 50;
      this.highpassNode.Q.value = Math.SQRT1_2;

      this.noiseSuppressionNode = node;
      this.highpassNode.connect(this.noiseSuppressionNode);

      // Create a new dynamics compressor
      this.compressorNode = context.createDynamicsCompressor();
      this.compressorNode.threshold.value = -3;
      this.compressorNode.knee.value = 0;
      this.compressorNode.ratio.value = 20;
      this.compressorNode.attack.value = 0.003;
      this.compressorNode.release.value = 0.05;
      this.noiseSuppressionNode.connect(this.compressorNode);

      // Connect the compressor to the output gain
      this.compressorNode.connect(this.gainNode!);
      // Lastly, connect the source to the highpass node to complete loop
      this.sourceNode!.connect(this.highpassNode);

      // Watchdog: if the worklet never initialises (wasm blocked, etc.) it
      // outputs pure silence. Detect that and fall back to bypass.
      this.inputAnalyser = context.createAnalyser();
      this.outputAnalyser = context.createAnalyser();
      this.inputAnalyser.fftSize = this.outputAnalyser.fftSize = 1024;
      this.sourceNode!.connect(this.inputAnalyser);
      this.compressorNode.connect(this.outputAnalyser);
      this.startWatchdog();
    } else {
      // Bypass noise suppression and remove all unused nodes
      this.compressorNode = undefined;
      this.noiseSuppressionNode = undefined;
      this.highpassNode = undefined;
      this.sourceNode!.connect(this.gainNode!);
    }
  }

  private async build(opts: AudioProcessorOptions): Promise<void> {
    await this.teardown();
    // Contexto de trabajo (48 kHz); en un reinicio sin contexto se reutiliza
    const context = this.workContext(opts.audioContext);
    this.audioContext = context;
    if (!context) {
      return;
    }
    if (!this.rnnoiseContexts.has(context)) {
      this.rnnoiseAvailable = false;
      await this.loadRnnoise(context);
    }
    this.sourceNode = context.createMediaStreamSource(
      new MediaStream([opts.track]),
    );

    // Create the target gain node for input volume
    this.gainNode = context.createGain();
    this.gainNode.gain.value = this.settings.inputVolume;

    // El nodo de DFN3 se crea de forma asíncrona antes de montar la cadena
    this.dfnNode?.disconnect();
    this.dfnNode = undefined;
    await this.prepareDeepFilter(context);
    this.updateNoiseSuppression(context);

    // Create the destination node, connect the gain node and send it off to livekit
    this.destinationNode = context.createMediaStreamDestination();
    this.gainNode.connect(this.destinationNode);

    // Soundboard sounds join the outgoing track through their own bus, so
    // their volume is independent of the mic's input-volume setting.
    this.soundboardBusNode = context.createGain();
    this.soundboardBusNode.gain.value = 1.0;
    this.soundboardBusNode.connect(this.destinationNode);

    this.processedTrack = this.destinationNode.stream.getAudioTracks()[0];
  }

  private rms(analyser: AnalyserNode): number {
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    return Math.sqrt(sum / buf.length);
  }

  private startWatchdog() {
    let bad = 0;
    this.watchdog = setInterval(() => {
      if (!this.inputAnalyser || !this.outputAnalyser) return;
      const input = this.rms(this.inputAnalyser);
      const output = this.rms(this.outputAnalyser);
      // audible mic input but dead-silent output => worklet is not running
      if (input > 0.02 && output < 1e-6) bad++;
      else if (output >= 1e-6) bad = 0;
      if (bad >= 6) {
        if (this.noiseSuppressionNode === this.dfnNode && this.dfnNode) {
          console.error("[voice] DeepFilterNet3 output is silent, disabling it");
          this.dfnBroken = true;
          this.dfnNode?.disconnect();
          this.dfnNode = undefined;
        } else {
          console.error("[voice] RNNoise output is silent, disabling it");
          this.rnnoiseBroken = true;
        }
        this.stopWatchdog();
        this.updateNoiseSuppression(this.audioContext!);
      }
    }, 500);
  }

  private stopWatchdog() {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = undefined;
  }

  private async teardown() {
    this.stopWatchdog();
    this.inputAnalyser?.disconnect();
    this.outputAnalyser?.disconnect();
    this.sourceNode?.disconnect();
    this.highpassNode?.disconnect();
    this.noiseSuppressionNode?.disconnect();
    this.compressorNode?.disconnect();
    this.gainNode?.disconnect();
    this.soundboardBusNode?.disconnect();
    this.destinationNode?.disconnect();
    this.sourceNode = undefined;
    this.highpassNode = undefined;
    this.noiseSuppressionNode = undefined;
    this.compressorNode = undefined;
    this.gainNode = undefined;
    this.soundboardBusNode = undefined;
    this.destinationNode = undefined;
  }

  /**
   * Play a soundboard sound, mixed directly into the outgoing mic track so
   * every other call participant hears it exactly like normal voice audio.
   *
   * The sender also hears it locally (through their own speakers/headset,
   * outside the published track — playing it back to yourself over the
   * network would just double it), unless `monitor` is turned off.
   *
   * @param buffer Decoded audio to play
   * @param volume Linear volume for this sound, 0 to 2
   * @param monitor Whether the local user should also hear it (default true)
   */
  playSoundboardSound(
    buffer: AudioBuffer,
    volume: number,
    monitor = true,
  ): void {
    if (!this.audioContext || !this.soundboardBusNode) return;

    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;

    const gain = this.audioContext.createGain();
    gain.gain.value = volume;

    source.connect(gain);
    gain.connect(this.soundboardBusNode);
    if (monitor) {
      gain.connect(this.audioContext.destination);
    }

    source.addEventListener("ended", () => {
      source.disconnect();
      gain.disconnect();
    });

    source.start();
  }
}
