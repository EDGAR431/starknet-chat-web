import {
  createEffect,
  createSignal,
  JSX,
  Match,
  onCleanup,
  onMount,
  Switch,
} from "solid-js";

import { Server } from "stoat.js";
import { styled } from "styled-system/jsx";

import { ChannelContextMenu, ServerContextMenu } from "@revolt/app";
import { MessageCache } from "@revolt/app/interface/channels/text/MessageCache";
import { Titlebar } from "@revolt/app/interface/desktop/Titlebar";
import { useClient, useClientLifecycle } from "@revolt/client";
import { State } from "@revolt/client/Controller";
import { NotificationsWorker } from "@revolt/client/NotificationsWorker";
import { CallRinger } from "@revolt/rtc";
import { VoiceShortcuts } from "@revolt/rtc/VoiceShortcuts";
import { useModals } from "@revolt/modal";
import { Navigate, useBeforeLeave, useLocation } from "@revolt/routing";
import { useState } from "@revolt/state";
import { LAYOUT_SECTIONS } from "@revolt/state/stores/Layout";
import { LoadingScreen } from "@revolt/ui";

import { SlideDrawer } from "../components/ui/components/navigation/SlideDrawer";
import { Sidebar } from "./interface/Sidebar";

/**
 * Application layout
 */
const Interface = (props: { children: JSX.Element }) => {
  const state = useState();
  const client = useClient();
  const { openModal } = useModals();
  const { isLoggedIn, lifecycle } = useClientLifecycle();
  const { pathname } = useLocation();

  useBeforeLeave((e) => {
    if (!e.defaultPrevented) {
      if (e.to === "/settings") {
        e.preventDefault();
        openModal({ type: "settings", config: "user" });
      } else if (typeof e.to === "string") {
        state.layout.setLastActivePath(e.to);
      }
    }
  });

  createEffect(() => {
    if (!isLoggedIn()) {
      state.layout.setNextPath(pathname);
      console.debug("WAITING... currently", lifecycle.state());
    }
  });

  function isDisconnected() {
    return [
      State.Connecting,
      State.Disconnected,
      State.Reconnecting,
      State.Offline,
    ].includes(lifecycle.state());
  }

  // Diagnostico (escritorio): si el boton de Inicio "no responde", queda
  // anotado en drag-debug.log que hay bajo el cursor y si el clic fue
  // cancelado por alguien, para localizar la causa.
  onMount(() => {
    const log = window.native?.dragLog;
    if (!log) return;
    const desc = (el: Element | null | undefined) =>
      el
        ? `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}.${String(
            (el as HTMLElement).className ?? "",
          ).slice(0, 50)}`
        : "null";
    const isHome = (t: EventTarget | null) =>
      !!(t as Element | null)?.closest?.('a[href="/app"]');
    const onDown = (e: PointerEvent) => {
      if (!isHome(e.target)) return;
      log(
        `inicio: pointerdown boton=${e.button} destino=${desc(e.target as Element)} bajoCursor=${desc(document.elementFromPoint(e.clientX, e.clientY))} ruta=${location.pathname}`,
      );
    };
    const onClick = (e: MouseEvent) => {
      if (!isHome(e.target)) return;
      log(`inicio: clic recibido ruta=${location.pathname}`);
      setTimeout(
        () =>
          log(
            `inicio: 300 ms despues ruta=${location.pathname} clicCancelado=${e.defaultPrevented}`,
          ),
        300,
      );
    };
    // Errores de la pagina (los que dejan "muerta" la interfaz hasta recargar)
    let errorCount = 0;
    const logError = (kind: string, detail: unknown) => {
      if (errorCount++ >= 150) return;
      let text: string;
      try {
        text =
          detail instanceof Error
            ? `${detail.message} | ${(detail.stack ?? "").split("\n").slice(0, 4).join(" > ")}`
            : typeof detail === "string"
              ? detail
              : JSON.stringify(detail);
      } catch {
        text = String(detail);
      }
      log(`ERROR ${kind} ruta=${location.pathname}: ${text.slice(0, 600)}`);
    };
    const onError = (e: ErrorEvent) => logError("error", e.error ?? e.message);
    const onRejection = (e: PromiseRejectionEvent) =>
      logError("promesa", e.reason);
    const origConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      try {
        logError(
          "consola",
          args
            .map((a) => (a instanceof Error ? (a.stack ?? a.message) : String(a)))
            .join(" "),
        );
      } catch {
        /* ignorar */
      }
      origConsoleError.apply(console, args as []);
    };
    // la ruta tambien se anota al cambiar, para ver el orden de los hechos
    let lastPath = location.pathname;
    const pathTimer = setInterval(() => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        log(`ruta -> ${lastPath}`);
      }
    }, 250);

    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    onCleanup(() => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      console.error = origConsoleError;
      clearInterval(pathTimer);
    });
  });

  //Drawer slider for mobile
  let rootRef, sDrawer: SlideDrawer | undefined;
  const [contRef, setContRef] = createSignal<HTMLDivElement>();
  function rstLayout() {
    state.layout.setSectionState(LAYOUT_SECTIONS.PRIMARY_SIDEBAR, false, false);
    state.layout.setSectionState(LAYOUT_SECTIONS.MEMBER_SIDEBAR, false, true);
  }
  createEffect(() => {
    //Create drawer
    const cont = contRef();
    if (cont && !sDrawer) sDrawer = new SlideDrawer(cont, rootRef!);
    //Update on layout change
    if (sDrawer) {
      const en = sDrawer.enabled;
      setTimeout(() => {
        state.setAppDrawer(en ? sDrawer : undefined);
        if (en) rstLayout();
      }, 1);
    }
  });
  onCleanup(() => {
    sDrawer?.delete();
    state.setAppDrawer((sDrawer = undefined));
  });

  return (
    <MessageCache client={client()}>
      <AppRoot ref={rootRef} class="app_root">
        <Titlebar />
        <Switch fallback={<LoadingScreen />}>
          <Match when={!isLoggedIn()}>
            <Navigate href="/login" />
          </Match>
          <Match when={lifecycle.loadedOnce()}>
            <Layout
              disconnected={isDisconnected()}
              style={{
                "flex-grow": 1,
                "min-height": 0,
                // In the desktop app (frameless window) everything below the
                // custom titlebar must never be a window-drag region, or the
                // header buttons (gear, back chevron...) stop receiving clicks.
                "-webkit-app-region": "no-drag",
              }}
              onDragOver={(e) => {
                if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
              }}
              onDrop={(e) => e.preventDefault()}
            >
              <Sidebar
                menuGenerator={(target) => ({
                  contextMenu: () => {
                    return (
                      <>
                        {target instanceof Server ? (
                          <ServerContextMenu server={target} />
                        ) : (
                          <ChannelContextMenu channel={target} />
                        )}
                      </>
                    );
                  },
                })}
              />
              <Content
                ref={setContRef}
                class="app_body"
                sidebar={state.layout.getSectionState(
                  LAYOUT_SECTIONS.PRIMARY_SIDEBAR,
                  true,
                )}
              >
                {props.children}
              </Content>
            </Layout>
          </Match>
        </Switch>

        <NotificationsWorker />
        <CallRinger />
        <VoiceShortcuts />
      </AppRoot>
    </MessageCache>
  );
};

const AppRoot = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
  },
});

/**
 * Parent container
 */
const Layout = styled("div", {
  base: {
    display: "flex",
    height: "100%",
    minWidth: 0,
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

/**
 * Main content container
 */
const Content = styled("div", {
  base: {
    background: "var(--md-sys-color-surface-container-low)",
    display: "flex",
    width: "100%",
    minWidth: 0,
  },
  variants: {
    sidebar: {
      false: {
        paddingLeft: "var(--gap-md)",
        borderTopLeftRadius: "var(--borderRadius-lg)",
        borderBottomLeftRadius: "var(--borderRadius-lg)",
        overflow: "hidden",

        _tablet: {
          paddingLeft: 0,
        },
      },
    },
  },
});

export default Interface;
