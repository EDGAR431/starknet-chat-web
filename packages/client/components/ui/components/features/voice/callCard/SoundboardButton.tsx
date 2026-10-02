import { offset, flip, shift } from "@floating-ui/dom";
import { useFloating } from "solid-floating-ui";
import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
} from "solid-js";
import { Portal } from "solid-js/web";
import { styled } from "styled-system/jsx";

import { Trans, useLingui } from "@lingui/solid/macro";

import type { ProtocolV1 } from "stoat.js";

import { useClient } from "@revolt/client";
import { useVoice } from "@revolt/rtc";
import {
  addServerSound,
  fetchServerSounds,
  removeServerSound,
  type ServerSound,
} from "@revolt/rtc/serverSoundboard";
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
 * Two boards are shown: the personal one (this account's own sounds) and,
 * when the call is a server voice channel, that server's shared board.
 * Both are backed by the real backend `/soundboard/*` routes — see
 * @revolt/rtc/serverSoundboard and @revolt/state's Soundboard store.
 */
export function SoundboardButton(props: { size: "xs" | "sm" }) {
  const { t } = useLingui();
  const [anchor, setAnchor] = createSignal<HTMLElement>();
  const [open, setOpen] = createSignal(false);

  return (
    <>
      {/* IconButton keeps its own internal ref and doesn't forward one, so
          the anchor for the floating panel is this wrapper's DOM node
          instead — it hugs the button's size since it stays inline. */}
      <AnchorSpan ref={setAnchor}>
        <IconButton
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
      </AnchorSpan>
      <Show when={open()}>
        <SoundboardPanel anchor={anchor} onClose={() => setOpen(false)} />
      </Show>
    </>
  );
}

type Scope = "personal" | "server";

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

  // El servidor de la llamada actual, si es un canal de voz de servidor
  // (en una DM/grupo no hay soundboard compartido). Crear/quitar sonidos
  // del servidor requiere ManageCustomisation (igual que el resto de
  // personalización del servidor: emojis, etc.) — lo exige el backend,
  // esto solo refleja esa misma regla en la interfaz.
  const server = () => voice.channel()?.server;
  const canManageServerBoard = () =>
    server()?.havePermission("ManageCustomisation") ?? false;

  const [serverSounds, setServerSounds] = createSignal<ServerSound[]>([]);
  const [loadingServerSounds, setLoadingServerSounds] = createSignal(false);
  const [serverBoardError, setServerBoardError] = createSignal<string>();

  createEffect(() => {
    const srv = server();
    if (!srv) {
      setServerSounds([]);
      return;
    }

    setLoadingServerSounds(true);
    fetchServerSounds(client(), srv)
      .then(setServerSounds)
      .catch((e) => {
        console.error(
          "[soundboard] no se pudieron cargar los sonidos del servidor:",
          e,
        );
        setServerBoardError(t`No se pudieron cargar los sonidos del servidor`);
      })
      .finally(() => setLoadingServerSounds(false));
  });

  // Mantiene el tablero del servidor al día en vivo: si alguien más añade o
  // quita un sonido mientras este panel está abierto, se refleja sin
  // necesidad de volver a pedirlos todos.
  function handleRealtimeEvent(event: ProtocolV1["server"]) {
    const srv = server();
    if (!srv) return;

    switch (event.type) {
      case "SoundboardSoundCreate": {
        if (event.parent.type === "Server" && event.parent.id === srv.id) {
          setServerSounds((prev) =>
            prev.some((s) => s.id === event._id)
              ? prev
              : [
                  ...prev,
                  {
                    id: event._id,
                    name: event.name,
                    emoji: event.emoji,
                    fileId: event.file_id,
                    volume: event.volume,
                  },
                ],
          );
        }
        break;
      }
      case "SoundboardSoundDelete": {
        setServerSounds((prev) => prev.filter((s) => s.id !== event.id));
        break;
      }
      default:
        break;
    }
  }

  client().events.addListener("event", handleRealtimeEvent);
  onCleanup(() => client().events.removeListener("event", handleRealtimeEvent));

  const [adding, setAdding] = createSignal<Scope>();
  const [pendingFile, setPendingFile] = createSignal<File>();
  const [soundName, setSoundName] = createSignal("");
  const [soundEmoji, setSoundEmoji] = createSignal("");
  const [uploading, setUploading] = createSignal(false);
  const [error, setError] = createSignal<string>();
  let personalFileInput: HTMLInputElement | undefined;
  let serverFileInput: HTMLInputElement | undefined;

  function play(sound: { fileId: string; volume: number }) {
    voice.playSoundboardSound(
      sound.fileId,
      sound.volume * state.soundboard.masterVolume,
    );
  }

  function onFileChosen(scope: Scope) {
    return (e: Event) => {
      const input = e.currentTarget as HTMLInputElement;
      const file = input.files?.[0];
      input.value = "";
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
      setAdding(scope);
    };
  }

  async function confirmAdd() {
    const scope = adding();
    const file = pendingFile();
    if (!scope || !file || !soundName().trim()) return;

    setUploading(true);
    setError(undefined);
    try {
      const fileId = await client().uploadFile("attachments", file);

      if (scope === "personal") {
        await state.soundboard.addSound(client(), {
          name: soundName().trim(),
          emoji: soundEmoji().trim() || undefined,
          fileId,
        });
      } else {
        const srv = server();
        if (!srv) throw new Error("no hay servidor activo");
        const sound = await addServerSound(client(), srv, {
          name: soundName().trim(),
          emoji: soundEmoji().trim() || undefined,
          fileId,
        });
        setServerSounds((prev) =>
          prev.some((s) => s.id === sound.id) ? prev : [...prev, sound],
        );
      }

      setAdding(undefined);
      setPendingFile(undefined);
    } catch (e) {
      console.error("[soundboard] no se pudo subir el sonido:", e);
      setError(t`No se pudo subir el sonido`);
    } finally {
      setUploading(false);
    }
  }

  async function removeServer(sound: ServerSound) {
    try {
      await removeServerSound(client(), sound.id);
      setServerSounds((prev) => prev.filter((s) => s.id !== sound.id));
    } catch (e) {
      console.error("[soundboard] no se pudo eliminar el sonido:", e);
      setServerBoardError(t`No se pudo eliminar el sonido`);
    }
  }

  async function removePersonal(id: string) {
    try {
      await state.soundboard.removeSound(client(), id);
    } catch (e) {
      console.error("[soundboard] no se pudo eliminar el sonido:", e);
      setError(t`No se pudo eliminar el sonido`);
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
                    setAdding(undefined);
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
          <Scroll>
            <Header>
              <Trans>Mi soundboard</Trans>
            </Header>
            <Grid>
              <For each={state.soundboard.personalSounds}>
                {(sound: SoundboardSound) => (
                  <SoundTile>
                    <SoundTileButton onClick={() => play(sound)}>
                      <span>{sound.emoji ?? "🔊"}</span>
                      <SoundName>{sound.name}</SoundName>
                    </SoundTileButton>
                    <RemoveButton
                      onClick={(e: MouseEvent) => {
                        e.stopPropagation();
                        removePersonal(sound.id);
                      }}
                      title={t`Eliminar`}
                    >
                      <Symbol>close</Symbol>
                    </RemoveButton>
                  </SoundTile>
                )}
              </For>
              <AddTile
                onClick={() => personalFileInput?.click()}
                title={t`Añadir sonido`}
              >
                <Symbol>add</Symbol>
              </AddTile>
            </Grid>
            <input
              ref={personalFileInput}
              type="file"
              accept="audio/*"
              style={{ display: "none" }}
              onChange={onFileChosen("personal")}
            />

            <Show when={server()}>
              <Header>
                <Trans>Soundboard del servidor</Trans>
              </Header>
              <Show when={serverBoardError()}>
                <ErrorText>{serverBoardError()}</ErrorText>
              </Show>
              <Show
                when={!loadingServerSounds()}
                fallback={<LoadingText>{t`Cargando…`}</LoadingText>}
              >
                <Grid>
                  <For each={serverSounds()}>
                    {(sound) => (
                      <SoundTile>
                        <SoundTileButton onClick={() => play(sound)}>
                          <span>{sound.emoji ?? "🔊"}</span>
                          <SoundName>{sound.name}</SoundName>
                        </SoundTileButton>
                        <Show when={canManageServerBoard()}>
                          <RemoveButton
                            onClick={(e: MouseEvent) => {
                              e.stopPropagation();
                              removeServer(sound);
                            }}
                            title={t`Eliminar`}
                          >
                            <Symbol>close</Symbol>
                          </RemoveButton>
                        </Show>
                      </SoundTile>
                    )}
                  </For>
                  <Show when={canManageServerBoard()}>
                    <AddTile
                      onClick={() => serverFileInput?.click()}
                      title={t`Añadir sonido al servidor`}
                    >
                      <Symbol>add</Symbol>
                    </AddTile>
                  </Show>
                </Grid>
              </Show>
              <input
                ref={serverFileInput}
                type="file"
                accept="audio/*"
                style={{ display: "none" }}
                onChange={onFileChosen("server")}
              />
            </Show>
          </Scroll>
        </Show>
      </Panel>
    </Portal>
  );
}

const AnchorSpan = styled("span", {
  base: {
    display: "inline-flex",
  },
});

const Panel = styled("div", {
  base: {
    zIndex: 20,
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
    width: "280px",
    maxHeight: "420px",
    padding: "var(--gap-md)",
    borderRadius: "var(--borderRadius-lg)",
    background: "var(--md-sys-color-surface-container-high)",
    boxShadow: "var(--elevation-3)",
  },
});

const Scroll = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
    overflowY: "auto",
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

const LoadingText = styled("div", {
  base: {
    fontSize: "0.8em",
    color: "var(--md-sys-color-on-surface-variant)",
    padding: "0 var(--gap-xs)",
  },
});

const Grid = styled("div", {
  base: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: "var(--gap-sm)",
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
