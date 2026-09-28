import { AudioProcessorOptions, Track, TrackProcessor } from "livekit-client";
import { RNNoiseNode } from "livekit-rnnoise-processor";
import { createEffect, createRoot, on } from "solid-js";

import { CONFIGURATION } from "@revolt/common";
import { Voice } from "@revolt/state/stores/Voice";

export class VoiceProcessor implements TrackProcessor<
  Track.Kind.Audio,
  AudioProcessorOptions
> {
  readonly name = "stoat-voice-processor";
  processedTrack?: MediaStreamTrack;

  private audioContext?: AudioContext;
  private settings: Voice;

  private noiseSuppressionNode?: RNNoiseNode;
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
            if (
              oldNoiseSuppression &&
              oldNoiseSuppression !== newNoiseSuppresion &&
              (newNoiseSuppresion === "enhanced" ||
                oldNoiseSuppression === "enhanced")
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

  private rebuild() {
    this.updateNoiseSuppression(this.audioContext!);
  }

  async init(opts: AudioProcessorOptions): Promise<void> {
    await RNNoiseNode.loadModule(
      opts.audioContext,
      CONFIGURATION.RNNOISE_WORKLET_CDN_URL,
    );
    return this.build(opts);
  }

  async restart(opts: AudioProcessorOptions): Promise<void> {
    return this.build(opts);
  }

  async destroy(): Promise<void> {
    // Destroy the solid context on processor destruction
    this.disposeSolidjsContext();
    this.audioContext = undefined;
    return this.teardown();
  }

  private updateNoiseSuppression(context: AudioContext) {
    if (this.noiseSuppressionNode) {
      this.compressorNode?.disconnect();
      this.noiseSuppressionNode.disconnect();
      this.highpassNode?.disconnect();
      this.sourceNode?.disconnect();
    }

    if (this.settings.noiseSupression === "enhanced") {
      // Create a new highpass filter
      this.highpassNode = context.createBiquadFilter();
      this.highpassNode.type = "highpass";
      this.highpassNode.frequency.value = 50;
      this.highpassNode.Q.value = Math.SQRT1_2;

      this.noiseSuppressionNode = new RNNoiseNode(this.audioContext!);
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
    // If context was passed, store it for restarts
    // If no context was passed, this was a restart so use the old context
    let context = opts.audioContext;
    if (!context) {
      context = this.audioContext!;
    } else {
      this.audioContext = context;
    }
    if (!context) {
      return;
    }
    this.sourceNode = context.createMediaStreamSource(
      new MediaStream([opts.track]),
    );

    // Create the target gain node for input volume
    this.gainNode = context.createGain();
    this.gainNode.gain.value = this.settings.inputVolume;

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

  private async teardown() {
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
