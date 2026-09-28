import type { Channel, Message, Server } from "stoat.js";
import { SOUNDBOARD_CHANNEL_MARKER } from "stoat.js";

/**
 * A sound on a server's shared soundboard. Backed by a single message in a
 * hidden channel (see SOUNDBOARD_CHANNEL_MARKER) — the message's content is
 * this JSON metadata and its one attachment is the audio itself. There is
 * no soundboard API on the Stoat backend, so this reuses the ordinary
 * messaging/attachment primitives as storage rather than inventing one.
 */
export interface ServerSound {
  /** ID of the message backing this sound — needed to delete it later */
  messageId: string;
  name: string;
  emoji?: string;
  fileId: string;
  volume: number;
}

const MESSAGE_MARKER = "starknet-soundboard-sound";

function parseSoundMessage(message: Message): ServerSound | undefined {
  const attachment = message.attachments?.[0];
  if (!attachment) return undefined;

  let data: { type?: string; name?: string; emoji?: string; volume?: number };
  try {
    data = JSON.parse(message.content ?? "");
  } catch {
    return undefined;
  }

  if (data.type !== MESSAGE_MARKER || typeof data.name !== "string") {
    return undefined;
  }

  return {
    messageId: message.id,
    name: data.name.slice(0, 32),
    emoji: typeof data.emoji === "string" ? data.emoji : undefined,
    fileId: attachment.id,
    volume:
      typeof data.volume === "number"
        ? Math.min(2, Math.max(0, data.volume))
        : 1.0,
  };
}

/**
 * Find this server's hidden soundboard channel, if it has one yet.
 */
export function findSoundboardChannel(server: Server): Channel | undefined {
  return server.channels.find(
    (channel) => channel.description === SOUNDBOARD_CHANNEL_MARKER,
  );
}

/**
 * Find the server's soundboard channel, creating it the first time anyone
 * adds a sound. Channel creation itself requires ManageChannel/ManageServer
 * on the backend, matching the client-side gate already used to show the
 * "add sound" control, so this only ever runs for someone who could already
 * manage the server.
 */
export async function findOrCreateSoundboardChannel(
  server: Server,
): Promise<Channel> {
  const existing = findSoundboardChannel(server);
  if (existing) return existing;

  return server.createChannel({
    type: "Text",
    name: "soundboard (no borrar)",
    description: SOUNDBOARD_CHANNEL_MARKER,
  });
}

/**
 * Fetch every sound currently on a server's soundboard, oldest (first
 * added) first.
 */
export async function fetchServerSounds(
  channel: Channel,
): Promise<ServerSound[]> {
  const messages = await channel.fetchMessages({ limit: 100 });
  return messages
    .map(parseSoundMessage)
    .filter((sound): sound is ServerSound => !!sound)
    .reverse();
}

/**
 * Add a sound to a server's soundboard.
 * @param channel The server's soundboard channel
 * @param sound Name, optional emoji, and the already-uploaded Autumn file ID
 */
export async function addServerSound(
  channel: Channel,
  sound: { name: string; emoji?: string; fileId: string },
): Promise<ServerSound> {
  const message = await channel.sendMessage({
    content: JSON.stringify({
      type: MESSAGE_MARKER,
      name: sound.name,
      emoji: sound.emoji,
      volume: 1.0,
    }),
    attachments: [sound.fileId],
  });

  const parsed = parseSoundMessage(message);
  if (!parsed) {
    throw new Error("No se pudo interpretar el sonido recién añadido");
  }
  return parsed;
}

/**
 * Remove a sound from a server's soundboard.
 */
export async function removeServerSound(
  channel: Channel,
  messageId: string,
): Promise<void> {
  const message = await channel.fetchMessage(messageId);
  await message.delete();
}
