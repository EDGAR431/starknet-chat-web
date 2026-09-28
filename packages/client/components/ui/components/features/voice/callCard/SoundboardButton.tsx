import { offset, flip, shift } from "@floating-ui/dom";
import { useFloating } from "solid-floating-ui";
import { For, Show, createSignal, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { styled } from "styled-system/jsx";

import { Trans, useLingui } from "@lingui/solid/macro";

import { useClient } from "@revolt/client";
import { useVoice } from "@revolt/rtc";
import { useState } from "@revolt/state";
import type { SoundboardSound } from "@revolt/state";
import { Button, IconButton, TextField } from "@revolt/ui/components/design";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

/**
 * Soundboard button + panel for the voice call actions bar. Sounds are
 * mixed directly into the outgoing mic audio (see VoiceProcessor), so
 * anyone else in the call just hears them as normal voice — no separate
 * realtime protocol involved.
 *
 * Per-server soundboards (shared with a server's members) are not covered
 * here yet — this is the personal soundboard only, synced across this
 * account's devices through the regular settings sync.
 */
export function SoundboardButton(props: { size: "xs" | "sm" }) {
  const { t } = useLingui();
  const [anchor, setAnchor] = createSignal<HTMLElement>();
  const [open, setOpen] = createSignal(false);

  return (
    <>
      <IconButton
        ref={setAnchor}
        size={props.size}
        variant="standard"
        onPress={() => setOpen((v) => !v)}
        use:floating={{
          tooltip: {
            placement: "top",
            content: t`Soundboard`,
          },
        }}
      >
        <Symbol>music_note</Symbol>
      </IconButton>
      <Show when={open()}>
        <SoundboardPanel anchor={anchor} onClose={() => setOpen(false)} />
      </Show>
    </>
  );
}

function SoundboardPanel(props: {
  anchor: () => HTMLElement | undefined;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const state = useState();
  const voice = useVoice();
  const client = useClient();

  const [floating, setFloating] = createSignal<HTMLDivElement>();
  const position = useFloating(props.anchor, floating, {
    placement: "top",
    middleware: [offset(10), flip(), shift({ padding: 8 })],
  });

  function onMouseDown(e: MouseEvent) {
    const target = e.target as Node;
    if (!floating()?.contains(target) && target !== props.anchor()) {
      props.onClose();
    }
  }
  document.addEventListener("mousedown", onMouseDown);
  onCleanup(() => document.removeEventListener("mousedown", onMouseDown));

  const [adding, setAdding] = createSignal(false);
  const [pendingFile, setPendingFile] = createSignal<File>();
  const [soundName, setSoundName] = createSignal("");
  const [soundEmoji, setSoundEmoji] = createSignal("");
  const [uploading, setUploading] = createSignal(false);
  const [error, setError] = createSignal<string>();
  let fileInput: HTMLInputElement | undefined;

  function play(sound: SoundboardSound) {
    voice.playSoundboardSound(
      sound.fileId,
      sound.volume * state.soundboard.masterVolume,
    );
  }

  function onFileChosen(e: Event) {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    (e.currentTarget as HTMLInputElement).value = "";
    if (!file) return;

    // 512KB is plenty for a short soundboard clip and keeps this fast to
    // fetch/decode every time it's triggered in a call.
    if (file.size > 512 * 1024) {
      setError(t`El archivo es demasiado grande (máx. 512 KB)`);
      return;
    }

    setError(undefined);
    setPendingFile(file);
    setSoundName(file.name.replace(/\.[^/.]+$/, "").slice(0, 32));
    setSoundEmoji("");
    setAdding(true);
  }

  async function confirmAdd() {
    const file = pendingFile();
    if (!file || !soundName().trim()) return;

    setUploading(true);
    setError(undefined);
    try {
      const fileId = await client().uploadFile("attachments", file);
      state.soundboard.addSound({
        name: soundName().trim(),
        emoji: soundEmoji().trim() || undefined,
        fileId,
      });
      setAdding(false);
      setPendingFile(undefined);
    } catch (e) {
      console.error("[soundboard] no se pudo subir el sonido:", e);
      setError(t`No se pudo subir el sonido`);
    } finally {
      setUploading(false);
    }
  }

  return (
    <Portal mount={document.getElementById("floating")!}>
      <Panel
        ref={setFloating}
        style={{
          position: position.strategy,
          top: `${position.y ?? 0}px`,
          left: `${position.x ?? 0}px`,
        }}
      >
        <Show
          when={!adding()}
          fallback={
            <AddForm>
              <TextField
                autoFocus
                variant="outlined"
                placeholder={t`Nombre del sonido`}
                value={soundName()}
                maxlength={32}
                onInput={(e) => setSoundName(e.currentTarget.value)}
              />
              <TextField
                variant="outlined"
                placeholder={t`Emoji (opcional)`}
                value={soundEmoji()}
                maxlength={8}
                onInput={(e) => setSoundEmoji(e.currentTarget.value)}
              />
              <Show when={error()}>
                <ErrorText>{error()}</ErrorText>
              </Show>
              <FormActions>
                <Button
                  variant="outlined"
                  onPress={() => {
                    setAdding(false);
                    setPendingFile(undefined);
                  }}
                >
                  <Trans>Cancelar</Trans>
                </Button>
                <Button
                  variant="filled"
                  isDisabled={uploading() || !soundName().trim()}
                  onPress={confirmAdd}
                >
                  {uploading() ? t`Subiendo…` : t`Guardar`}
                </Button>
              </FormActions>
            </AddForm>
          }
        >
          <Header>
            <Trans>Mi soundboard</Trans>
          </Header>
          <Show when={error()}>
            <ErrorText>{error()}</ErrorText>
          </Show>
          <Grid>
            <For each={state.soundboard.personalSounds}>
              {(sound) => (
                <SoundTile>
                  <SoundTileButton onClick={() => play(sound)}>
                    <span>{sound.emoji ?? "🔊"}</span>
                    <SoundName>{sound.name}</SoundName>
                  </SoundTileButton>
                  <RemoveButton
                    onClick={(e: MouseEvent) => {
                      e.stopPropagation();
                      state.soundboard.removeSound(sound.id);
                    }}
                    title={t`Eliminar`}
                  >
                    <Symbol>close</Symbol>
                  </RemoveButton>
                </SoundTile>
              )}
            </For>
            <AddTile onClick={() => fileInput?.click()} title={t`Añadir sonido`}>
              <Symbol>add</Symbol>
            </AddTile>
          </Grid>
          <input
            ref={fileInput}
            type="file"
            accept="audio/*"
            style={{ display: "none" }}
            onChange={onFileChosen}
          />
        </Show>
      </Panel>
    </Portal>
  );
}

const Panel = styled("div", {
  base: {
    zIndex: 20,
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
    width: "280px",
    maxHeight: "360px",
    padding: "var(--gap-md)",
    borderRadius: "var(--borderRadius-lg)",
    background: "var(--md-sys-color-surface-container-high)",
    boxShadow: "var(--elevation-3)",
  },
});

const Header = styled("div", {
  base: {
    fontSize: "0.85em",
    fontWeight: 600,
    color: "var(--md-sys-color-on-surface-variant)",
    padding: "0 var(--gap-xs)",
  },
});

const Grid = styled("div", {
  base: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: "var(--gap-sm)",
    overflowY: "auto",
  },
});

const SoundTile = styled("div", {
  base: {
    position: "relative",
  },
});

const SoundTileButton = styled("button", {
  base: {
    width: "100%",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "2px",
    padding: "var(--gap-sm) 4px",
    borderRadius: "var(--borderRadius-md)",
    background: "var(--md-sys-color-surface-container)",
    cursor: "pointer",
    border: "none",
    "&:hover": {
      background: "var(--md-sys-color-surface-container-highest)",
    },
    "&:active": {
      background: "var(--md-sys-color-primary-container)",
    },
  },
});

const SoundName = styled("span", {
  base: {
    fontSize: "0.7em",
    color: "var(--md-sys-color-on-surface)",
    textAlign: "center",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    maxWidth: "100%",
  },
});

const RemoveButton = styled("button", {
  base: {
    position: "absolute",
    top: "-4px",
    right: "-4px",
    width: "18px",
    height: "18px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--borderRadius-full)",
    background: "var(--md-sys-color-error)",
    color: "var(--md-sys-color-on-error)",
    border: "none",
    cursor: "pointer",
    fontSize: "10px",
  },
});

const AddTile = styled("button", {
  base: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "var(--gap-sm) 4px",
    borderRadius: "var(--borderRadius-md)",
    background: "transparent",
    border: "1px dashed var(--md-sys-color-outline-variant)",
    cursor: "pointer",
    color: "var(--md-sys-color-on-surface-variant)",
    "&:hover": {
      background: "var(--md-sys-color-surface-container)",
    },
  },
});

const AddForm = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
  },
});

const FormActions = styled("div", {
  base: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "var(--gap-sm)",
  },
});

const ErrorText = styled("div", {
  base: {
    fontSize: "0.8em",
    color: "var(--md-sys-color-error)",
  },
});
