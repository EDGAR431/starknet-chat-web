import { Show, createResource } from "solid-js";

import { Trans } from "@lingui/solid/macro";
import { styled } from "styled-system/jsx";

import { Symbol } from "@revolt/ui/components/utils/Symbol";

/** Mismo instalador que ofrece Ajustes > Aplicaciones */
const UPDATES_BASE = "/desktop-updates/win32/x64";
const INSTALLER_URL = `${UPDATES_BASE}/starknetchat-desktop-setup.exe`;

const isMobileDevice = () =>
  /android|iphone|ipad|ipod/i.test(navigator.userAgent);

async function installerAvailable() {
  try {
    const res = await fetch(`${UPDATES_BASE}/RELEASES`, {
      method: "HEAD",
      cache: "no-store",
    });
    return res.ok;
  } catch {
    return false;
  }
}

const Link = styled("a", {
  base: {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    padding: "10px 16px",
    color: "var(--md-sys-color-primary)",
    border: "1px solid var(--md-sys-color-outline-variant)",
    borderRadius: "999px",
    fontSize: "0.875rem",
    fontWeight: 650,
    whiteSpace: "nowrap",
    textDecoration: "none",
    transition: "background 150ms ease, border-color 150ms ease",

    "&:hover": {
      background: "var(--md-sys-color-surface-container)",
      borderColor: "var(--md-sys-color-primary)",
    },

    "@media (max-width: 900px)": {
      padding: "8px 12px",
      fontSize: "0.78rem",
    },
  },
});

/**
 * Botón de descarga del instalador de Windows para la pantalla de acceso.
 * Oculto en la app de escritorio, en móviles y mientras no haya instalador.
 */
export function DesktopDownload() {
  const [available] = createResource(installerAvailable);

  return (
    <Show when={!window.native && !isMobileDevice() && available()}>
      <Link href={INSTALLER_URL} download="" rel="noopener">
        <Symbol size={18}>download</Symbol>
        <Trans>Download for Windows</Trans>
      </Link>
    </Show>
  );
}
