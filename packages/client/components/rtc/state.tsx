import {
  Accessor,
  batch,
  createContext,
  createSignal,
  JSX,
  Setter,
  useContext,
} from "solid-js";
import {
  RoomContext,
  TrackReferenceOrPlaceholder,
  useTracks,
} from "solid-livekit-components";

import {
  ConnectionQuality,
  ExternalE2EEKeyProvider,
  Room,
  ScreenSharePresets,
  Track,
  VideoResolution,
} from "livekit-client";
import { DenoiseTrackProcessor } from "livekit-rnnoise-processor";
import { Channel } from "stoat.js";

import { SoundController, useClient, useSound } from "@revolt/client";
import { CONFIGURATION } from "@revolt/common";
import { ModalController, useModals } from "@revolt/modal";
import { useState } from "@revolt/state";
import {
  ScreenShareQualityName,
  Voice as VoiceSettings,
} from "@revolt/state/stores/Voice";
import { VoiceCallCardContext } from "@revolt/ui/components/features/voice/callCard/VoiceCallCard";

import { InRoom } from "./components/InRoom";
import { RoomAudioManager } from "./components/RoomAudioManager";
import { distributeNewCallKey, listenForIncomingCallKey } from "../../src/e2ee/callKeyExchange";
import { wrapCallKeyForParticipant, importPublicKey } from "../../src/e2ee/cryptoEngine";
import { ensureDeviceKeyUploaded, getDeviceId, getOrCreateDeviceKeyPair } from "../../src/e2ee/deviceIdentity";

type State =
  | "READY"
  | "DISCONNECTED"
  | "CONNECTING"
  | "CONNECTED"
  | "RECONNECTING";

type ScreenShareQuality = {
  name: ScreenShareQualityName;
  resolution: VideoResolution;
  fullName: string;
  contentHint: string;
};

class Voice {
  #settings: VoiceSettings;

  channel: Accessor<Channel | undefined>;
  #setChannel: Setter<Channel | undefined>;

  room: Accessor<Room | undefined>;
  #setRoom: Setter<Room | undefined>;

  vidTracks: Accessor<TrackReferenceOrPlaceholder[]>;

  state: Accessor<State>;
  #setState: Setter<State>;

  connectionQuality: Accessor<ConnectionQuality>;
  #setConnectionQuality: Setter<ConnectionQuality>;

  pingMs: Accessor<number | undefined>;
  #setPingMs: Setter<number | undefined>;
  #pingIntervalId: ReturnType<typeof setInterval> | undefined;

  remotePings: Accessor<Map<string, number>>;
  #setRemotePings: Setter<Map<string, number>>;

  e2eeActive: Accessor<boolean>;
  #setE2eeActive: Setter<boolean>;

  deafen: Accessor<boolean>;
  microphone: Accessor<boolean>;

  video: Accessor<boolean>;
  #setVideo: Setter<boolean>;

  screenshare: Accessor<boolean>;
  #setScreenshare: Setter<boolean>;

  fullscreen: Accessor<boolean>;
  #setFullscreen: Setter<boolean>;

  focusId: Accessor<string | undefined>;
  #setFocus: Setter<string | undefined>;

  showBar: Accessor<boolean>;
  #setShowBar: Setter<boolean>;

  private sound: SoundController;

  private openModal;
  private getClient;
  private screenShareTracks: Set<string>;

  // Cifrado extremo a extremo de la llamada actual
  #e2eeKeyProvider: ExternalE2EEKeyProvider | undefined;
  #e2eeCallKeyBytes: Uint8Array | undefined;
  #e2eeMyDeviceKeyPair: CryptoKeyPair | undefined;
  #e2eeMyPublicKeyJwk: JsonWebKey | undefined;

  constructor(
    voiceSettings: VoiceSettings,
    modals: ModalController,
    sound: SoundController,
  ) {
    this.#settings = voiceSettings;
    this.sound = sound;

    const [channel, setChannel] = createSignal<Channel>();
    this.channel = channel;
    this.#setChannel = setChannel;

    const [room, setRoom] = createSignal<Room>();
    this.room = room;
    this.#setRoom = setRoom;

    this.vidTracks = () => [];

    const [state, setState] = createSignal<State>("READY");
    this.state = state;
    this.#setState = setState;

    const [connectionQuality, setConnectionQuality] =
      createSignal<ConnectionQuality>(ConnectionQuality.Unknown);
    this.connectionQuality = connectionQuality;
    this.#setConnectionQuality = setConnectionQuality;

    const [pingMs, setPingMs] = createSignal<number | undefined>(undefined);
    this.pingMs = pingMs;
    this.#setPingMs = setPingMs;

    const [remotePings, setRemotePings] = createSignal<Map<string, number>>(
      new Map(),
    );
    this.remotePings = remotePings;
    this.#setRemotePings = setRemotePings;

    const [e2eeActive, setE2eeActive] = createSignal(false);
    this.e2eeActive = e2eeActive;
    this.#setE2eeActive = setE2eeActive;

    this.deafen = () => voiceSettings.deafen;
    this.microphone = () => voiceSettings.micOn && !voiceSettings.deafen;

    const [video, setVideo] = createSignal(false);
    this.video = video;
    this.#setVideo = setVideo;

    const [screenshare, setScreenshare] = createSignal(false);
    this.screenshare = screenshare;
    this.#setScreenshare = setScreenshare;

    const [fullscreen, setFullscreen] = createSignal(false);
    this.fullscreen = fullscreen;
    this.#setFullscreen = setFullscreen;

    const [focus, setFocus] = createSignal<string>();
    this.focusId = focus;
    this.#setFocus = setFocus;

    const [showBar, setShowBar] = createSignal(true);
    this.showBar = showBar;
    this.#setShowBar = setShowBar;

    this.openModal = modals.openModal;

    this.getClient = useClient();

    this.screenShareTracks = new Set();
  }

  async connect(channel: Channel, auth?: { url: string; token: string }) {
    this.disconnect();

    const e2eeKeyProvider = new ExternalE2EEKeyProvider();
    this.#e2eeKeyProvider = e2eeKeyProvider;

    const room = new Room({
      audioCaptureDefaults: {
        deviceId: this.#settings.preferredAudioInputDevice,
        echoCancellation: this.#settings.echoCancellation,
        noiseSuppression: this.#settings.noiseSupression === "browser",
        autoGainControl: this.#settings.autoGainControl,
      },
      audioOutput: {
        deviceId: this.#settings.preferredAudioOutputDevice,
      },
      videoCaptureDefaults: {
        deviceId: this.#settings.preferredVideoDevice,
      },
      encryption: {
        keyProvider: e2eeKeyProvider,
        worker: new Worker(
          new URL("livekit-client/e2ee-worker", import.meta.url),
        ),
      },
    });

    this.vidTracks = useTracks(
      [
        { source: Track.Source.Camera, withPlaceholder: true },
        { source: Track.Source.ScreenShare, withPlaceholder: false },
      ],
      { room, onlySubscribed: false },
    );

    batch(() => {
      this.#setRoom(room);
      this.#setChannel(channel);
      this.#setState("CONNECTING");
      this.#setVideo(false);
      this.#setScreenshare(false);
    });

    room.addListener("connected", () => {
      this.#setState("CONNECTED");
      if (this.speakingPermission)
        room.localParticipant
          .setMicrophoneEnabled(this.#settings.micOn)
          .then((track) => {
            this.#settings.micOn = track != null;
            if (this.#settings.noiseSupression === "enhanced") {
              track?.audioTrack?.setProcessor(
                new DenoiseTrackProcessor({
                  workletCDNURL: CONFIGURATION.RNNOISE_WORKLET_CDN_URL,
                }),
              );
            }
          });
      for (const p of room.remoteParticipants.values()) {
        const screenShareTrack = p.getTrackPublication(
          Track.Source.ScreenShare,
        );
        if (screenShareTrack) {
          this.screenShareTracks.add(screenShareTrack.trackSid);
        }
      }
      this.sound.playSound("userJoinVoice");
      this.#startPingPolling(room);
    });

    // --- Cifrado extremo a extremo: intercambio de la clave de la llamada ---
    // Se registra el "oyente" siempre, tanto si somos quien inicia la
    // llamada como si nos unimos a una ya empezada — así nunca hay una
    // ventana de tiempo en la que se nos pueda pasar un mensaje.
    (async () => {
      try {
        this.#e2eeMyDeviceKeyPair = await getOrCreateDeviceKeyPair();
        this.#e2eeMyPublicKeyJwk = await crypto.subtle.exportKey(
          "jwk",
          this.#e2eeMyDeviceKeyPair.publicKey,
        );
        await ensureDeviceKeyUploaded(this.getClient());

        const myDeviceId = getDeviceId();
        const listenPromise = listenForIncomingCallKey(
          room,
          myDeviceId,
          this.#e2eeMyDeviceKeyPair.privateKey,
        );

        let rawKey: Uint8Array;
        if (room.remoteParticipants.size === 0) {
          // Somos los primeros en la llamada: generamos la clave y se
          // la repartimos a quien vaya llegando.
          rawKey = await distributeNewCallKey(
            room,
            this.getClient().api,
            myDeviceId,
            this.#e2eeMyDeviceKeyPair.privateKey,
            this.#e2eeMyPublicKeyJwk,
          );
        } else {
          // Ya había alguien — esperamos a que nos manden la clave.
          rawKey = await listenPromise;
        }

        this.#e2eeCallKeyBytes = rawKey;
        this.#e2eeKeyProvider?.setKey(rawKey);
        this.#setE2eeActive(true);
        console.log(
          "%c🔒 Cifrado extremo a extremo establecido correctamente para esta llamada",
          "color: #7c7cf0; font-weight: bold;",
        );
      } catch (e) {
        console.error(
          "[e2ee] No se pudo establecer el cifrado extremo a extremo de la llamada:",
          e,
        );
      }
    })();

    room.addListener("disconnected", () => this.#setState("DISCONNECTED"));

    room.addListener("connectionQualityChanged", (quality, participant) => {
      // Solo nos interesa reflejar nuestra propia calidad de conexión
      // en la interfaz — la de los demás participantes no se muestra.
      if (participant.isLocal) {
        this.#setConnectionQuality(quality);
      }
    });

    // Prueba real de que el cifrado funciona de verdad: LiveKit dispara
    // este evento si alguna vez no consigue descifrar un paquete con la
    // clave actual (por ejemplo, si dos participantes tuvieran claves
    // distintas). Mientras esto no salte, el cifrado está funcionando
    // con normalidad.
    room.addListener("encryptionError", (error) => {
      console.error(
        "%c🔓 Error de cifrado — un participante no pudo descifrar el audio/vídeo correctamente:",
        "color: #f06868; font-weight: bold;",
        error,
      );
    });

    // Escucha permanente de los anuncios de ping de los demás
    // participantes — cada uno mide el suyo propio y lo comparte,
    // así todos ven el ping real de todos.
    const pingDecoder = new TextDecoder();
    room.addListener("dataReceived", (payload, participant) => {
      if (!participant) return;
      let message: { type?: string; ms?: number };
      try {
        message = JSON.parse(pingDecoder.decode(payload));
      } catch {
        return;
      }
      if (message.type === "starknet-ping-report" && typeof message.ms === "number") {
        this.#setRemotePings((prev) => {
          const next = new Map(prev);
          next.set(participant.identity, message.ms!);
          return next;
        });
      }
    });

    room.addListener("participantConnected", (participant) => {
      this.sound.playSound("userJoinVoice");

      // Si ya tenemos la clave de la llamada establecida, se la
      // mandamos también a quien se acaba de unir, para que no se
      // quede fuera del cifrado.
      if (this.#e2eeCallKeyBytes && this.#e2eeMyDeviceKeyPair && this.#e2eeMyPublicKeyJwk) {
        (async () => {
          try {
            const res = await this.getClient().api.get(
              `/e2ee/devices/${participant.identity}`,
            );
            for (const device of res.devices) {
              const theirPublicKey = await importPublicKey(device.public_key);
              const callKeyObj = await crypto.subtle.importKey(
                "raw",
                this.#e2eeCallKeyBytes!,
                { name: "AES-GCM", length: 256 },
                true,
                ["encrypt", "decrypt"],
              );
              const bundle = await wrapCallKeyForParticipant(
                callKeyObj,
                this.#e2eeMyDeviceKeyPair!.privateKey,
                theirPublicKey,
              );
              const encoder = new TextEncoder();
              await room.localParticipant.publishData(
                encoder.encode(
                  JSON.stringify({
                    type: "starknet-e2ee-call-key",
                    to_device_id: device.device_id,
                    from_device_id: getDeviceId(),
                    sender_public_key: this.#e2eeMyPublicKeyJwk,
                    bundle,
                  }),
                ),
                { reliable: true },
              );
            }
          } catch (e) {
            console.error(
              `[e2ee] No se pudo compartir la clave con ${participant.identity}:`,
              e,
            );
          }
        })();
      }
    });

    room.addListener("participantDisconnected", (participant) => {
      this.sound.playSound("userLeaveVoice");
      this.#setRemotePings((prev) => {
        if (!prev.has(participant.identity)) return prev;
        const next = new Map(prev);
        next.delete(participant.identity);
        return next;
      });
    });

    room.addListener("trackPublished", (pub) => {
      if (pub.source === Track.Source.ScreenShare) {
        pub.once("subscribed", (track) => {
          // Play the sound once playback starts, which might be quite a bit after subscription
          // as it starts paused for the screen share settings modal.
          track.once("videoPlaybackStarted", () => {
            this.sound.playSound("streamStart");
            if (track.sid) {
              this.screenShareTracks.add(track.sid);
            }
          });
        });
      }
    });

    room.addListener("trackUnpublished", (unpub) => {
      if (this.screenShareTracks.has(unpub.trackSid)) {
        this.sound.playSound("streamEnd");
        this.screenShareTracks.delete(unpub.trackSid);
      }
    });

    // Gather latency
    const selected = await Promise.any(
      this.getClient().configuration!.features.livekit.nodes.map(
        async (node) => {
          return fetch(node.public_url.replace("wss", "https")).then(() => {
            return node.name;
          });
        },
      ),
    );

    if (!auth) {
      auth = await channel.joinCall(selected);
    }

    await room.connect(auth.url, auth.token, {
      autoSubscribe: false,
    });
  }

  /**
   * LiveKit no expone un número de ping listo para usar — hay que
   * sacarlo de las estadísticas WebRTC estándar del propio navegador.
   * Se prueba con cualquier pista que haya publicada (micro, cámara o
   * pantalla) — no depende de ninguna en concreto. El resultado se
   * anuncia a los demás participantes por el canal de datos, para que
   * cada uno pueda ver el ping real de todos, no solo el suyo propio.
   */
  #startPingPolling(room: Room) {
    this.#stopPingPolling();

    const findAnySender = (): RTCRtpSender | undefined => {
      for (const source of [
        Track.Source.Microphone,
        Track.Source.Camera,
        Track.Source.ScreenShare,
      ]) {
        const pub = room.localParticipant.getTrackPublication(source);
        const sender = (pub?.track as unknown as { sender?: RTCRtpSender })
          ?.sender;
        if (sender) return sender;
      }
      return undefined;
    };

    const poll = async () => {
      try {
        const sender = findAnySender();
        if (!sender) return; // nada publicado todavía — se reintenta en el siguiente ciclo

        const report = await sender.getStats();
        for (const stat of report.values()) {
          if (
            stat.type === "candidate-pair" &&
            stat.state === "succeeded" &&
            typeof stat.currentRoundTripTime === "number"
          ) {
            const ms = Math.round(stat.currentRoundTripTime * 1000);
            this.#setPingMs(ms);

            // Anunciar nuestro propio ping a los demás participantes
            try {
              const encoder = new TextEncoder();
              await room.localParticipant.publishData(
                encoder.encode(
                  JSON.stringify({ type: "starknet-ping-report", ms }),
                ),
                { reliable: false }, // no pasa nada si se pierde alguno, llega otro en 2s
              );
            } catch {
              // si falla el anuncio no es grave, solo no lo verán los demás esta vez
            }
            return;
          }
        }
      } catch (e) {
        console.error("[ping] No se pudo obtener el ping real:", e);
      }
    };

    poll();
    this.#pingIntervalId = setInterval(poll, 2000);
  }

  #stopPingPolling() {
    if (this.#pingIntervalId !== undefined) {
      clearInterval(this.#pingIntervalId);
      this.#pingIntervalId = undefined;
    }
    this.#setPingMs(undefined);
    this.#setRemotePings(new Map());
  }

  disconnect() {
    try {
      const room = this.room();
      if (!room) return;

      room.removeAllListeners();
      room.disconnect();

      batch(() => {
        this.#setState("READY");
        this.#setConnectionQuality(ConnectionQuality.Unknown);
        this.#stopPingPolling();
        this.#e2eeCallKeyBytes = undefined;
        this.#e2eeKeyProvider = undefined;
        this.#setE2eeActive(false);
        this.#setRoom();
        this.#setChannel();
        this.#setFullscreen(false);
        this.vidTracks = () => [];
      });

      this.screenShareTracks = new Set();

      this.sound.playSound("userLeaveVoice");
    } catch (e) {
      this.onErr(e);
    }
  }

  async toggleDeafen(fromMute?: boolean) {
    try {
      const room = this.room();
      if (!room) throw "invalid state";
      await room.localParticipant.setMicrophoneEnabled(
        (this.#settings.micOn || !!fromMute) &&
          !room.localParticipant.isMicrophoneEnabled,
      );

      this.#settings.deafen = !this.#settings.deafen;
      if (fromMute) {
        this.#settings.micOn = room.localParticipant.isMicrophoneEnabled;
      }
      if (this.#settings.deafen) {
        this.sound.playSound("deafen");
      } else {
        this.sound.playSound("undeafen");
      }
    } catch (e) {
      this.onErr(e);
    }
  }

  async toggleMute() {
    if (this.#settings.deafen) {
      this.toggleDeafen(true);
      return;
    }
    try {
      const room = this.room();
      if (!room) throw "invalid state";
      await room.localParticipant.setMicrophoneEnabled(
        !room.localParticipant.isMicrophoneEnabled,
      );

      this.#settings.micOn = room.localParticipant.isMicrophoneEnabled;

      if (this.#settings.micOn) {
        this.sound.playSound("unmute");
      } else {
        this.sound.playSound("mute");
      }
    } catch (e) {
      this.onErr(e);
    }
  }

  async toggleCamera() {
    try {
      const room = this.room();
      if (!room) throw "invalid state";
      await room.localParticipant.setCameraEnabled(
        !room.localParticipant.isCameraEnabled,
      );

      this.#setVideo(room.localParticipant.isCameraEnabled);
    } catch (e) {
      this.onErr(e);
    }
  }

  /**
   * Get the enabled screen share qualities. "low" will always be enabled.
   * Each screen share quality is checked against the limit if the limit is available on the client.
   *
   * TODO: Translate the fullNames here, I can't figure out how to do it.
   *
   * @param name The name of the screen share quality to get
   * @returns A partial record of ScreenShareQualityName to ScreenShareQuality. Will always contain "low" quality.
   */
  getEnabledScreenShareQualities(): Partial<
    Record<ScreenShareQualityName, ScreenShareQuality>
  > {
    // Always enable low
    const qualities: Partial<
      Record<ScreenShareQualityName, ScreenShareQuality>
    > = {
      low: {
        name: "low",
        resolution: ScreenSharePresets.h720fps30.resolution,
        fullName: `720p 30FPS`,
        contentHint: "motion",
      },
    };

    if (this.getClient().configured()) {
      // TODO: Use new user limits if the user is new - I don't think there's a way to do that now?
      const limit =
        this.getClient().configuration?.features.limits.default
          .video_resolution;

      // TODO: Add more resolutions to stream from if they're enabled. May tie into premium users in the future?
      if (limit) {
        if (
          (limit[0] === 0 || limit[0] >= 1920) &&
          (limit[1] === 0 || limit[1] >= 1080)
        ) {
          qualities.high = {
            name: "high",
            resolution: ScreenSharePresets.h1080fps30.resolution,
            fullName: `1080p 30FPS`,
            contentHint: "motion",
          };
          const originalResolution = ScreenSharePresets.original.resolution;
          originalResolution.frameRate = 5;
          originalResolution.aspectRatio = 0;
          if (this.getClient().configured()) {
            // TODO: Use new user limits if the user is new - I don't think there's a way to do that now?
            const limit =
              this.getClient().configuration?.features.limits.default
                .video_resolution;
            if (limit) {
              originalResolution.width = limit[0];
              originalResolution.height = limit[1];
              // If both resolutions are limited, set aspect ratio
              if (
                originalResolution.height !== 0 &&
                originalResolution.width !== 0
              ) {
                originalResolution.aspectRatio =
                  originalResolution.width / originalResolution.height;
              }
            }
          }
          qualities.text = {
            name: "text",
            resolution: originalResolution,
            fullName: `Source 5FPS`,
            contentHint: "text",
          };
        }
      }
    }
    return qualities;
  }

  async toggleScreenshare() {
    const room = this.room();
    if (!room) throw "invalid state";

    if (this.screenshare()) {
      await room.localParticipant.setScreenShareEnabled(false);

      this.#setScreenshare(room.localParticipant.isScreenShareEnabled);

      this.sound.playSound("streamEnd");
    } else {
      const qualities = this.getEnabledScreenShareQualities();
      let screenPickerQualityName: ScreenShareQualityName | undefined;
      let screenPickerAudio: boolean | undefined;

      // Register the modal on screen picker handler if it exists
      if (window.native && window.native.onceScreenPicker) {
        window.native.onceScreenPicker((sources) => {
          this.openModal({
            type: "screen_share_picker",
            onCancel: () => {
              window.native.screenPickerCallback(-1, false);
            },
            callback: (
              idx: number,
              qualityName: ScreenShareQualityName,
              audio: boolean,
            ) => {
              window.native.screenPickerCallback(idx, audio);
              screenPickerQualityName = qualityName;
              screenPickerAudio = audio;
            },
            sources: sources,
            qualities: Object.keys(qualities).map((k) => {
              const v = qualities[k as ScreenShareQualityName]!;
              return { name: k, fullName: v.fullName };
            }),
          });
        });
      }

      try {
        const localTrack = await room.localParticipant.setScreenShareEnabled(
          true,
          {
            resolution:
              this.getEnabledScreenShareQualities()[
                this.#settings.screenShareQuality || "low"
              ]?.resolution,
            audio: {
              autoGainControl: false,
              echoCancellation: false,
              noiseSuppression: false,
              voiceIsolation: false,
              restrictOwnAudio: true,
            },
          },
        );

        const screenAudioTrack = room.localParticipant.getTrackPublication(
          Track.Source.ScreenShareAudio,
        );

        this.#setScreenshare(room.localParticipant.isScreenShareEnabled);

        if (localTrack) {
          // This event is only fired if the screen share is ended by closing the window being streamed.
          // This catches the ending and disables screen sharing on our side. If this weren't here,
          // livekit would still share stream audio after closing the window being streamed.
          localTrack.on("ended", () => {
            this.toggleScreenshare();
            const oldAudioTrack = room.localParticipant.getTrackPublication(
              Track.Source.ScreenShareAudio,
            );
            if (oldAudioTrack && oldAudioTrack.track) {
              room.localParticipant.unpublishTrack(oldAudioTrack.track);
            }
          });

          const callback = async (
            qualityName: ScreenShareQualityName,
            audio: boolean,
          ) => {
            const quality = qualities[qualityName] || qualities.low!;

            if (localTrack.videoTrack) {
              await localTrack.videoTrack.mediaStreamTrack.applyConstraints({
                frameRate: { max: quality.resolution.frameRate },
                width:
                  quality.resolution.width === 0
                    ? undefined
                    : { max: quality.resolution.width },
                height:
                  quality.resolution.width === 0
                    ? undefined
                    : { max: quality.resolution.height },
              });
              localTrack.videoTrack.mediaStreamTrack.contentHint =
                quality.contentHint;
              if (!audio && screenAudioTrack?.track) {
                room.localParticipant.unpublishTrack(screenAudioTrack.track);
              }
              this.sound.playSound("streamStart");
            }
          };

          if (screenPickerQualityName) {
            callback(
              screenPickerQualityName || "low",
              screenPickerAudio || false,
            );
          } else if (this.#settings.screenShareQualityAsk) {
            if (Object.keys(qualities).length > 1) {
              localTrack.pauseUpstream();
              screenAudioTrack?.pauseUpstream();
              this.openModal({
                onCancel: async () => {
                  await room.localParticipant.setScreenShareEnabled(false);
                  this.#setScreenshare(
                    room.localParticipant.isScreenShareEnabled,
                  );
                },
                type: "screen_share_settings",
                trackReference: {
                  participant: room.localParticipant,
                  publication: localTrack,
                  source: Track.Source.ScreenShare,
                },
                qualities: Object.keys(qualities).map((k) => {
                  const v = qualities[k as ScreenShareQualityName]!;
                  return { name: k, fullName: v.fullName };
                }),
                audio: !!screenAudioTrack,
                callback: async (qualityName, audio) => {
                  callback(qualityName, audio);
                  localTrack.resumeUpstream();
                  if (audio) {
                    screenAudioTrack?.resumeUpstream();
                  }
                },
              });
            } else {
              callback(
                this.#settings.screenShareQuality || "low",
                this.#settings.screenShareAudio,
              );
            }
          }
        }
      } catch (e) {
        this.onErr(e);
      }
    }
  }

  toggleFullscreen(fullscreen: boolean = !this.fullscreen()) {
    this.#setFullscreen(fullscreen);
  }

  trackId(t: TrackReferenceOrPlaceholder) {
    return `${t.source}_${t.participant.sid}`;
  }

  toggleFocus(t?: TrackReferenceOrPlaceholder) {
    const id = t ? this.trackId(t) : undefined;
    this.#setFocus(
      this.focusId() === id || this.vidTracks().length < 2 ? undefined : id,
    );
  }

  isFocus(t: TrackReferenceOrPlaceholder) {
    return this.trackId(t) === this.focusId();
  }

  focusTrack() {
    const id = this.focusId();
    return id
      ? this.vidTracks().find((t) => this.trackId(t) === id)
      : undefined;
  }

  toggleShowBar() {
    this.#setShowBar((s) => !s);
  }

  getConnectedUser(userId: string) {
    return this.room()?.getParticipantByIdentity(userId);
  }

  showCard(channel: Channel) {
    return (
      channel.isVoice &&
      (this.channel()?.id === channel.id ||
        channel.type === "TextChannel" ||
        !!channel.voiceParticipants.size)
    );
  }

  get listenPermission() {
    return !!this.channel()?.havePermission("Listen");
  }

  get speakingPermission() {
    return !!this.channel()?.havePermission("Speak");
  }

  private onErr(e: unknown) {
    if ((e as Error).name !== "NotAllowedError")
      this.openModal({ type: "error2", error: e });
  }
}

const voiceContext = createContext<Voice>(null as unknown as Voice);

/**
 * Mount global voice context and room audio manager
 */
export function VoiceContext(props: { children: JSX.Element }) {
  const state = useState();
  const modals = useModals();
  const sound = useSound();
  const voice = new Voice(state.voice, modals, sound);

  return (
    <voiceContext.Provider value={voice}>
      <RoomContext.Provider value={voice.room}>
        <VoiceCallCardContext>{props.children}</VoiceCallCardContext>
        <InRoom>
          <RoomAudioManager />
        </InRoom>
      </RoomContext.Provider>
    </voiceContext.Provider>
  );
}

export const useVoice = () => useContext(voiceContext);
