import { JSX, createSignal, onCleanup, onMount, Show } from "solid-js";
import {
  TrackReference,
  useEnsureParticipant,
  useIsMuted,
  useIsSpeaking,
  useTrackRefContext,
  VideoTrack,
} from "solid-livekit-components";

import { Track } from "livekit-client";
import { cva } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { UserContextMenu } from "@revolt/app";
import { useUser } from "@revolt/markdown/users";
import { useParticipantDeafened, useVoice } from "@revolt/rtc";
import { useState } from "@revolt/state";
import { Avatar } from "@revolt/ui/components/design";
import { Row } from "@revolt/ui/components/layout";
import { OverflowingText } from "@revolt/ui/components/utils";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { VoiceStatefulUserIcons } from "../VoiceStatefulUserIcons";

type TileProps = {
  focus?: boolean;
};

/**
 * Individual participant tile
 */
export function ParticipantTile(props: TileProps) {
  const voice = useVoice();
  const state = useState();
  const participant = useEnsureParticipant();
  const track = useTrackRefContext();
  const user = useUser(participant.identity);
  const selfDeafened = useParticipantDeafened(participant);

  let videoRef: HTMLVideoElement | undefined;

  const [videoDims, setVideoDims] = createSignal<{
    height: number;
    width: number;
  }>({ height: 0, width: 0 });

  const isMuted = useIsMuted({
    participant,
    source: Track.Source.Microphone,
  });

  const isScreenShareAudioMuted = useIsMuted({
    participant,
    source: Track.Source.ScreenShareAudio,
  });

  const isRemoteScreenShareMuted = useIsMuted({
    participant,
    source: Track.Source.ScreenShare,
  });

  const isScreenShareAudioUserMuted = () =>
    !user().user!.self && state.voice.getScreenShareMuted(user().user!.id)
      ? "by-user"
      : isScreenShareAudioMuted() || false;

  const isVideoMuted = useIsMuted({
    participant,
    source: Track.Source.Camera,
  });

  const isVideo = () => !isVideoMuted();
  const isScreenShare = () => track.source === Track.Source.ScreenShare;
  /** Pantalla de otra persona: solo se descarga al pulsar «Ver stream» */
  const isRemoteStream = () => isScreenShare() && !participant.isLocal;
  const watching = () =>
    !isRemoteStream() || voice.isWatching(participant.identity);
  const isSpeaking = useIsSpeaking(participant);

  const getHeight = () => {
    if (!props.focus || videoDims().height == 0) return {};
    // Calculate the aspect ratio
    const ratio = videoDims().width / videoDims().height;

    return ratio > 1
      ? { height: `min(var(--vc-w) / ${ratio}, 100%)` }
      : { height: "100%" };
  };

  return (
    <Show when={!isScreenShare() || !isRemoteScreenShareMuted()}>
      <div
        class={
          tile({
            speaking: !isScreenShare() && isSpeaking(),
            video: isVideo() || isScreenShare(),
            fullscreen: voice.layout() === "fullscreen",
            ...props,
          }) + (isScreenShare() ? " vc_tile group" : " vc_tile")
        }
        onClick={() => voice.toggleFocus(track)}
        use:floating={{
          // TODO: Conflicts with focusing, maybe only show if clicking name itself
          //   userCard: {
          //     user: user().user!,
          //     member: user().member,
          //   },
          contextMenu: () => (
            <UserContextMenu
              user={user().user!}
              member={user().member}
              inVoice={!isScreenShare()}
              isScreenshare={isScreenShare()}
            />
          ),
        }}
        style={{ ...getHeight() }}
      >
        <Show
          when={(isVideo() || isScreenShare()) && watching()}
          fallback={
            <Show
              when={isRemoteStream() && !watching()}
              fallback={
                <AvatarOnly>
                  <Avatar
                    src={user().avatar}
                    fallback={user().username}
                    size={48}
                    interactive={false}
                  />
                </AvatarOnly>
              }
            >
              <StreamGate>
                <Avatar
                  src={user().avatar}
                  fallback={user().username}
                  size={48}
                  interactive={false}
                />
                <GateButton
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    voice.setWatching(participant.identity, true);
                  }}
                >
                  <Symbol size={18}>visibility</Symbol>
                  Ver stream
                </GateButton>
              </StreamGate>
            </Show>
          }
        >
          <ZoomLayer enabled={isScreenShare()}>
            <VideoTrack
              style={{
                "grid-area": "1/1",
                "object-fit": "contain",
                width: "100%",
                height: "100%",
                overflow: "hidden",
              }}
              trackRef={track as TrackReference}
              manageSubscription={true}
              ref={videoRef}
              on:resize={() => {
                setVideoDims({
                  height: videoRef?.videoHeight || 0,
                  width: videoRef?.videoWidth || 0,
                });
              }}
            />
          </ZoomLayer>
        </Show>
        <Overlay showOnHover={isScreenShare()}>
          <OverlayInner>
            <OverflowingText>{user().username}</OverflowingText>
            <Show when={voice.remotePings().get(participant.identity)}>
              {(ms) => <PingLabel>{ms()} ms</PingLabel>}
            </Show>
            <Row gap="md">
              <Show when={isRemoteStream() && watching()}>
                <StopWatching
                  type="button"
                  title="Dejar de ver"
                  aria-label="Dejar de ver el stream"
                  onClick={(e) => {
                    e.stopPropagation();
                    voice.setWatching(participant.identity, false);
                  }}
                >
                  <Symbol size={18}>visibility_off</Symbol>
                </StopWatching>
              </Show>
              {isScreenShare() ? (
                <Show when={isScreenShareAudioUserMuted()}>
                  <Symbol
                    size={18}
                    color={
                      isScreenShareAudioUserMuted() === "by-user"
                        ? "var(--md-sys-color-error)"
                        : undefined
                    }
                  >
                    no_sound
                  </Symbol>
                </Show>
              ) : (
                <VoiceStatefulUserIcons
                  userId={participant.identity}
                  muted={isMuted()}
                  deafened={
                    user().user!.self
                      ? voice.deafen()
                      : selfDeafened() ||
                        voice.channel()?.voiceParticipants
                          .get(participant.identity)
                          ?.isReceiving() === false
                  }
                  camera={isVideo()}
                />
              )}
            </Row>
          </OverlayInner>
        </Overlay>
      </div>
    </Show>
  );
}

export const tile = cva({
  base: {
    display: "grid",
    aspectRatio: "16/9",
    transition: "all .3s ease, width 0s, height 0s",
    borderRadius: "var(--borderRadius-lg)",
    width: "var(--vc-tile-width)",
    maxWidth: "calc(var(--vc-h) * 16 / 9)",
    cursor: "pointer",

    color: "var(--md-sys-color-on-surface)",
    background: "#0002",

    overflow: "hidden",
    outlineWidth: "3px",
    outlineStyle: "solid",
    outlineOffset: "-3px",
    outlineColor: "transparent",
  },
  variants: {
    speaking: {
      true: {
        outlineColor: "var(--md-sys-color-primary)",
      },
    },
    focus: {
      true: {
        width: "auto",
        maxWidth: "none",
      },
    },
    video: {
      true: {},
    },
    fullscreen: {
      true: {
        minWidth: "20%",
      },
    },
  },
  compoundVariants: [
    {
      video: [false],
      focus: [true],
      css: {
        height: "100%",
        maxHeight: "calc(var(--vc-w) * 9 / 16)",
      },
    },
    {
      video: [true],
      focus: [true],
      css: {
        aspectRatio: "auto",
      },
    },
  ],
});

const AvatarOnly = styled("div", {
  base: {
    gridArea: "1/1",
    display: "grid",
    placeItems: "center",
    overflow: "hidden",

    // TODO: Refactor the avatar component to be reactive later.
    "& > *": {
      width: "auto !important",
      height: "30% !important",
      minHeight: "48px",
    },
  },
});

const Overlay = styled("div", {
  base: {
    minWidth: 0,
    gridArea: "1/1",

    padding: "var(--gap-md) var(--gap-lg)",

    opacity: 1,
    display: "flex",
    alignItems: "end",
    flexDirection: "row",

    transition: "var(--transitions-fast) all",
    transitionTimingFunction: "ease",
  },
  variants: {
    showOnHover: {
      true: {
        opacity: 0,

        _groupHover: {
          opacity: 1,
        },
      },
      false: {
        opacity: 1,
      },
    },
  },
  defaultVariants: {
    showOnHover: false,
  },
});

const OverlayInner = styled("div", {
  base: {
    minWidth: 0,

    display: "flex",
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",

    _first: {
      flexGrow: 1,
    },
  },
});

const PingLabel = styled("span", {
  base: {
    flexShrink: 0,
    marginLeft: "var(--gap-sm)",
    fontSize: "11px",
    opacity: 0.7,
  },
});

/**
 * Zoom del stream (como en la aplicación móvil): rueda del ratón para acercar
 * (1x a 6x, centrado en el cursor), arrastrar para mover y doble clic para
 * alternar entre 1x y 2,5x.
 */
function ZoomLayer(props: { enabled: boolean; children: JSX.Element }) {
  const [zoom, setZoom] = createSignal(1);
  const [pan, setPan] = createSignal({ x: 0, y: 0 });
  let box!: HTMLDivElement;
  let moved = 0;
  let suppressClick = false;
  let drag: { x: number; y: number; id: number } | undefined;

  const clampPan = (x: number, y: number, z: number) => ({
    x: Math.min(0, Math.max(x, -box.clientWidth * (z - 1))),
    y: Math.min(0, Math.max(y, -box.clientHeight * (z - 1))),
  });

  const zoomAt = (cx: number, cy: number, target: number) => {
    const z = zoom();
    const nz = Math.min(6, Math.max(1, target));
    if (nz === z) return;
    const p = pan();
    const ratio = nz / z;
    setZoom(nz);
    setPan(
      nz <= 1
        ? { x: 0, y: 0 }
        : clampPan(cx - (cx - p.x) * ratio, cy - (cy - p.y) * ratio, nz),
    );
  };

  const onWheel = (e: WheelEvent) => {
    if (!props.enabled) return;
    e.preventDefault();
    const r = box.getBoundingClientRect();
    zoomAt(
      e.clientX - r.left,
      e.clientY - r.top,
      zoom() * (e.deltaY < 0 ? 1.15 : 1 / 1.15),
    );
  };

  const onClickCapture = (e: MouseEvent) => {
    if (suppressClick) {
      suppressClick = false;
      e.stopPropagation();
      e.preventDefault();
    }
  };

  onMount(() => {
    box.addEventListener("wheel", onWheel, { passive: false });
    box.addEventListener("click", onClickCapture, true);
  });
  onCleanup(() => {
    box.removeEventListener("wheel", onWheel);
    box.removeEventListener("click", onClickCapture, true);
  });

  return (
    <div
      ref={box}
      style={{
        "grid-area": "1/1",
        overflow: "hidden",
        width: "100%",
        height: "100%",
        cursor: props.enabled && zoom() > 1 ? "grab" : undefined,
        "touch-action": props.enabled ? "none" : undefined,
      }}
      onPointerDown={(e) => {
        if (!props.enabled || zoom() <= 1 || e.button !== 0) return;
        drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
        moved = 0;
        box.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!drag || drag.id !== e.pointerId) return;
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        drag = { ...drag, x: e.clientX, y: e.clientY };
        moved += Math.abs(dx) + Math.abs(dy);
        const p = pan();
        setPan(clampPan(p.x + dx, p.y + dy, zoom()));
      }}
      onPointerUp={(e) => {
        if (!drag || drag.id !== e.pointerId) return;
        drag = undefined;
        suppressClick = moved > 4;
        // si no hubo clic posterior, no se deja la marca puesta
        setTimeout(() => (suppressClick = false), 0);
      }}
      onDblClick={(e) => {
        if (!props.enabled) return;
        const r = box.getBoundingClientRect();
        zoomAt(e.clientX - r.left, e.clientY - r.top, zoom() > 1 ? 1 : 2.5);
      }}
    >
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "grid",
          "transform-origin": "0 0",
          transform: `translate(${pan().x}px, ${pan().y}px) scale(${zoom()})`,
        }}
      >
        {props.children}
      </div>
    </div>
  );
}

const StreamGate = styled("div", {
  base: {
    gridArea: "1/1",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "var(--gap-md)",
    padding: "var(--gap-lg)",
  },
});

const GateButton = styled("button", {
  base: {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    padding: "var(--gap-md) var(--gap-xl)",
    border: "none",
    borderRadius: "var(--borderRadius-circle)",
    cursor: "pointer",
    font: "inherit",
    fontWeight: 600,
    color: "var(--md-sys-color-on-primary)",
    background: "var(--md-sys-color-primary)",
    _hover: { filter: "brightness(1.1)" },
    _focusVisible: {
      outline: "2px solid var(--md-sys-color-primary)",
      outlineOffset: "2px",
    },
  },
});

const StopWatching = styled("button", {
  base: {
    display: "grid",
    placeItems: "center",
    width: "28px",
    height: "28px",
    border: "none",
    borderRadius: "var(--borderRadius-circle)",
    cursor: "pointer",
    color: "inherit",
    background: "#0006",
    _hover: { background: "#0009" },
  },
});
