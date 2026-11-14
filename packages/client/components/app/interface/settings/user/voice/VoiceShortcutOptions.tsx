import {
  Match,
  Show,
  Switch,
  createEffect,
  createSignal,
  onCleanup,
} from "solid-js";

import { Trans } from "@lingui/solid/macro";

import {
  type ShortcutAction,
  activeRecorder,
  eventToAccelerator,
  formatAccelerator,
  isLocalOnlyAccelerator,
  mouseEventToAccelerator,
  registrationFailed,
  setActiveRecorder,
} from "@revolt/rtc/voiceShortcuts";
import { useState } from "@revolt/state";
import { CategoryButton, Column, Text } from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

/**
 * Atajos de teclado para silenciarse y ensordecerse
 */
export function VoiceShortcutOptions() {
  const { voice } = useState();

  const keybind = (action: ShortcutAction) =>
    action === "mute" ? voice.muteKeybind : voice.deafenKeybind;

  const setKeybind = (action: ShortcutAction, value: string) => {
    if (action === "mute") voice.muteKeybind = value;
    else voice.deafenKeybind = value;
  };

  const other = (action: ShortcutAction): ShortcutAction =>
    action === "mute" ? "deafen" : "mute";

  // Mientras se graba, capturar la siguiente combinacion
  createEffect(() => {
    const action = activeRecorder();
    if (!action) return;

    const finish = (acc: string) => {
      if (acc === keybind(other(action))) {
        setConflict(action);
        return;
      }
      setConflict(null);
      setHint(false);
      setKeybind(action, acc);
      setActiveRecorder(null);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;

      if (e.key === "Escape") {
        setActiveRecorder(null);
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        setKeybind(action, "");
        setHint(false);
        setActiveRecorder(null);
        return;
      }
      if (["Control", "Shift", "Alt", "Meta", "AltGraph", "OS"].includes(e.key)) {
        return; // solo modificadores: seguir esperando
      }

      const acc = eventToAccelerator(e);
      if (!acc) {
        setHint(true); // tecla suelta no admitida: avisar
        return;
      }
      finish(acc);
    };

    // botones de raton: rueda, atras y adelante (clic izq./dcho. no)
    const onMouseDown = (e: MouseEvent) => {
      const acc = mouseEventToAccelerator(e);
      if (!acc) return;
      e.preventDefault();
      e.stopPropagation();
      finish(acc);
    };
    const swallow = (e: MouseEvent) => {
      if (mouseEventToAccelerator(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("mouseup", swallow, true);
    window.addEventListener("auxclick", swallow, true);
    onCleanup(() => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("mouseup", swallow, true);
      window.removeEventListener("auxclick", swallow, true);
    });
  });

  onCleanup(() => {
    setActiveRecorder(null);
    setConflict(null);
    setHint(false);
  });

  function row(action: ShortcutAction) {
    return (
      <CategoryButton
        icon={<Symbol>{action === "mute" ? "mic_off" : "headset_off"}</Symbol>}
        description={
          <Switch>
            <Match when={conflict() === action}>
              <Trans>This combination is already used by the other shortcut.</Trans>
            </Match>
            <Match when={registrationFailed()[action] && keybind(action)}>
              <Trans>Another application is already using this combination.</Trans>
            </Match>
            <Match when={activeRecorder() === action && hint()}>
              <Trans>Use Ctrl, Alt or Shift together with this key.</Trans>
            </Match>
            <Match when={activeRecorder() === action}>
              <Trans>
                Press the new key combination or a mouse button. Backspace
                removes it, Esc cancels.
              </Trans>
            </Match>
            <Match when={!keybind(action)}>
              <Trans>Not set. Click to choose a key combination.</Trans>
            </Match>
          </Switch>
        }
        action={
          <Text class="label">
            {activeRecorder() === action
              ? "…"
              : keybind(action)
                ? formatAccelerator(keybind(action))
                : ""}
          </Text>
        }
        onClick={() => {
          setConflict(null);
          setHint(false);
          setActiveRecorder(activeRecorder() === action ? null : action);
        }}
      >
        {action === "mute" ? (
          <Trans>Mute shortcut</Trans>
        ) : (
          <Trans>Deafen shortcut</Trans>
        )}
      </CategoryButton>
    );
  }

  return (
    <Column>
      <CategoryButton.Group>
        {row("mute")}
        {row("deafen")}
      </CategoryButton.Group>
      <Text class="label">
        <Show
          when={window.native?.setVoiceShortcuts}
          fallback={
            <Trans>
              Works only while this tab is open and focused. Use the desktop
              app for shortcuts that work in the background.
            </Trans>
          }
        >
          <Trans>
            Works even when StarknetChat is in the background. The combination
            is reserved while you are in a call.
          </Trans>
        </Show>
      </Text>
      <Show
        when={
          (!!voice.muteKeybind && isLocalOnlyAccelerator(voice.muteKeybind)) ||
          (!!voice.deafenKeybind && isLocalOnlyAccelerator(voice.deafenKeybind))
        }
      >
        <Text class="label">
          <Trans>
            Mouse buttons and single keys only work while StarknetChat is
            focused.
          </Trans>
        </Text>
      </Show>
    </Column>
  );
}

const [conflict, setConflict] = createSignal<ShortcutAction | null>(null);
const [hint, setHint] = createSignal(false);
