import { createEffect, createMemo, onCleanup } from "solid-js";

import { useClient, useSound } from "@revolt/client";
import { useState } from "@revolt/state";

import { useVoice } from "./state";

/** Stop ringing after this long, like a missed call */
const RING_TIMEOUT_MS = 45_000;

/**
 * Rings for private calls (DMs and groups):
 * - incoming: someone started a call in a DM/group we are not part of
 * - outgoing: we are connected to a DM/group call and nobody has joined yet
 */
export function CallRinger() {
  const client = useClient();
  const sound = useSound();
  const voice = useVoice();
  const state = useState();

  /** The most recent private call currently ringing for us, if any */
  const incoming = createMemo(
    () => {
      const c = client();
      const me = c?.user;
      if (!me || me.status?.presence === "Busy") return undefined;

      // Already joining or in a call: nothing to ring about
      if (voice.state() !== "READY") return undefined;

      let ringing: { id: string; since: number } | undefined;
      for (const channel of c.channels.values()) {
        if (channel.type !== "DirectMessage" && channel.type !== "Group")
          continue;
        if (channel.voiceParticipants.size === 0) continue;
        if (channel.voiceParticipants.has(me.id)) continue;
        if (state.notifications.isMuted(channel)) continue;
        if (channel.recipient?.relationship === "Blocked") continue;

        let since = 0;
        for (const participant of channel.voiceParticipants.values()) {
          since = Math.max(since, participant.joinedAt.getTime());
        }

        // Only calls that started recently: don't ring for old ongoing calls
        // discovered when logging in or reconnecting
        if (Date.now() - since >= RING_TIMEOUT_MS) continue;
        if (!ringing || since > ringing.since) ringing = { id: channel.id, since };
      }

      return ringing;
    },
    undefined,
    { equals: (a, b) => a?.id === b?.id && a?.since === b?.since },
  );

  createEffect(() => {
    const call = incoming();
    if (!call) return;

    const remaining = RING_TIMEOUT_MS - (Date.now() - call.since);
    if (remaining <= 0 || !sound.startLoop("ringtoneIncoming")) return;

    const timer = setTimeout(() => sound.stopLoop(), remaining);
    onCleanup(() => {
      clearTimeout(timer);
      sound.stopLoop();
    });
  });

  /** We are alone in a private call we started */
  const outgoing = createMemo(() => {
    const channel = voice.channel();
    if (!channel || voice.state() !== "CONNECTED") return false;
    if (channel.type !== "DirectMessage" && channel.type !== "Group")
      return false;
    return channel.voiceParticipants.size <= 1;
  });

  createEffect(() => {
    if (!outgoing() || !sound.startLoop("ringtoneOutgoing")) return;

    const timer = setTimeout(() => sound.stopLoop(), RING_TIMEOUT_MS);
    onCleanup(() => {
      clearTimeout(timer);
      sound.stopLoop();
    });
  });

  return <></>;
}
