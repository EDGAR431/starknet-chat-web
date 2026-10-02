import { createEffect, on, onCleanup } from "solid-js";

import type { ProtocolV1 } from "stoat.js";

import { useClient, useClientLifecycle } from "@revolt/client";
import { State } from "@revolt/client/Controller";

import { useState } from ".";

/**
 * Keeps this device's local cache of the account's personal (Detached)
 * soundboard sounds (`state.soundboard.personalSounds`) in sync with
 * `SoundboardSoundCreate`/`SoundboardSoundDelete` events for the current
 * user's own sounds — e.g. a sound added from another tab or device shows
 * up here too, without needing a "list my personal sounds" endpoint
 * (there isn't one, since personal sounds aren't tied to a server).
 *
 * `SoundboardSoundUpdate` is handled the same way in case the backend
 * (or another client) ever edits a sound in place, even though this
 * client does not do so itself yet.
 */
export function PersonalSoundboardWorker() {
  const state = useState();
  const client = useClient();
  const { lifecycle } = useClientLifecycle();

  function cacheIfOwnPersonalSound(soundId: string) {
    const sound = client().soundboardSounds.get(soundId);
    if (
      sound &&
      sound.parent.type === "Detached" &&
      sound.creatorId === client().user?.id
    ) {
      state.soundboard.cacheSound({
        id: sound.id,
        name: sound.name,
        emoji: sound.emoji,
        fileId: sound.fileId,
        volume: sound.volume,
        isDefault: sound.isDefault,
      });
    }
  }

  function handleEvent(event: ProtocolV1["server"]) {
    switch (event.type) {
      case "SoundboardSoundCreate":
        cacheIfOwnPersonalSound(event._id);
        break;
      case "SoundboardSoundUpdate":
        cacheIfOwnPersonalSound(event.id);
        break;
      case "SoundboardSoundDelete":
        state.soundboard.uncacheSound(event.id);
        break;
      default:
        break;
    }
  }

  createEffect(
    on(
      () => lifecycle.state(),
      (newState) => {
        if (newState === State.Connected) {
          client().events.addListener("event", handleEvent);
          onCleanup(() =>
            client().events.removeListener("event", handleEvent),
          );
        }
      },
    ),
  );

  return null;
}
