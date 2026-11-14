import { Show, createEffect, createSignal, onMount } from "solid-js";

import { Trans } from "@lingui/solid/macro";
import { styled } from "styled-system/jsx";

import { useClientLifecycle } from "@revolt/client";
import { useInstance } from "@revolt/instance";
import { useModals } from "@revolt/modal";
import { useNavigate } from "@revolt/routing";
import { useState } from "@revolt/state";
import { Text } from "@revolt/ui";

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string;
            callback: (response: { credential: string }) => void;
          }) => void;
          renderButton: (
            parent: HTMLElement,
            options: Record<string, unknown>,
          ) => void;
        };
      };
    };
  }
}

/**
 * En la app de escritorio, Google rechaza el inicio de sesion dentro de la
 * propia ventana ("navegador o aplicacion no seguros"), asi que se hace en el
 * navegador del sistema a traves de la app (ver googleAuth.ts del escritorio).
 */
type NativeGoogle = {
  googleSignIn?: (
    clientId: string,
  ) => Promise<{ idToken?: string; error?: string }>;
};
const nativeGoogle = () =>
  (window as unknown as { native?: NativeGoogle }).native?.googleSignIn;

const GSI_SCRIPT_SRC = "https://accounts.google.com/gsi/client";

let gsiScriptPromise: Promise<void> | undefined;

/**
 * Load Google Identity Services' script once, however many times this
 * component ends up mounted (login flow, create-account flow, ...).
 */
export function loadGoogleIdentityScript(): Promise<void> {
  if (window.google?.accounts?.id) {
    return Promise.resolve();
  }

  if (!gsiScriptPromise) {
    gsiScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = GSI_SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () =>
        reject(new Error("Failed to load Google Identity Services"));
      document.head.appendChild(script);
    });
  }

  return gsiScriptPromise;
}

const Wrapper = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "14px",
    width: "100%",
  },
});

const Divider = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    width: "100%",
    color: "var(--md-sys-color-on-surface-variant)",
    fontSize: "0.8rem",

    "&::before": {
      content: '""',
      flex: 1,
      height: "1px",
      background: "var(--md-sys-color-outline-variant)",
    },
    "&::after": {
      content: '""',
      flex: 1,
      height: "1px",
      background: "var(--md-sys-color-outline-variant)",
    },
  },
});

const NativeButton = styled("button", {
  base: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "10px",
    width: "320px",
    maxWidth: "100%",
    height: "40px",
    borderRadius: "20px",
    border: "1px solid #747775",
    background: "#131314",
    color: "#e3e3e3",
    font: "500 14px/20px Roboto, system-ui, sans-serif",
    cursor: "pointer",

    "&:hover": { background: "#1e1f20" },
    "&:disabled": { opacity: 0.6, cursor: "default" },
  },
});

const ButtonSlot = styled("div", {
  base: {
    display: "flex",
    justifyContent: "center",
    width: "100%",
    minHeight: "40px",
  },
});

/**
 * "Sign in with Google" button for the login / create-account flows.
 *
 * Signing in and signing up are the exact same action on the backend
 * (`POST /auth/session/login` with an `id_token`): an unrecognised,
 * verified Google account is created on the spot, an already-linked one
 * just logs in. So this one button covers both the login and the
 * create-account flow — there's nothing extra to "register" with Google.
 *
 * Renders nothing if the instance hasn't configured Google sign-in
 * (`[google_oauth] client_id` in Revolt.toml).
 */
export function GoogleSignInButton() {
  const { config } = useInstance();
  const { login, isLoggedIn } = useClientLifecycle();
  const modals = useModals();
  const navigate = useNavigate();
  const state = useState();

  // Flips true once our own login() call resolves, so the effect below
  // only fires the redirect for a login that happened on this screen —
  // not on initial mount for some unrelated reason.
  const [loggingIn, setLoggingIn] = createSignal(false);

  // The session comes back from login() marked `valid: false` — it only
  // becomes valid once the websocket finishes connecting (see
  // Controller.ts: `markValid()` runs on `State.Connected`), and a session
  // that isn't valid yet gets dropped on reload. So instead of navigating
  // the moment login() resolves (too early — same bug as a hard reload
  // racing the socket), wait for `isLoggedIn()` to actually flip, same
  // signal the password flow's <Navigate> in FlowLogin reacts to.
  createEffect(() => {
    if (loggingIn() && isLoggedIn()) {
      navigate(state.layout.popNextPath() ?? "/app", { replace: true });
    }
  });

  // `features.google` isn't in the generated `stoat-api` types yet, since
  // it's an addition specific to this fork's backend.
  const google = (
    config.features as unknown as {
      google?: { enabled: boolean; client_id: string };
    }
  ).google;

  const clientId = google?.enabled ? google.client_id : undefined;

  const [failed, setFailed] = createSignal(false);
  let buttonSlot: HTMLDivElement | undefined;

  const [nativeBusy, setNativeBusy] = createSignal(false);
  const useNative = () => !!nativeGoogle();

  async function nativeSignIn() {
    const start = nativeGoogle();
    if (!clientId || !start || nativeBusy()) return;
    setNativeBusy(true);
    try {
      const result = await start(clientId);
      if (result.idToken) {
        await login(
          { id_token: result.idToken } as unknown as Parameters<typeof login>[0],
          modals,
        );
        setLoggingIn(true);
      } else {
        console.warn("Google sign-in not completed:", result.error);
      }
    } catch (err) {
      console.error("Google sign-in failed:", err);
    } finally {
      setNativeBusy(false);
    }
  }

  onMount(() => {
    if (!clientId || useNative()) return;

    loadGoogleIdentityScript()
      .then(() => {
        window.google!.accounts.id.initialize({
          client_id: clientId,
          callback: (response) => {
            // `id_token` is a custom `DataLogin` variant this fork's
            // backend understands; the npm `stoat-api` package doesn't
            // know about it, hence the cast.
            login(
              { id_token: response.credential } as unknown as Parameters<
                typeof login
              >[0],
              modals,
            )
              .then(() => setLoggingIn(true))
              .catch((err) => {
                console.error("Google sign-in failed:", err);
              });
          },
        });

        if (buttonSlot) {
          window.google!.accounts.id.renderButton(buttonSlot, {
            type: "standard",
            theme: "filled_black",
            size: "large",
            shape: "pill",
            text: "continue_with",
            width: 320,
          });
        }
      })
      .catch((err) => {
        console.error(err);
        setFailed(true);
      });
  });

  if (!clientId) return null;

  return (
    <Show when={!failed()}>
      <Wrapper>
        <Divider>
          <Text size="small">
            <Trans>or</Trans>
          </Text>
        </Divider>
        <Show
          when={useNative()}
          fallback={<ButtonSlot ref={buttonSlot} />}
        >
          <NativeButton
            type="button"
            disabled={nativeBusy()}
            onClick={() => void nativeSignIn()}
          >
            <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
              <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/>
              <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z"/>
              <path fill="#FBBC05" d="M10.5 28.7c-.5-1.5-.8-3.1-.8-4.7s.3-3.2.8-4.7l-7.9-6.1C.9 16.4 0 20.1 0 24s.9 7.6 2.6 10.8l7.9-6.1z"/>
              <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.9 2.3-8.4 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/>
            </svg>
            <Trans>Continue with Google</Trans>
          </NativeButton>
        </Show>
      </Wrapper>
    </Show>
  );
}
