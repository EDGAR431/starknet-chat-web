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
        setActiveRecorder(null);
        return;
      }

      const acc = eventToAccelerator(e);
      if (!acc) return; // solo modificadores: seguir esperando
      if (acc === keybind(other(action))) {
        setConflict(action);
        return;
      }
      setConflict(null);
      setKeybind(action, acc);
      setActiveRecorder(null);
    };

    window.addEventListener("keydown", onKeyDown, true);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown, true));
  });

  onCleanup(() => {
    setActiveRecorder(null);
    setConflict(null);
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
            <Match when={activeRecorder() === action}>
              <Trans>
                Press the new key combination. Backspace removes it, Esc cancels.
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
    </Column>
  );
}

const [conflict, setConflict] = createSignal<ShortcutAction | null>(null);
