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

const GSI_SCRIPT_SRC = "https://accounts.google.com/gsi/client";

let gsiScriptPromise: Promise<void> | undefined;

/**
 * Load Google Identity Services' script once, however many times this
 * component ends up mounted (login flow, create-account flow, ...).
 */
function loadGoogleIdentityScript(): Promise<void> {
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

  onMount(() => {
    if (!clientId) return;

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
        <ButtonSlot ref={buttonSlot} />
      </Wrapper>
    </Show>
  );
}
