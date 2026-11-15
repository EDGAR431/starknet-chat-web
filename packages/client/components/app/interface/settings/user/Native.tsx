import { Match, Show, Switch, createSignal, onMount } from "solid-js";

import { Trans, useLingui } from "@lingui/solid/macro";

import { CategoryButton, Checkbox, Column } from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

declare type DesktopConfig = {
  firstLaunch: boolean;
  customFrame: boolean;
  minimiseToTray: boolean;
  startMinimisedToTray: boolean;
  spellchecker: boolean;
  hardwareAcceleration: boolean;
  discordRpc: boolean;
  windowState: {
    isMaximised: boolean;
  };
};

declare global {
  interface Window {
    native: {
      versions: {
        node(): string;
        chrome(): string;
        electron(): string;
        desktop(): string;
      };
      minimise(): void;
      maximise(): void;
      close(): void;
      /** arrastre de respaldo de la barra de título (≥ 1.7) */
      onMaximisedChange?(cb: (maximised: boolean) => void): void;
      /** actualizaciones propias (>= 1.7): busca ahora y devuelve el estado */
      /** atajos globales de voz (>= 1.7.2); resuelve con false en los que no se pudieron registrar */
      setVoiceShortcuts?(map: {
        mute: string;
        deafen: string;
      }): Promise<{ mute: boolean; deafen: boolean }>;
      onVoiceShortcut?(cb: (action: "mute" | "deafen") => void): void;
      checkForUpdates?(): Promise<
        "unsupported" | "up-to-date" | "downloading" | "ready" | "error"
      >;
      installUpdate?(): void;
      onUpdateReady?(cb: () => void): void;
      nativeOverlay?(): boolean;
      setTitleBarOverlay?(color: string, symbolColor: string): void;
      dragStart?(): void;
      dragEnd?(): void;
      dragLog?(message: string): void;
      onceScreenPicker(
        onScreenPick: (
          sources: {
            idx: number;
            name: string;
            isFullScreen: boolean;
            image?: string;
          }[],
        ) => void,
      ): void;
      screenPickerCallback(idx: number, audio: boolean): void;
      isWayland?(): Promise<boolean>;
      /** true si el audio compartido excluye las voces de la propia app (≥ 1.7) */
      loopbackExcludesApp?(): Promise<boolean>;
      /** Audio por aplicación al compartir una ventana (Windows, escritorio ≥ 1.7.8) */
      onAppAudioStart?(cb: () => void): void;
      onAppAudioChunk?(cb: (chunk: Uint8Array) => void): void;
      onAppAudioEnded?(cb: (reason: string) => void): void;
      stopAppAudio?(): void;
      /** Reinicia la aplicación de escritorio por completo (versión ≥ 1.5.5) */
      relaunch?(): void;
    };

    desktopConfig: {
      get(): DesktopConfig;
      set(config: Partial<DesktopConfig>): void;
      getAutostart(): Promise<boolean>;
      setAutostart(value: boolean): Promise<boolean>;
    };
  }
}

/**
 * Desktop Configuration Page
 */
export default function Native() {
  const { t } = useLingui();
  const [autostart, setAutostart] = createSignal(false);
  const [config, setConfig] = createSignal(window.desktopConfig.get());
  const [updateStatus, setUpdateStatus] = createSignal<
    | "idle"
    | "checking"
    | "unsupported"
    | "up-to-date"
    | "downloading"
    | "ready"
    | "error"
  >("idle");

  async function checkUpdates() {
    if (updateStatus() === "checking") return;
    if (updateStatus() === "ready") {
      window.native.installUpdate?.();
      return;
    }
    setUpdateStatus("checking");
    try {
      setUpdateStatus((await window.native.checkForUpdates!()) ?? "error");
    } catch {
      setUpdateStatus("error");
    }
  }

  function set(config: Partial<DesktopConfig>) {
    window.desktopConfig.set(config);
    setConfig((conf) => ({ ...conf, ...config }));
  }

  onMount(async () => {
    window.native.onUpdateReady?.(() => setUpdateStatus("ready"));
    const value = await window.desktopConfig.getAutostart();
    setAutostart(value);
  });

  async function toggleAutostart() {
    const newValue = !autostart();
    const savedValue = await window.desktopConfig.setAutostart(newValue);
    setAutostart(savedValue);
  }

  const toggles: Partial<Record<keyof DesktopConfig, () => void>> = {
    minimiseToTray: () => set({ minimiseToTray: !config().minimiseToTray }),
    startMinimisedToTray: () =>
      set({ startMinimisedToTray: !config().startMinimisedToTray }),
    customFrame: () => set({ customFrame: !config().customFrame }),
    discordRpc: () => set({ discordRpc: !config().discordRpc }),
    spellchecker: () => set({ spellchecker: !config().spellchecker }),
    hardwareAcceleration: () =>
      set({ hardwareAcceleration: !config().hardwareAcceleration }),
  };

  function CheckboxButton<K extends keyof Omit<DesktopConfig, "windowState">>(
    key: K,
    icon: string,
    label: string,
    description: string,
  ) {
    return (
      <CategoryButton
        action={<Checkbox checked={config()[key]} />}
        onClick={toggles[key]}
        icon={<Symbol>{icon}</Symbol>}
        description={description}
      >
        {label}
      </CategoryButton>
    );
  }

  return (
    <Column gap="lg">
      <CategoryButton.Group>
        <CategoryButton
          action={<Checkbox checked={autostart()} />}
          onClick={toggleAutostart}
          icon={<Symbol>exit_to_app</Symbol>}
          description={
            <Trans>Launch StarknetChat when you log into your computer.</Trans>
          }
        >
          <Trans>Start with Computer</Trans>
        </CategoryButton>
        {autostart() &&
          CheckboxButton(
            "startMinimisedToTray",
            "minimize",
            t`Start Minimised to Tray`,
            t`StarknetChat will start in the system tray.`,
          )}
        {CheckboxButton(
          "minimiseToTray",
          "cancel_presentation",
          t`Minimise to Tray`,
          t`Instead of closing, StarknetChat will hide in your tray.`,
        )}
        {CheckboxButton(
          "customFrame",
          "web_asset",
          t`Custom window frame`,
          t`Let StarknetChat use its own custom titlebar.`,
        )}
      </CategoryButton.Group>

      <CategoryButton.Group>
        {CheckboxButton(
          "discordRpc",
          "groups_2",
          t`Discord RPC`,
          t`Rep StarknetChat using Discord rich presence.`,
        )}
        {CheckboxButton(
          "spellchecker",
          "spellcheck",
          t`Spellchecker`,
          t`Show corrections and suggestions as you type.`,
        )}
        {CheckboxButton(
          "hardwareAcceleration",
          "speed",
          t`Hardware Acceleration`,
          t`Use the graphics card to improve performance.`,
        )}
      </CategoryButton.Group>

      <CategoryButton.Group>
        <CategoryButton
          icon={<Symbol>desktop_windows</Symbol>}
          description={
            <>
              <Trans>Version:</Trans> {window.native.versions.desktop()}
            </>
          }
        >
          <Trans>StarknetChat for Desktop</Trans>
        </CategoryButton>
        <Show when={window.native.checkForUpdates}>
          <CategoryButton
            icon={<Symbol>update</Symbol>}
            onClick={checkUpdates}
            description={
              <Switch fallback={<Trans>Look for a newer version now.</Trans>}>
                <Match when={updateStatus() === "checking"}>
                  <Trans>Checking…</Trans>
                </Match>
                <Match when={updateStatus() === "up-to-date"}>
                  <Trans>You are on the latest version.</Trans>
                </Match>
                <Match when={updateStatus() === "downloading"}>
                  <Trans>
                    Downloading the update… It will be installed when you
                    restart.
                  </Trans>
                </Match>
                <Match when={updateStatus() === "ready"}>
                  <Trans>Update ready. Click to restart and install.</Trans>
                </Match>
                <Match when={updateStatus() === "unsupported"}>
                  <Trans>Updates are managed by the Microsoft Store.</Trans>
                </Match>
                <Match when={updateStatus() === "error"}>
                  <Trans>Couldn't check for updates. Try again later.</Trans>
                </Match>
              </Switch>
            }
          >
            <Trans>Check for updates</Trans>
          </CategoryButton>
        </Show>
      </CategoryButton.Group>
    </Column>
  );
}
