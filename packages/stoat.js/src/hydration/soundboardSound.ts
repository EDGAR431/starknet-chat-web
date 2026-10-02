import type { Merge } from "../lib/merge.js";

import type { Hydrate } from "./index.js";

/**
 * Where a soundboard sound lives: shared on a server's board, or on a
 * user's personal (account-wide) board.
 *
 * Not imported from `stoat-api` — the published package (0.15.3) predates
 * the backend's soundboard routes, so this mirrors the wire shape by hand
 * rather than waiting on an SDK bump just for these three endpoints.
 */
export type SoundboardSoundParent =
  | { type: "Server"; id: string }
  | { type: "Detached" };

/**
 * Wire shape of a soundboard sound, exactly as returned by
 * `POST /soundboard/sound` and `GET /soundboard/server/<id>`.
 */
export type APISoundboardSound = {
  _id: string;
  parent: SoundboardSoundParent;
  creator_id: string;
  name: string;
  emoji?: string;
  file_id: string;
  volume: number;
};

export type HydratedSoundboardSound = {
  id: string;
  parent: SoundboardSoundParent;
  creatorId: string;
  name: string;
  emoji?: string;
  fileId: string;
  volume: number;
};

export const soundboardSoundHydration: Hydrate<
  Merge<APISoundboardSound>,
  HydratedSoundboardSound
> = {
  keyMapping: {
    _id: "id",
    creator_id: "creatorId",
    file_id: "fileId",
  },
  functions: {
    id: (sound) => sound._id,
    parent: (sound) => sound.parent,
    creatorId: (sound) => sound.creator_id,
    name: (sound) => sound.name,
    emoji: (sound) => sound.emoji,
    fileId: (sound) => sound.file_id,
    volume: (sound) => (typeof sound.volume === "number" ? sound.volume : 100),
  },
  initialHydration: () => ({}),
};
