import { Trans } from "@lingui-solid/solid/macro";
import { ConnectionQuality } from "livekit-client";
import { createSignal, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { styled } from "styled-system/jsx";

import { useVoice } from "@revolt/rtc";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

export function VoiceCallCardStatus(props: { pip?: boolean }) {
  const voice = useVoice();
  const [expanded, setExpanded] = createSignal(false);
  const [panelPos, setPanelPos] = createSignal({ top: 0, left: 0 });

  let triggerRef: HTMLDivElement | undefined;

  const symbol = () => {
    switch (voice.state()) {
      case "CONNECTED":
        return "wifi_tethering";
      case "CONNECTING":
        return "wifi_tethering";
      case "DISCONNECTED":
        return "wifi_tethering_error";
      case "RECONNECTING":
        return "wifi_tethering";
      default:
        return "";
    }
  };

  // StarknetChat: color según la calidad real de conexión (LiveKit),
  // igual que el indicador de wifi de un móvil.
  const qualityColor = () => {
    switch (voice.connectionQuality()) {
      case ConnectionQuality.Excellent:
        return "var(--md-sys-color-primary)";
      case ConnectionQuality.Good:
        return "#e0a868";
      case ConnectionQuality.Poor:
        return "var(--md-sys-color-error)";
      default:
        return undefined;
    }
  };

  const qualityText = () => {
    switch (voice.connectionQuality()) {
      case ConnectionQuality.Excellent:
        return <Trans>Excellent connection</Trans>;
      case ConnectionQuality.Good:
        return <Trans>Good connection</Trans>;
      case ConnectionQuality.Poor:
        return <Trans>Poor connection</Trans>;
      default:
        return null;
    }
  };

  const text = () => {
    switch (voice.state()) {
      case "CONNECTED":
        return qualityText() ?? <Trans>Connected</Trans>;
      case "CONNECTING":
        return <Trans>Connecting</Trans>;
      case "DISCONNECTED":
        return <Trans>Disconnected</Trans>;
      case "RECONNECTING":
        return <Trans>Reconnecting</Trans>;
      default:
        return null;
    }
  };

  const isConnected = () => voice.state() === "CONNECTED";

  const toggle = () => {
    if (!isConnected()) return;
    if (!expanded() && triggerRef) {
      const rect = triggerRef.getBoundingClientRect();
      setPanelPos({ top: rect.bottom + 6, left: rect.left });
    }
    setExpanded((v) => !v);
  };

  return (
    <Wrapper pip={props.pip}>
      <Status
        ref={triggerRef}
        status={voice.state()}
        style={
          isConnected() && qualityColor() ? { color: qualityColor() } : undefined
        }
        onClick={toggle}
        clickable={isConnected()}
      >
        <Symbol>{symbol()}</Symbol>{" "}
        <FadeOut fade={isConnected()}>{text()}</FadeOut>
        <Show when={isConnected()}>
          <Symbol size={16}>
            {expanded() ? "expand_less" : "expand_more"}
          </Symbol>
        </Show>
      </Status>

      <Show when={expanded() && isConnected()}>
        <Portal>
          {/* Capa invisible que cierra el desplegable al hacer clic fuera */}
          <Backdrop onClick={() => setExpanded(false)} />
          <DetailsPanel
            style={{
              top: `${panelPos().top}px`,
              left: `${panelPos().left}px`,
            }}
          >
            <DetailRow>
              <Symbol size={16}>speed</Symbol>
              <span>
                {voice.pingMs() !== undefined ? (
                  `${voice.pingMs()} ms`
                ) : (
                  <Trans>Measuring…</Trans>
                )}
              </span>
            </DetailRow>
            <DetailRow>
              <Symbol
                size={16}
                color={
                  voice.e2eeActive()
                    ? "var(--md-sys-color-primary)"
                    : "var(--md-sys-color-outline)"
                }
              >
                {voice.e2eeActive() ? "lock" : "lock_open"}
              </Symbol>
              <span>
                {voice.e2eeActive() ? (
                  <Trans>End-to-end encrypted</Trans>
                ) : (
                  <Trans>Not encrypted</Trans>
                )}
              </span>
            </DetailRow>
          </DetailsPanel>
        </Portal>
      </Show>
    </Wrapper>
  );
}

const Wrapper = styled("div", {
  base: {
    position: "relative",
    display: "flex",
    zIndex: 1,
  },
  variants: {
    pip: {
      true: {
        position: "absolute",
        left: "var(--gap-md)",
        top: "var(--gap-md)",
      },
    },
  },
});

const Backdrop = styled("div", {
  base: {
    position: "fixed",
    inset: 0,
    zIndex: 9998,
  },
});

const DetailsPanel = styled("div", {
  base: {
    position: "fixed",
    zIndex: 9999,
    minWidth: "180px",
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
    padding: "var(--gap-md)",
    borderRadius: "var(--borderRadius-lg)",
    background: "var(--md-sys-color-surface-container-high)",
    boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
    fontSize: "13px",
    color: "var(--md-sys-color-on-surface)",
  },
});

const DetailRow = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
  },
});

const FadeOut = styled("div", {
  base: {
    paddingLeft: "var(--gap-md)",
  },
  variants: {
    fade: {
      true: {
        opacity: 0,
        fontSize: 0,
        paddingLeft: 0,
        transition:
          "opacity .3s 5s ease, font-size .3s 6s, padding-left .3s 6s",
      },
    },
  },
});

const Status = styled("div", {
  base: {
    flexShrink: 0,

    display: "flex",
    alignItems: "center",
    justifyContent: "center",

    _hover: {
      "& div": {
        opacity: 1,
        fontSize: "inherit",
        paddingLeft: "var(--gap-md)",
        transition: "opacity 0s 0s, font-size 0s 0s, padding-left 0s 0s",
      },
    },
  },
  variants: {
    status: {
      READY: {},
      CONNECTED: {
        color: "var(--md-sys-color-primary)",
      },
      CONNECTING: {
        color: "var(--md-sys-color-outline)",
      },
      DISCONNECTED: {
        color: "var(--md-sys-color-outline)",
      },
      RECONNECTING: {
        color: "var(--md-sys-color-outline)",
      },
    },
    clickable: {
      true: {
        cursor: "pointer",
      },
    },
  },
});
