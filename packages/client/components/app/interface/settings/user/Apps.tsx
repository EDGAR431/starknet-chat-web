import { Show, createResource } from "solid-js";

import { Trans } from "@lingui/solid/macro";

import { CategoryButton, Column, Text } from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

/** Instalador directo (se actualiza solo). Lo publica scripts/publish-update.ps1 */
const UPDATES_BASE = "/desktop-updates/win32/x64";
const DIRECT_INSTALLER_URL = `${UPDATES_BASE}/starknetchat-desktop-setup.exe`;

/** true si ya hay una version directa publicada en el servidor */
async function directInstallerAvailable() {
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

function open(url: string) {
  window.open(url, "_blank", "noopener");
}

/**
 * Pagina "Aplicaciones": descargar la app de escritorio.
 * (La opcion de la Microsoft Store se anadira mas adelante.)
 * Solo se muestra en la web (dentro de la app de escritorio no tiene sentido).
 */
export function AppsSettings() {
  const [directAvailable] = createResource(directInstallerAvailable);

  return (
    <Column gap="lg">
      <CategoryButton.Group>
        <CategoryButton
          icon={<Symbol>download</Symbol>}
          description={
            <Show
              when={directAvailable()}
              fallback={<Trans>Not available yet. Coming soon.</Trans>}
            >
              <Trans>
                Windows installer. It updates itself in the background.
              </Trans>
            </Show>
          }
          onClick={() => directAvailable() && open(DIRECT_INSTALLER_URL)}
        >
          <Trans>Download for Windows (installer)</Trans>
        </CategoryButton>
      </CategoryButton.Group>

      <Show when={directAvailable()}>
        <Text class="label">
          <Trans>
            If Windows SmartScreen warns you when opening the installer, choose
            "More info" and then "Run anyway". The installer is not signed yet.
          </Trans>
        </Text>
      </Show>
    </Column>
  );
}
