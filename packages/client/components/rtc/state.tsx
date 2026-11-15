import {
  Accessor,
  batch,
  createContext,
  createEffect,
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
  LocalTrackPublication,
  RemoteParticipant,
  RemoteTrackPublication,
  Room,
  RoomEvent,
  ScreenShareCaptureOptions,
  ScreenSharePresets,
  Track,
  VideoEncoding,
  VideoPresets,
} from "livekit-client";
import { publishDeafened } from "./deafenedAttribute";
import { Channel } from "stoat.js";

import { SoundController, useClient, useSound } from "@revolt/client";
import { useInstance } from "@revolt/instance";
import { ModalController, useModals } from "@revolt/modal";
import { useState } from "@revolt/state";
import {
  NoiseSuppresionState,
  ScreenShareQualityName,
  Voice as VoiceSettings,
} from "@revolt/state/stores/Voice";
import { VoiceCallCardContext } from "@revolt/ui/components/features/voice/callCard/VoiceCallCard";

import { Device, useDevice } from "@revolt/common";
import { InRoom } from "./components/InRoom";
import { RoomAudioManager } from "./components/RoomAudioManager";
import { distributeNewCallKey, listenForIncomingCallKey } from "../../src/e2ee/callKeyExchange";
import { wrapCallKeyForParticipant, importPublicKey } from "../../src/e2ee/cryptoEngine";
import { ensureDeviceKeyUploaded, getDeviceId, getOrCreateDeviceKeyPair } from "../../src/e2ee/deviceIdentity";
import { AppAudioShare } from "./appAudioShare";
import { VoiceProcessor, voiceLog } from "./VoiceProcessor";

type State =
  | "READY"
  | "DISCONNECTED"
  | "CONNECTING"
  | "CONNECTED"
  | "RECONNECTING";

export type VoiceLayout = "fullscreen" | "expanded" | "collapsed" | undefined;

type ScreenShareQuality = Required<
  Pick<ScreenShareCaptureOptions, "contentHint" | "resolution">
> & {
  name: ScreenShareQualityName;
  fullName: string;
  encoding: VideoEncoding;
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

  layout: Accessor<VoiceLayout>;
  #setLayout: Setter<VoiceLayout>;

  focusId: Accessor<string | undefined>;
  #setFocus: Setter<string | undefined>;

  showBar: Accessor<boolean>;
  #setShowBar: Setter<boolean>;

  private sound: SoundController;
  private device: Device;

  private getClient;
  private openModal;
  private config;
  private limits;
  private screenShareTracks: Set<string>;

  /**
   * Identidades de quienes emiten pantalla y cuyo stream el usuario ha
   * decidido VER. Sin pulsar «Ver stream» no se descarga el vídeo ni su audio
   * (ahorra datos, batería y carga del servidor).
   */
  #watching = createSignal<Set<string>>(new Set());

  isWatching(identity: string): boolean {
    return this.#watching[0]().has(identity);
  }

  setWatching(identity: string, on: boolean) {
    const next = new Set(this.#watching[0]());
    if (on) next.add(identity);
    else next.delete(identity);
    this.#watching[1](next);
    const p = this.room()?.getParticipantByIdentity(identity);
    if (p && p instanceof RemoteParticipant) this.#applyStreamSubscription(p);
  }

  /** Suscribe o anula el vídeo/audio de pantalla compartida según se mire o no */
  #applyStreamSubscription(p: RemoteParticipant) {
    const watch = this.#watching[0]().has(p.identity);
    for (const source of [Track.Source.ScreenShare, Track.Source.ScreenShareAudio]) {
      const pub = p.getTrackPublication(source);
      if (pub instanceof RemoteTrackPublication && pub.isSubscribed !== watch) {
        pub.setSubscribed(watch);
      }
    }
  }
  private voiceProcessor?: VoiceProcessor;

  // Caché de sonidos del soundboard ya decodificados (por fileId), para que
  // repetir un mismo sonido en la llamada sea instantáneo en vez de volver
  // a descargarlo y decodificarlo cada vez.
  #soundboardBufferCache: Map<string, Promise<AudioBuffer>> = new Map();
  #soundboardDecodeContext?: AudioContext;
  #appAudio = new AppAudioShare();
  #lastSoundboardFrom: Map<string, number> = new Map();

  /** Volumen maestro del soundboard de ESTE cliente (lo asigna VoiceContext) */
  soundboardMaster: () => number = () => 1;

  // Cifrado extremo a extremo de la llamada actual
  #e2eeKeyProvider: ExternalE2EEKeyProvider | undefined;
  #e2eeCallKeyBytes: Uint8Array | undefined;
  #e2eeMyDeviceKeyPair: CryptoKeyPair | undefined;
  #e2eeMyPublicKeyJwk: JsonWebKey | undefined;

  constructor(
    voiceSettings: VoiceSettings,
    modals: ModalController,
    sound: SoundController,
    device: Device,
  ) {
    this.#settings = voiceSettings;
    this.sound = sound;
    this.device = device;

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

    const [layout, setLayout] = createSignal<VoiceLayout>();
    this.layout = layout;
    this.#setLayout = setLayout;

    const [focus, setFocus] = createSignal<string>();
    this.focusId = focus;
    this.#setFocus = setFocus;

    const [showBar, setShowBar] = createSignal(true);
    this.showBar = showBar;
    this.#setShowBar = setShowBar;

    const inst = useInstance();
    this.config = inst.config;
    this.limits = inst.limits;
    this.openModal = modals.openModal;
    this.getClient = useClient();

    this.screenShareTracks = new Set();

    // Setup settings listeners
    this.settingsListeners();
  }

  // Dynamically set echo cancellation and gain control when the settings are changed
  // These functions are needed to maintain reactivity. Don't ask me why but if you make them not functions it breaks.
  private settingsListeners() {
    const getSettings = () => this.#settings;

    const setEchoCancellation = (echoCancellation: boolean) => {
      const track = this.getMicrophoneTrack()?.audioTrack;
      if (track) {
        track.constraints.echoCancellation = echoCancellation;
      }
    };

    const setAutoGainControl = (autoGainControl: boolean) => {
      const track = this.getMicrophoneTrack()?.audioTrack;
      if (track) {
        track.constraints.autoGainControl = autoGainControl;
      }
    };

    const setNoiseSuppression = (noiseSuppression: NoiseSuppresionState) => {
      const track = this.getMicrophoneTrack()?.audioTrack;
      if (track) {
        if (noiseSuppression === "browser") {
          track.constraints.noiseSuppression = true;
          //@ts-expect-error voiceIsolation is not yet standard, but it supported by livekit and most chromium based browsers, including electron.
          track.constraints.voiceIsolation = true;
        } else {
          track.constraints.noiseSuppression = false;
          //@ts-expect-error voiceIsolation is not yet standard, but it supported by livekit and most chromium based browsers, including electron.
          track.constraints.voiceIsolation = false;
        }
      }
    };

    const restartTrack = () => {
      const track = this.getMicrophoneTrack()?.audioTrack;
      if (track) {
        track.restartTrack();
      }
    };

    createEffect(() => {
      setEchoCancellation(getSettings().echoCancellation ?? true);
      setAutoGainControl(getSettings().autoGainControl ?? true);
      setNoiseSuppression(getSettings().noiseSupression ?? "browser");
      restartTrack();
    });
  }

  async connect(channel: Channel, auth?: { url: string; token: string }) {
    this.disconnect();

    const e2eeKeyProvider = new ExternalE2EEKeyProvider();
    this.#e2eeKeyProvider = e2eeKeyProvider;
    this.device.setWakeLocked();

    const room = new Room({
      // El servidor y el emisor envían solo la calidad que se ve de verdad
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: {
        deviceId: this.#settings.preferredAudioInputDevice,
        echoCancellation: this.#settings.echoCancellation,
        noiseSuppression: this.#settings.noiseSupression === "browser",
        autoGainControl: this.#settings.autoGainControl,
        voiceIsolation: this.#settings.noiseSupression === "browser",
      },
      audioOutput: {
        deviceId: this.#settings.preferredAudioOutputDevice,
      },
      videoCaptureDefaults: {
        // TODO: Support higher resolutions based on limits
        resolution: VideoPresets.h720.resolution,
        deviceId: this.#settings.preferredVideoDevice,
      },
      encryption: {
        keyProvider: e2eeKeyProvider,
        worker: new Worker(
          new URL("livekit-client/e2ee-worker", import.meta.url),
        ),
      },
      publishDefaults: {
        videoEncoding: VideoPresets.h720.encoding,
        screenShareEncoding: ScreenSharePresets.h720fps30.encoding,
        // ante falta de ancho de banda: bajar nitidez antes que fotogramas
        degradationPreference: "maintain-framerate",
        simulcast: true,
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
          .setMicrophoneEnabled(this.#settings.micOn && !this.#settings.deafen)
          .then((track) => {
            this.#settings.micOn = track != null;
          });
      for (const p of room.remoteParticipants.values()) {
        const screenShareTrack = p.getTrackPublication(
          Track.Source.ScreenShare,
        );
        if (screenShareTrack) {
          this.screenShareTracks.add(screenShareTrack.trackSid);
        }
        this.#applyStreamSubscription(p);
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
        await ensureDeviceKeyUploaded(
          this.getClient() as unknown as Parameters<typeof ensureDeviceKeyUploaded>[0],
        );

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
        this.#e2eeKeyProvider?.setKey(rawKey as unknown as ArrayBuffer);
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

    // Streams bajo demanda: cuando alguien empieza a compartir pantalla, no se
    // descarga hasta que el usuario pulse «Ver stream».
    room.on(RoomEvent.TrackPublished, (publication, participant) => {
      if (
        publication.source === Track.Source.ScreenShare ||
        publication.source === Track.Source.ScreenShareAudio
      ) {
        this.#applyStreamSubscription(participant);
      }
    });
    room.on(RoomEvent.TrackUnpublished, (publication, participant) => {
      // si deja de compartir, la próxima vez hay que volver a pulsar «Ver»
      if (publication.source === Track.Source.ScreenShare) {
        const next = new Set(this.#watching[0]());
        if (next.delete(participant.identity)) this.#watching[1](next);
      }
    });

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
      let message: { type?: string; ms?: number; fileId?: string; volume?: number };
      try {
        message = JSON.parse(pingDecoder.decode(payload));
      } catch {
        return;
      }
      if (message.type === "starknet-soundboard") {
        this.#onRemoteSoundboard(participant.identity, message);
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

        room.addListener("localTrackPublished", (pub) => {
      if (pub.audioTrack && pub.audioTrack.source === Track.Source.Microphone) {
        if (!pub.audioTrack.getProcessor()) {
          pub.audioTrack?.setProcessor(
            (this.voiceProcessor = new VoiceProcessor(this.#settings)),
          );
        }
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
            const res = await (
              this.getClient().api as unknown as {
                get(path: string): Promise<{
                  devices: { public_key: JsonWebKey; device_id: string }[];
                }>;
              }
            ).get(`/e2ee/devices/${participant.identity}`);
            for (const device of res.devices) {
              const theirPublicKey = await importPublicKey(device.public_key);
              const callKeyObj = await crypto.subtle.importKey(
                "raw",
                this.#e2eeCallKeyBytes! as BufferSource,
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
      this.config.features.livekit.nodes.map(async (node) => {
        return fetch(node.public_url.replace("wss", "https")).then(() => {
          return node.name;
        });
      }),
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
    void this.#appAudio.stop();
    this.device.releaseWakeLock();
    try {
      const room = this.room();
      if (!room) return;

      room.removeAllListeners();
      room.disconnect();

      batch(() => {
        // Ensordecer es un estado de la llamada: al salir se limpia para que la
        // siguiente no empiece sin oír a nadie.
        this.#settings.deafen = false;
        this.#setState("READY");
        this.#setConnectionQuality(ConnectionQuality.Unknown);
        this.#stopPingPolling();
        this.#e2eeCallKeyBytes = undefined;
        this.#e2eeKeyProvider = undefined;
        this.#setE2eeActive(false);
        this.#setRoom();
        this.#setChannel();
        this.#setLayout();
        this.vidTracks = () => [];
      });

      this.screenShareTracks = new Set();
      this.#watching[1](new Set<string>());

      this.sound.playSound("userLeaveVoice");
    } catch (e) {
      this.onErr(e);
    }
  }

  async toggleDeafen(fromMute?: boolean) {
    try {
      const room = this.room();
      if (!room) throw "invalid state";

      // Estado destino calculado desde el ajuste, no desde el estado real del
      // micrófono: así, aunque ambos se hayan desincronizado, un clic siempre
      // deja la sesión en un estado coherente.
      const deafen = !this.#settings.deafen;
      const wantMic = deafen
        ? false
        : this.speakingPermission && (!!fromMute || this.#settings.micOn);

      await room.localParticipant.setMicrophoneEnabled(wantMic);

      this.#settings.deafen = deafen;
      void publishDeafened(room.localParticipant, deafen);
      if (fromMute && !deafen) {
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

  /**
   * Reproduce un sonido del soundboard en la llamada actual, mezclado en el
   * audio saliente de nuestro micrófono para que el resto de participantes
   * lo oigan igual que si fuese voz normal (mismo cifrado, misma ruta, sin
   * protocolo aparte).
   * @param fileId ID del adjunto de Autumn con el audio del sonido
   * @param volume Volumen lineal del sonido (0 a 2), ya multiplicado por el
   * volumen maestro del soundboard
   */
  async playSoundboardSound(fileId: string, volume: number): Promise<void> {
    try {
      const buffer = await this.loadSoundboardBuffer(fileId);

      // Local: con NUESTRO volumen maestro
      await this.#playSoundboardLocal(buffer, volume * this.soundboardMaster());

      // Resto de la llamada: se les envía la orden (no el audio), y cada
      // cliente lo reproduce con SU propio volumen maestro.
      const room = this.room();
      if (room && !this.#settings.deafen) {
        try {
          await room.localParticipant.publishData(
            new TextEncoder().encode(
              JSON.stringify({ type: "starknet-soundboard", fileId, volume }),
            ),
            { reliable: true },
          );
        } catch (e) {
          voiceLog("warn", "soundboard: no se pudo enviar el sonido a la llamada", e);
        }
      }
    } catch (e) {
      voiceLog("error", "soundboard: no se pudo reproducir el sonido", e);
      console.error("[soundboard] no se pudo reproducir el sonido:", e);
    }
  }

  async #playSoundboardLocal(buffer: AudioBuffer, gainValue: number) {
    const ctx = this.#soundboardDecodeContext;
    if (!ctx) return;
    if (ctx.state !== "running") await ctx.resume().catch(() => {});
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    // Limitador de seguridad para que nunca sature
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.1;
    source.buffer = buffer;
    gain.gain.value = gainValue;
    source.connect(gain);
    gain.connect(limiter);
    limiter.connect(ctx.destination);
    source.addEventListener("ended", () => {
      source.disconnect();
      gain.disconnect();
      limiter.disconnect();
    });
    source.start();
  }

  /** Otro participante ha lanzado un sonido: se reproduce en local */
  #onRemoteSoundboard(
    identity: string,
    message: { fileId?: string; volume?: number },
  ) {
    const fileId = message.fileId;
    if (typeof fileId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(fileId)) return;
    if (this.#settings.deafen) return;
    if (this.#settings.getUserMuted(identity)) return;

    // Anti-spam: un sonido por participante cada 250 ms
    const now = Date.now();
    if (now - (this.#lastSoundboardFrom.get(identity) ?? 0) < 250) return;
    this.#lastSoundboardFrom.set(identity, now);

    const sent =
      typeof message.volume === "number" && isFinite(message.volume)
        ? Math.min(2, Math.max(0, message.volume))
        : 1;
    const gainValue =
      sent *
      this.soundboardMaster() *
      Math.min(2, this.#settings.getUserVolume(identity));

    void (async () => {
      try {
        const buffer = await this.loadSoundboardBuffer(fileId);
        await this.#playSoundboardLocal(buffer, gainValue);
      } catch (e) {
        voiceLog("error", "soundboard: no se pudo reproducir el sonido remoto", e);
      }
    })();
  }

  /**
   * Descarga y decodifica un sonido del soundboard, cacheando el resultado
   * por fileId para que reproducirlo de nuevo sea instantáneo.
   */
  private loadSoundboardBuffer(fileId: string): Promise<AudioBuffer> {
    const cached = this.#soundboardBufferCache.get(fileId);
    if (cached) return cached;

    const promise = (async () => {
      const autumnUrl = this.config.features.autumn.url;
      const res = await fetch(`${autumnUrl}/attachments/${fileId}`);
      if (!res.ok) {
        throw new Error(`No se pudo descargar el sonido (HTTP ${res.status})`);
      }
      const arrayBuffer = await res.arrayBuffer();

      if (!this.#soundboardDecodeContext) {
        this.#soundboardDecodeContext = new AudioContext();
      }
      const decoded =
        await this.#soundboardDecodeContext.decodeAudioData(arrayBuffer);
      voiceLog("info", `soundboard: sonido ${fileId} decodificado (${decoded.duration.toFixed(1)} s)`);
      return decoded;
    })();

    // Si falla, no dejamos la promesa rota en caché — así un próximo intento
    // (p. ej. tras recuperar la conexión) puede volver a intentarlo.
    promise.catch(() => this.#soundboardBufferCache.delete(fileId));

    this.#soundboardBufferCache.set(fileId, promise);
    return promise;
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
        encoding: ScreenSharePresets.h720fps30.encoding,
      },
    };

    const limit = this.limits().video_resolution;

    // TODO: Add more resolutions to stream from if they're enabled. May tie into premium users in the future?
    if (
      (limit[0] === 0 || limit[0] >= 1920) &&
      (limit[1] === 0 || limit[1] >= 1080)
    ) {
      qualities.high = {
        name: "high",
        resolution: ScreenSharePresets.h1080fps30.resolution,
        fullName: `1080p 30FPS`,
        contentHint: "motion",
        encoding: ScreenSharePresets.h1080fps30.encoding,
      };
      const originalResolution = ScreenSharePresets.original.resolution;
      originalResolution.frameRate = 5;
      originalResolution.aspectRatio = 0;

      const limit = this.limits().video_resolution;
      originalResolution.width = limit[0];
      originalResolution.height = limit[1];
      // If both resolutions are limited, set aspect ratio
      if (originalResolution.height !== 0 && originalResolution.width !== 0) {
        originalResolution.aspectRatio =
          originalResolution.width / originalResolution.height;
      }

      qualities.text = {
        name: "text",
        resolution: originalResolution,
        fullName: `Source 5FPS`,
        contentHint: "text",
        encoding: ScreenSharePresets.original.encoding,
      };
    }

    return qualities;
  }

  async toggleScreenshare() {
    const room = this.room();
    if (!room) throw "invalid state";

    if (this.screenshare()) {
      await this.#appAudio.stop();
      await room.localParticipant.setScreenShareEnabled(false);

      this.#setScreenshare(room.localParticipant.isScreenShareEnabled);

      this.sound.playSound("streamEnd");
    } else {
      const qualities = this.getEnabledScreenShareQualities();
      let screenPickerQualityName: ScreenShareQualityName | undefined;
      let screenPickerAudio: boolean | undefined;

      // Audio solo de la ventana compartida (escritorio Windows)
      if (AppAudioShare.supported()) this.#appAudio.listen(room);

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
        const chosenQuality =
          this.getEnabledScreenShareQualities()[
            this.#settings.screenShareQuality || "low"
          ];
        const localTrack = await room.localParticipant.setScreenShareEnabled(
          true,
          {
            resolution: chosenQuality?.resolution,
            audio: {
              autoGainControl: false,
              echoCancellation: false,
              noiseSuppression: false,
              voiceIsolation: false,
              restrictOwnAudio: true,
            },
          },
          {
            screenShareEncoding: chosenQuality?.encoding,
            // capas extra para que cada espectador reciba la que su conexión
            // aguanta y uno con mala red no afecte a los demás
            simulcast: chosenQuality?.name !== "text",
            screenShareSimulcastLayers:
              chosenQuality?.name === "high"
                ? [ScreenSharePresets.h360fps15, ScreenSharePresets.h720fps15]
                : chosenQuality?.name === "text"
                  ? []
                  : [ScreenSharePresets.h360fps15],
            degradationPreference:
              chosenQuality?.name === "text"
                ? "maintain-resolution"
                : "maintain-framerate",
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
            void this.#appAudio.stop();
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
              await localTrack.videoTrack.applyScreenShareConstraints(
                {
                  resolution: {
                    frameRate: quality.resolution.frameRate,
                    width: quality.resolution.width,
                    height: quality.resolution.height,
                  },
                  contentHint: quality.contentHint,
                },
                quality.encoding,
              );
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
                  await this.#appAudio.stop();
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
        // Cancelar el selector de pantalla no es un error: el navegador/Electron
        // rechaza la promesa con NotAllowedError, NotFoundError o AbortError.
        const name = (e as Error)?.name;
        if (name !== "NotFoundError" && name !== "AbortError") {
          this.onErr(e);
        }
      }
    }
  }

  resetLayout() {
    this.#setLayout();
  }

  toggleLayout(type: VoiceLayout) {
    this.#setLayout((l) => (l === type ? undefined : type));
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

  getMicrophoneTrack(): LocalTrackPublication | undefined {
    const track = this.room()?.localParticipant.getTrackPublication(
      Track.Source.Microphone,
    );
    return track;
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
  const device = useDevice();
  const voice = new Voice(state.voice, modals, sound, device);
  voice.soundboardMaster = () => state.soundboard.masterVolume;

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
