import type { Client, Server, SoundboardSound } from "stoat.js";

/**
 * A sound on a server's shared soundboard, in the shape the soundboard UI
 * already expects. Backed by the real `/soundboard/*` backend routes
 * (Server-parented sounds) — this used to be a hidden text channel full of
 * one message per sound (see git history before this file's current
 * version for that hack), but the backend now has a proper soundboard API.
 */
export interface ServerSound {
  /** Backend id of the sound — needed to delete it later */
  id: string;
  name: string;
  emoji?: string;
  fileId: string;
  volume: number;
}

function toServerSound(sound: SoundboardSound): ServerSound {
  return {
    id: sound.id,
    name: sound.name,
    emoji: sound.emoji,
    fileId: sound.fileId,
    volume: sound.volume,
  };
}

/**
 * Fetch every sound currently on a server's soundboard.
 * @param client Client
 * @param server Server
 */
export async function fetchServerSounds(
  client: Client,
  server: Server,
): Promise<ServerSound[]> {
  const sounds = await client.soundboardSounds.fetchForServer(server.id);
  return sounds.map(toServerSound);
}

/**
 * Add a sound to a server's soundboard. Requires ManageCustomisation on
 * the server — enforced by the backend, and gated the same way in the UI
 * before this is ever called (see SoundboardButton.tsx).
 * @param client Client
 * @param server Server
 * @param sound Name, optional emoji, and the already-uploaded Autumn file ID
 */
export async function addServerSound(
  client: Client,
  server: Server,
  sound: { name: string; emoji?: string; fileId: string },
): Promise<ServerSound> {
  const created = await client.soundboardSounds.createSound({
    name: sound.name,
    parent: { type: "Server", id: server.id },
    fileId: sound.fileId,
    emoji: sound.emoji,
  });

  return toServerSound(created);
}

/**
 * Remove a sound from a server's soundboard. Creator or (for this,
 * Server-parented sound) ManageCustomisation may delete — enforced by the
 * backend.
 * @param client Client
 * @param soundId Sound id
 */
export async function removeServerSound(
  client: Client,
  soundId: string,
): Promise<void> {
  await client.soundboardSounds.deleteSound(soundId);
}
