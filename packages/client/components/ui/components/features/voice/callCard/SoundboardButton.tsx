import { offset, flip, shift } from "@floating-ui/dom";
import { useFloating } from "solid-floating-ui";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
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
import {
  Button,
  IconButton,
  Slider,
  TextField,
} from "@revolt/ui/components/design";
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

type PanelSound = {
  id: string;
  name: string;
  emoji?: string;
  fileId: string;
  volume: number;
  isDefault: boolean;
};

/** Pulso corto al pulsar un sonido (respeta "reducir movimiento") */
function pressFeedback(el: HTMLElement) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  el.animate(
    [{ transform: "scale(0.93)" }, { transform: "scale(1)" }],
    { duration: 220, easing: "cubic-bezier(.2,.8,.2,1)" },
  );
  el.animate(
    [
      { boxShadow: "0 0 0 0 var(--md-sys-color-primary)" },
      { boxShadow: "0 0 0 7px transparent" },
    ],
    { duration: 420, easing: "ease-out" },
  );
}

function SoundCard(props: {
  sound: PanelSound;
  canRemove: boolean;
  onPlay: (sound: PanelSound) => void;
  onRemove: () => void;
}) {
  const { t } = useLingui();
  const state = useState();
  const pinned = () => state.soundboard.isFavorite(props.sound.id);

  return (
    <Tile>
      <TileButton
        title={props.sound.name}
        onClick={(e: MouseEvent) => {
          pressFeedback(e.currentTarget as HTMLElement);
          props.onPlay(props.sound);
        }}
      >
        <Emoji>{props.sound.emoji ?? "🔊"}</Emoji>
        <SoundName>{props.sound.name}</SoundName>
      </TileButton>
      <TileAction
        data-action
        data-side="left"
        data-pinned={pinned()}
        title={pinned() ? t`Quitar de favoritos` : t`Añadir a favoritos`}
        onClick={(e: MouseEvent) => {
          e.stopPropagation();
          state.soundboard.toggleFavorite(props.sound.id);
        }}
      >
        <Symbol size={16} fill={pinned()}>
          star
        </Symbol>
      </TileAction>
      <Show when={props.canRemove}>
        <TileAction
          data-action
          data-side="right"
          data-danger
          title={t`Eliminar`}
          onClick={(e: MouseEvent) => {
            e.stopPropagation();
            props.onRemove();
          }}
        >
          <Symbol size={16}>close</Symbol>
        </TileAction>
      </Show>
    </Tile>
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

  // El servidor de la llamada actual, si es un canal de voz de servidor
  // (en una DM/grupo no hay soundboard compartido). Crear/quitar sonidos
  // del servidor requiere ManageCustomisation (igual que el resto de
  // personalización del servidor: emojis, etc.) — lo exige el backend,
  // esto solo refleja esa misma regla en la interfaz.
  const server = () => voice.channel()?.server;
  const canManageServerBoard = () =>
    server()?.havePermission("ManageCustomisation") ?? false;
  // Quitar un sonido del servidor: solo el dueño del servidor (lo exige
  // también el backend), para que nadie los borre a la ligera.
  const isServerOwner = () =>
    !!server() && server()!.ownerId === client().user?.id;

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
                    isDefault: event.is_default,
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
  const [search, setSearch] = createSignal("");
  let personalFileInput: HTMLInputElement | undefined;
  let serverFileInput: HTMLInputElement | undefined;

  // Trae los sonidos personales del servidor (para ver los subidos desde
  // otros dispositivos); si el backend no tiene la ruta, se ignora.
  onMount(() => {
    void state.soundboard.syncPersonal(client());
  });

  function play(sound: { fileId: string; volume: number }) {
    voice.playSoundboardSound(sound.fileId, sound.volume / 100);
  }

  const matches = (s: { name: string }) => {
    const q = search().trim().toLowerCase();
    return !q || s.name.toLowerCase().includes(q);
  };
  const personalList = createMemo(() =>
    state.soundboard.personalSounds.filter(matches),
  );
  const serverList = createMemo(() => serverSounds().filter(matches));
  const favoriteList = createMemo<PanelSound[]>(() =>
    search().trim()
      ? []
      : [...state.soundboard.personalSounds, ...serverSounds()].filter((s) =>
          state.soundboard.favorites.includes(s.id),
        ),
  );
  const nothingFound = createMemo(
    () => !!search().trim() && !personalList().length && !serverList().length,
  );

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
          <TopBar>
            <SearchBox>
              <Symbol size={20}>search</Symbol>
              <SearchInput
                autofocus
                placeholder={t`Buscar sonido`}
                value={search()}
                onInput={(e: InputEvent) =>
                  setSearch((e.currentTarget as HTMLInputElement).value)
                }
              />
              <Show when={search()}>
                <ClearButton
                  title={t`Borrar búsqueda`}
                  onClick={() => setSearch("")}
                >
                  <Symbol size={18}>close</Symbol>
                </ClearButton>
              </Show>
            </SearchBox>
            <VolumeBox title={t`Volumen del soundboard`}>
              <Symbol size={20}>
                {state.soundboard.masterVolume === 0
                  ? "volume_off"
                  : "volume_up"}
              </Symbol>
              <SliderWrap>
                <Slider
                  min={0}
                  max={1.5}
                  step={0.05}
                  value={state.soundboard.masterVolume}
                  onInput={(event) =>
                    (state.soundboard.masterVolume = Number(
                      event.currentTarget.value,
                    ))
                  }
                  labelFormatter={(label) => (label * 100).toFixed(0) + "%"}
                />
              </SliderWrap>
              <VolumeValue>
                {Math.round(state.soundboard.masterVolume * 100)}%
              </VolumeValue>
            </VolumeBox>
          </TopBar>

          <Scroll>
            <Show when={favoriteList().length > 0}>
              <Section>
                <SectionHeader>
                  <Symbol size={18} fill>
                    star
                  </Symbol>
                  <Trans>Favoritos</Trans>
                  <Count>{favoriteList().length}</Count>
                </SectionHeader>
                <Grid>
                  <For each={favoriteList()}>
                    {(sound) => (
                      <SoundCard
                        sound={sound}
                        canRemove={false}
                        onPlay={play}
                        onRemove={() => {}}
                      />
                    )}
                  </For>
                </Grid>
              </Section>
            </Show>

            <Section>
              <SectionHeader>
                <Trans>Mi soundboard</Trans>
                <Count>{state.soundboard.personalSounds.length}</Count>
                <Spacer />
                <AddButton
                  title={t`Añadir sonido`}
                  onClick={() => personalFileInput?.click()}
                >
                  <Symbol size={18}>add</Symbol>
                  <Trans>Añadir</Trans>
                </AddButton>
              </SectionHeader>
              <Show
                when={personalList().length > 0}
                fallback={
                  <Show when={!search().trim()}>
                    <EmptyHint>
                      <Trans>
                        Aún no tienes sonidos. Pulsa Añadir para subir uno
                        (máx. 512 KB).
                      </Trans>
                    </EmptyHint>
                  </Show>
                }
              >
                <Grid>
                  <For each={personalList()}>
                    {(sound) => (
                      <SoundCard
                        sound={sound}
                        canRemove={!sound.isDefault}
                        onPlay={play}
                        onRemove={() => removePersonal(sound.id)}
                      />
                    )}
                  </For>
                </Grid>
              </Show>
              <input
                ref={personalFileInput}
                type="file"
                accept="audio/*"
                style={{ display: "none" }}
                onChange={onFileChosen("personal")}
              />
            </Section>

            <Show when={server()}>
              <Section>
                <SectionHeader>
                  <Trans>Soundboard del servidor</Trans>
                  <Count>{serverSounds().length}</Count>
                  <Spacer />
                  <Show when={canManageServerBoard()}>
                    <AddButton
                      title={t`Añadir sonido al servidor`}
                      onClick={() => serverFileInput?.click()}
                    >
                      <Symbol size={18}>add</Symbol>
                      <Trans>Añadir</Trans>
                    </AddButton>
                  </Show>
                </SectionHeader>
                <Show when={serverBoardError()}>
                  <ErrorText>{serverBoardError()}</ErrorText>
                </Show>
                <Show
                  when={!loadingServerSounds()}
                  fallback={<LoadingText>{t`Cargando…`}</LoadingText>}
                >
                  <Show
                    when={serverList().length > 0}
                    fallback={
                      <Show when={!search().trim() && !serverBoardError()}>
                        <EmptyHint>
                          <Trans>Este servidor aún no tiene sonidos.</Trans>
                        </EmptyHint>
                      </Show>
                    }
                  >
                    <Grid>
                      <For each={serverList()}>
                        {(sound) => (
                          <SoundCard
                            sound={sound}
                            canRemove={isServerOwner() && !sound.isDefault}
                            onPlay={play}
                            onRemove={() => removeServer(sound)}
                          />
                        )}
                      </For>
                    </Grid>
                  </Show>
                </Show>
                <input
                  ref={serverFileInput}
                  type="file"
                  accept="audio/*"
                  style={{ display: "none" }}
                  onChange={onFileChosen("server")}
                />
              </Section>
            </Show>

            <Show when={nothingFound()}>
              <EmptyHint>
                <Trans>Ningún sonido coincide con «{search()}».</Trans>
              </EmptyHint>
            </Show>
            <Show when={error()}>
              <ErrorText>{error()}</ErrorText>
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
    zIndex: 200,
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-md)",
    width: "min(460px, calc(100vw - 16px))",
    maxHeight: "min(580px, 72vh)",
    padding: "var(--gap-md)",
    borderRadius: "var(--borderRadius-lg)",
    background: "var(--md-sys-color-surface-container-high)",
    boxShadow: "var(--elevation-3)",
    overflow: "hidden",
  },
});

const TopBar = styled("div", {
  base: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "var(--gap-sm) var(--gap-md)",
  },
});

const SearchBox = styled("label", {
  base: {
    flex: "1 1 180px",
    minWidth: 0,
    height: "40px",
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    padding: "0 var(--gap-md)",
    borderRadius: "var(--borderRadius-full)",
    background: "var(--md-sys-color-surface-container-highest)",
    color: "var(--md-sys-color-on-surface-variant)",
    "&:focus-within": {
      outline: "2px solid var(--md-sys-color-primary)",
    },
  },
});

const SearchInput = styled("input", {
  base: {
    flex: 1,
    minWidth: 0,
    border: "none",
    outline: "none",
    background: "transparent",
    color: "var(--md-sys-color-on-surface)",
    font: "inherit",
    "&::placeholder": {
      color: "var(--md-sys-color-on-surface-variant)",
    },
  },
});

const ClearButton = styled("button", {
  base: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    border: "none",
    background: "transparent",
    color: "inherit",
    cursor: "pointer",
    borderRadius: "var(--borderRadius-full)",
    padding: "2px",
    "&:hover": {
      background: "var(--md-sys-color-surface-container)",
    },
  },
});

const VolumeBox = styled("div", {
  base: {
    flex: "1 1 170px",
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const SliderWrap = styled("div", {
  base: {
    flex: 1,
    minWidth: 0,
    display: "flex",
  },
});

const VolumeValue = styled("span", {
  base: {
    width: "42px",
    textAlign: "right",
    fontSize: "0.8em",
    fontVariantNumeric: "tabular-nums",
  },
});

const Scroll = styled("div", {
  base: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-lg)",
    overflowX: "hidden",
    overflowY: "auto",
    paddingRight: "var(--gap-xs)",
    scrollbarWidth: "thin",
  },
});

const Section = styled("section", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
  },
});

const SectionHeader = styled("div", {
  base: {
    position: "sticky",
    top: 0,
    zIndex: 1,
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    padding: "var(--gap-xs) 2px",
    fontSize: "0.85em",
    fontWeight: 600,
    color: "var(--md-sys-color-on-surface-variant)",
    background: "var(--md-sys-color-surface-container-high)",
  },
});

const Count = styled("span", {
  base: {
    fontWeight: 400,
    opacity: 0.7,
    fontVariantNumeric: "tabular-nums",
  },
});

const Spacer = styled("span", {
  base: {
    flex: 1,
  },
});

const AddButton = styled("button", {
  base: {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--gap-xs)",
    padding: "4px var(--gap-md) 4px var(--gap-sm)",
    border: "none",
    borderRadius: "var(--borderRadius-full)",
    background: "var(--md-sys-color-secondary-container)",
    color: "var(--md-sys-color-on-secondary-container)",
    fontSize: "inherit",
    fontWeight: 500,
    cursor: "pointer",
    "&:hover": {
      filter: "brightness(1.08)",
    },
    "&:focus-visible": {
      outline: "2px solid var(--md-sys-color-primary)",
    },
  },
});

const LoadingText = styled("div", {
  base: {
    fontSize: "0.8em",
    color: "var(--md-sys-color-on-surface-variant)",
    padding: "0 var(--gap-xs)",
  },
});

const EmptyHint = styled("div", {
  base: {
    fontSize: "0.85em",
    lineHeight: 1.4,
    color: "var(--md-sys-color-on-surface-variant)",
    padding: "var(--gap-sm) var(--gap-xs)",
  },
});

const Grid = styled("div", {
  base: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(104px, 1fr))",
    gap: "var(--gap-sm)",
  },
});

const Tile = styled("div", {
  base: {
    position: "relative",
    "&:hover [data-action], &:focus-within [data-action]": {
      opacity: 1,
    },
  },
});

const TileButton = styled("button", {
  base: {
    width: "100%",
    minHeight: "84px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "var(--gap-xs)",
    padding: "var(--gap-md) var(--gap-sm)",
    borderRadius: "var(--borderRadius-md)",
    background: "var(--md-sys-color-surface-container)",
    color: "var(--md-sys-color-on-surface)",
    cursor: "pointer",
    border: "none",
    transition: "background 120ms",
    "&:hover": {
      background: "var(--md-sys-color-surface-container-highest)",
    },
    "&:active": {
      background: "var(--md-sys-color-primary-container)",
    },
    "&:focus-visible": {
      outline: "2px solid var(--md-sys-color-primary)",
    },
  },
});

const Emoji = styled("span", {
  base: {
    fontSize: "28px",
    lineHeight: 1,
  },
});

const SoundName = styled("span", {
  base: {
    maxWidth: "100%",
    fontSize: "0.78em",
    lineHeight: 1.15,
    textAlign: "center",
    overflow: "hidden",
    lineClamp: 2,
    wordBreak: "break-word",
  },
});

const TileAction = styled("button", {
  base: {
    position: "absolute",
    top: "4px",
    width: "24px",
    height: "24px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    border: "none",
    borderRadius: "var(--borderRadius-full)",
    background: "var(--md-sys-color-surface-container-highest)",
    color: "var(--md-sys-color-on-surface-variant)",
    cursor: "pointer",
    opacity: 0,
    transition: "opacity 120ms, background 120ms, color 120ms",
    "&[data-side=left]": {
      left: "4px",
    },
    "&[data-side=right]": {
      right: "4px",
    },
    "&[data-pinned=true]": {
      opacity: 1,
      color: "var(--md-sys-color-primary)",
    },
    "&[data-danger]:hover": {
      background: "var(--md-sys-color-error)",
      color: "var(--md-sys-color-on-error)",
    },
    "&:focus-visible": {
      opacity: 1,
      outline: "2px solid var(--md-sys-color-primary)",
    },
    "@media (hover: none)": {
      opacity: 1,
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
