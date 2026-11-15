import {
  Match,
  Show,
  Switch,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { Motion, Presence } from "solid-motionone";

import { css } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { useClientLifecycle } from "@revolt/client";
import { State, TransitionType } from "@revolt/client/Controller";
import { Button, Ripple, symbolSize, typography } from "@revolt/ui";

import MdBuild from "@material-symbols/svg-400/outlined/build.svg?component-solid";
import MdClose from "@material-symbols/svg-400/outlined/close.svg?component-solid";
import MdCollapseContent from "@material-symbols/svg-400/outlined/collapse_content.svg?component-solid";
import MdExpandContent from "@material-symbols/svg-400/outlined/expand_content.svg?component-solid";
import MdMinimize from "@material-symbols/svg-400/outlined/minimize.svg?component-solid";

import Wordmark from "../../../../public/assets/web/wordmark.svg?component-solid";
import {
  applyUpdateNow,
  pendingUpdate,
  updateWaitingLong,
} from "../../../../src/serviceWorkerInterface";

const isMacOS = navigator.platform.startsWith("Mac");
const isNative = !!window.native;

/**
 * Arrastre de respaldo. Normalmente `-webkit-app-region: drag` hace todo el
 * trabajo y estos eventos NO llegan a la página (el sistema se los queda). Si
 * por lo que sea la región nativa falla, el clic sí llega aquí y le pedimos a
 * la app de escritorio que mueva la ventana siguiendo el cursor.
 */
/** La ventana ocupa (casi) todo el area util del monitor: esta maximizada */
function fillsScreen(): boolean {
  try {
    return (
      window.outerWidth >= window.screen.availWidth - 16 &&
      window.outerHeight >= window.screen.availHeight - 16
    );
  } catch {
    return false;
  }
}

function isMaximisedNow(): boolean {
  return fillsScreen();
}

function fallbackDragHandlers(
  maximise: () => void,
  setDragging: (v: boolean) => void,
) {
  /** Envia una linea al registro del escritorio (drag-debug.log) */
  const log = (msg: string) => window.native?.dragLog?.(msg);

  return {
    onPointerDown: (e: PointerEvent & { currentTarget: HTMLElement }) => {
      if (!isNative || isMacOS || e.button !== 0) return;
      if ((e.target as HTMLElement).closest("a,button")) return;
      if (!window.native.dragStart) return;

      // El arrastre solo termina cuando se SUELTA el boton: pointerup, o un
      // movimiento que ya llega sin boton pulsado (por si el pointerup se
      // pierde al restaurar la ventana). Antes tambien terminaba con
      // pointercancel / lostpointercapture, que Windows dispara al restaurar la
      // ventana maximizada: el arrastre se cortaba justo al empezar.
      let finished = false;
      const end = (reason: string) => {
        if (finished) return;
        finished = true;
        setDragging(false);
        log(`web: fin (${reason})`);
        window.native.dragEnd?.();
        window.removeEventListener("pointerup", onUp, true);
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("pointercancel", onCancel, true);
        window.removeEventListener("blur", onBlur);
      };
      const onUp = (ev: PointerEvent) => end(`pointerup boton=${ev.button}`);
      const onMove = (ev: PointerEvent) => {
        if (ev.buttons === 0) end("movimiento sin boton");
      };
      // solo informativos: no cortan el arrastre
      const onCancel = () => log("web: pointercancel (ignorado)");
      const onBlur = () => log("web: blur de la ventana (ignorado)");

      window.addEventListener("pointerup", onUp, true);
      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointercancel", onCancel, true);
      window.addEventListener("blur", onBlur);

      log(
        `web: pointerdown x=${e.screenX} y=${e.screenY} maximizada=${isMaximisedNow()} outer=${window.outerWidth}x${window.outerHeight} avail=${window.screen.availWidth}x${window.screen.availHeight}`,
      );
      setDragging(true);
      window.native.dragStart();
    },
    onDblClick: (e: MouseEvent) => {
      if (!isNative || isMacOS) return;
      if ((e.target as HTMLElement).closest("a,button")) return;
      log("web: doble clic (maximizar/restaurar)");
      maximise();
    },
  };
}

export function Titlebar() {
  const [isMaximised, setIsMaximised] = createSignal(
    isNative ? window.desktopConfig.get().windowState.isMaximised : false,
  );
  const { lifecycle } = useClientLifecycle();

  // el escritorio avisa (>= 1.7) cuando la ventana se maximiza o se restaura,
  // por ejemplo al arrastrar la barra de una ventana maximizada
  onMount(() => window.native?.onMaximisedChange?.(setIsMaximised));

  function isDisconnected() {
    return [
      State.Connecting,
      State.Disconnected,
      State.Reconnecting,
      State.Offline,
    ].includes(lifecycle.state());
  }

  function maximise() {
    window.native.maximise();
    setIsMaximised((t) => !t);
  }

  // Mientras la ventana esta maximizada (o durante un arrastre nuestro) la
  // region nativa `drag` se quita: en Windows se come los clics sin mover nada
  // y solo dejaba arrastrar por los bordes. Asi el arrastre lo gestiona la web
  // en TODA la barra. Con la ventana normal se usa el arrastre nativo.
  const [dragging, setDragging] = createSignal(false);
  // Ademas del aviso del escritorio, se mira el tamano real de la ventana: si
  // el aviso no llega (escritorio antiguo, estado desincronizado) la barra no
  // se queda con la region nativa rota.
  const [fills, setFills] = createSignal(fillsScreen());
  onMount(() => {
    const check = () => setFills(fillsScreen());
    window.addEventListener("resize", check);
    onCleanup(() => window.removeEventListener("resize", check));
  });
  const dragRegion = () =>
    isMaximised() || fills() || dragging() ? "no-drag" : "drag";

  const dragHandlers = fallbackDragHandlers(maximise, setDragging);

  return (
    <Presence>
      <Show
        when={
          (isNative && window.desktopConfig?.get().customFrame) ||
          isDisconnected()
        }
      >
        <Motion.div
          initial={{ height: 0 }}
          animate={{ height: "29px" }}
          exit={{ height: 0 }}
          style={{ overflow: "hidden", "flex-shrink": 0 }}
        >
          <Base disconnected={isDisconnected()}>
            <Title
              macos={isMacOS}
              onPointerDown={dragHandlers.onPointerDown}
              onDblClick={dragHandlers.onDblClick}
              style={{
                "-webkit-user-select": "none",
                "-webkit-app-region": dragRegion(),
              }}
            >
              <Wordmark
                class={css({
                  height: "18px",
                  marginBlockStart: "1px",
                })}
              />{" "}
              <Show when={import.meta.env.DEV}>
                <MdBuild {...symbolSize(16)} />
              </Show>
            </Title>
            <DragHandle
              macos={isMacOS && isNative}
              onPointerDown={dragHandlers.onPointerDown}
              onDblClick={dragHandlers.onDblClick}
              style={{
                "-webkit-user-select": "none",
                "-webkit-app-region": dragRegion(),
              }}
            >
              <Switch>
                <Match when={lifecycle.state() === State.Connecting}>
                  Connecting
                </Match>
                {/* <Match when={lifecycle.state() === State.Connected}>Connected</Match> */}
                <Match when={lifecycle.state() === State.Disconnected}>
                  Disconnected
                  <a
                    onClick={() =>
                      lifecycle.transition({
                        type: TransitionType.Retry,
                      })
                    }
                  >
                    <strong> (reconnect now)</strong>
                  </a>
                </Match>
                <Match when={lifecycle.state() === State.Reconnecting}>
                  Reconnecting
                </Match>
                <Match when={lifecycle.state() === State.Offline}>
                  Device is offline
                  <a
                    onClick={() =>
                      lifecycle.transition({
                        type: TransitionType.Retry,
                      })
                    }
                    style={{
                      "-webkit-app-region": "no-drag",
                    }}
                  >
                    <strong> (reconnect now)</strong>
                  </a>
                </Match>
              </Switch>
              <Show when={pendingUpdate() && updateWaitingLong()}>
                {" "}
                <div
                  style={{
                    "-webkit-app-region": "no-drag",
                  }}
                >
                  <Button size="sm" onPress={() => void applyUpdateNow()}>
                    Update
                  </Button>
                </div>
              </Show>
            </DragHandle>
            <Show when={isNative && !isMacOS}>
              <Action onClick={window.native.minimise}>
                <Ripple />
                <MdMinimize {...symbolSize(20)} />
              </Action>
              <Action onClick={maximise}>
                <Ripple />
                <Show
                  when={isMaximised()}
                  fallback={<MdExpandContent {...symbolSize(20)} />}
                >
                  <MdCollapseContent {...symbolSize(20)} />
                </Show>
              </Action>
              <Action onClick={window.native.close}>
                <Ripple />
                <MdClose {...symbolSize(20)} />
              </Action>
            </Show>
          </Base>
        </Motion.div>
      </Show>
    </Presence>
  );
}

const Base = styled("div", {
  base: {
    flexShrink: 0,
    height: "29px",
    userSelect: "none",

    display: "flex",
    alignItems: "center",

    fill: "var(--md-sys-color-on-surface)",
  },
  variants: {
    disconnected: {
      true: {
        color: "var(--md-sys-color-on-primary-container)",
        background: "var(--md-sys-color-primary-container)",
      },
      false: {
        color: "var(--md-sys-color-outline)",
        background: "var(--md-sys-color-surface-container-high)",
      },
    },
  },
});

const Title = styled("div", {
  base: {
    display: "flex",
    gap: "var(--gap-md)",
    alignItems: "center",
    paddingInlineStart: "var(--gap-md)",

    color: "var(--md-sys-color-on-surface)",
    ...typography.raw({ class: "title", size: "small" }),
  },
  variants: {
    macos: {
      true: {
        order: 1,
        paddingInlineEnd: "var(--gap-md)",
      },
    },
  },
});

const DragHandle = styled("div", {
  base: {
    flexGrow: 1,
    height: "100%",

    display: "flex",
    gap: "var(--gap-md)",
    alignItems: "center",
    paddingInlineStart: "var(--gap-md)",

    ...typography.raw({ class: "label", size: "large" }),
  },
  variants: {
    macos: {
      true: {
        marginInlineStart: "70px",
      },
    },
  },
});

const Action = styled("a", {
  base: {
    cursor: "pointer",
    position: "relative",

    display: "grid",
    placeItems: "center",

    height: "100%",
    aspectRatio: "3/2",
  },
});
