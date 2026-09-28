import {
  JSX,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";

import { Trans } from "@lingui/solid/macro";

import { applyConsoleMode, oskEnabled } from "@revolt/common/lib/consoleMode";
import { useModals } from "@revolt/modal";
import { useVoice } from "@revolt/rtc";

import { GamepadEngine, GamepadUiState, PadAction } from "./engine";
import "./gamepad.css";
import { OnScreenKeyboard } from "./OnScreenKeyboard";

const DEBUG_KEY = "starknet.gpdebug";

function debugEnabled(): boolean {
  try {
    const q = new URLSearchParams(location.search).get("gpdebug");
    if (q === "1") localStorage.setItem(DEBUG_KEY, "1");
    if (q === "0") localStorage.removeItem(DEBUG_KEY);
    return localStorage.getItem(DEBUG_KEY) === "1";
  } catch {
    return false;
  }
}

function Hint(props: { k: string; children: JSX.Element }) {
  return (
    <span class="gp-hint">
      <span class="gp-key" data-k={props.k}>
        {props.k}
      </span>
      {props.children}
    </span>
  );
}

/**
 * Conecta el motor de mando con la voz, los ajustes y muestra la ayuda de
 * botones. Se monta una vez, dentro de los proveedores de la aplicación.
 */
export function GamepadController() {
  const voice = useVoice();
  const { openModal } = useModals();

  const [ui, setUi] = createSignal<GamepadUiState>({
    connected: false,
    input: "pointer",
    layer: false,
    editing: false,
    adjusting: false,
    zone: "content",
  });
  const [dbg, setDbg] = createSignal("");
  const [oskOpen, setOskOpen] = createSignal(false);
  let engine: GamepadEngine | undefined;
  const showDebug = debugEnabled();

  const inCall = () => voice.state() === "CONNECTED";

  function onAction(action: PadAction) {
    switch (action) {
      case "toggleMute":
        if (inCall()) void voice.toggleMute();
        break;
      case "toggleDeafen":
        if (inCall()) void voice.toggleDeafen();
        break;
      case "openSettings":
        if (!ui().layer) openModal({ type: "settings", config: "user" });
        break;
    }
  }

  onMount(() => {
    applyConsoleMode();
    engine = new GamepadEngine({
      onAction,
      onState: setUi,
      inCall,
      // Al empezar a escribir con el mando se abre el teclado en pantalla
      onEditStart: () => {
        if (oskEnabled()) setOskOpen(true);
      },
    });
    engine.start();
    if (showDebug) {
      (window as unknown as { __gp?: GamepadEngine }).__gp = engine!;
    }

    let timer: number | undefined;
    if (showDebug) {
      timer = window.setInterval(() => {
        const d = engine!.debug();
        setDbg(
          `mando: ${d.pad}\nmapping: ${d.mapping}\nbotones: ${d.pressed.join(",") || "-"}\nejes: ${d.axes.join(", ")}\n` +
            `zona: ${d.zone} · capa: ${d.layer} · escribiendo: ${d.editing}\ncandidatos: ${d.candidates}\nactual: ${d.current}\núltima acción: ${d.last}\nfoco: ${document.hasFocus()} · visible: ${document.visibilityState} · mandos: ${(navigator.getGamepads?.() ?? []).filter(Boolean).length}`,
        );
      }, 200);
    }

    onCleanup(() => {
      engine?.stop();
      if (timer) clearInterval(timer);
    });
  });

  // Reserva sitio para la barra de botones para que no tape mensajes
  createEffect(() => {
    const on = ui().connected && ui().input === "gamepad" && !oskOpen();
    document.documentElement.classList.toggle("gp-hints-on", on);
  });
  onCleanup(() => document.documentElement.classList.remove("gp-hints-on"));

  // El teclado se cierra en cuanto se deja de escribir (o se pasa al ratón)
  createEffect(() => {
    if (!ui().editing || ui().input !== "gamepad") setOskOpen(false);
  });

  return (
    <>
      <OnScreenKeyboard
        open={oskOpen()}
        register={(h) => engine?.setOsk(h)}
        onClose={() => {
          setOskOpen(false);
          engine?.endEditing();
        }}
      />
      <Show when={ui().connected && ui().input === "gamepad" && !oskOpen()}>
        <div class="gp-hints" aria-hidden="true">
          <Show
            when={!ui().adjusting}
            fallback={
              <>
                <Hint k="◀ ▶">
                  <Trans>Adjust</Trans>
                </Hint>
                <Hint k="A/B">
                  <Trans>Confirm</Trans>
                </Hint>
              </>
            }
          >
            <Show
              when={!ui().editing}
              fallback={
                <Hint k="B">
                  <Trans>Done</Trans>
                </Hint>
              }
            >
              <Show
                when={ui().layer}
                fallback={
                  <>
                    <Hint k="A">
                      <Trans>Select</Trans>
                    </Hint>
                    <Hint k="B">
                      <Trans>Back</Trans>
                    </Hint>
                    <Hint k="X">
                      <Trans>Options</Trans>
                    </Hint>
                    <Hint k="Y">
                      <Trans>Write</Trans>
                    </Hint>
                    <Hint k="LB/RB">
                      <Trans>Zone</Trans>
                    </Hint>
                    <Hint k="≡">
                      <Trans>Settings</Trans>
                    </Hint>
                    <Show
                      when={inCall()}
                      fallback={
                        <Hint k="⧉">
                          <Trans>Voice</Trans>
                        </Hint>
                      }
                    >
                      <Hint k="⧉">
                        <Trans>Mute</Trans>
                      </Hint>
                      <Hint k="L3">
                        <Trans>Deafen</Trans>
                      </Hint>
                    </Show>
                  </>
                }
              >
                <Hint k="A">
                  <Trans>Select</Trans>
                </Hint>
                <Hint k="B">
                  <Trans>Close</Trans>
                </Hint>
              </Show>
            </Show>
          </Show>
        </div>
      </Show>
      <Show when={showDebug}>
        <div class="gp-debug">{dbg()}</div>
      </Show>
    </>
  );
}
