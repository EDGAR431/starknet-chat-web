import { Show } from "solid-js";

import { useInstance } from "@revolt/instance";
import { Column } from "@revolt/ui";

import { ScreenShareOptions } from "./ScreenShareOptions";
import { VoiceInputOptions } from "./VoiceInputOptions";
import { VoiceProcessingOptions } from "./VoiceProcessingOptions";
import { VoiceShortcutOptions } from "./VoiceShortcutOptions";

/**
 * Configure voice options
 */
export function VoiceSettings() {
  const { limits } = useInstance();

  return (
    <Column gap="lg">
      <VoiceInputOptions />
      <VoiceProcessingOptions />
      <VoiceShortcutOptions />
      <Show when={limits().video}>
        <ScreenShareOptions />
      </Show>
    </Column>
  );
}
