import type { Client, SoundboardSoundParent } from "stoat.js";

import { State } from "..";

import { AbstractStore } from ".";

/**
 * A single sound on a soundboard.
 */
export interface SoundboardSound {
  /**
   * Backend-assigned id for this sound (from `POST /soundboard/sound`'s
   * `_id`) — this is a real entity on the backend now, not a locally
   * generated id.
   */
  id: string;

  /**
   * Display name shown under the sound's button.
   */
  name: string;

  /**
   * Optional emoji shown alongside the name.
   */
  emoji?: string;

  /**
   * Autumn attachment ID of the uploaded audio file. Reuses the exact same
   * upload flow as a message attachment, so no new upload endpoint is
   * needed — the file lives in the normal file storage.
   */
  fileId: string;

  /**
   * Per-sound playback volume, 0 to 200 (100 = normal) — matches the
   * backend's integer-percentage scale.
   */
  volume: number;
}

export interface TypeSoundboard {
  /**
   * Sounds on this user's personal (Detached) soundboard, usable in any DM
   * or voice channel they join.
   *
   * This is this device's CACHE of the account's personal sounds, not the
   * source of truth — the backend is, via `/soundboard/sound`. There is no
   * "list my personal sounds" endpoint (personal sounds aren't tied to a
   * server), so this list is built up from this device's own create/delete
   * calls and from `SoundboardSoundCreate/Delete` events for this user's
   * own sounds, rather than being fetched fresh on every login. A sound
   * created from a device that has never had this cache populated (e.g. a
   * fresh browser profile) only appears here once that device creates or
   * is told about it over the websocket — see PersonalSoundboardWorker.
   */
  personalSounds: SoundboardSound[];

  /**
   * Master volume applied on top of each sound's own volume, 0 to 2.
   */
  masterVolume: number;
}

/**
 * Handles the user's personal soundboard — sounds they can trigger in any
 * voice call, mixed directly into their outgoing microphone audio so every
 * other participant hears them exactly like normal voice, with no separate
 * realtime protocol needed.
 *
 * Backed by the real `/soundboard/sound` (Detached parent) backend routes.
 * This store only keeps this device's local cache of the account's sounds
 * (see `personalSounds`'s doc comment) — it is intentionally left out of
 * Sync.ts's STORE_KEYS, the same way "auth" is: an entity with its own
 * backend identity and lifecycle has no business being pushed around as a
 * settings blob.
 */
export class Soundboard extends AbstractStore<"soundboard", TypeSoundboard> {
  constructor(state: State) {
    super(state, "soundboard");
  }

  hydrate(): void {
    /** nothing needs to be done */
  }

  default(): TypeSoundboard {
    return {
      personalSounds: [],
      masterVolume: 1.0,
    };
  }

  clean(input: Partial<TypeSoundboard>): TypeSoundboard {
    const data = this.default();

    if (Array.isArray(input.personalSounds)) {
      data.personalSounds = input.personalSounds
        .filter(
          (sound): sound is SoundboardSound =>
            typeof sound === "object" &&
            sound !== null &&
            typeof sound.id === "string" &&
            typeof sound.name === "string" &&
            typeof sound.fileId === "string",
        )
        .map((sound) => ({
          id: sound.id,
          name: sound.name.slice(0, 32),
          emoji: typeof sound.emoji === "string" ? sound.emoji : undefined,
          fileId: sound.fileId,
          volume:
            typeof sound.volume === "number"
              ? Math.min(200, Math.max(0, sound.volume))
              : 100,
        }))
        // A soundboard with hundreds of entries stops being usable during a
        // call anyway, so cap it generously rather than let it grow forever.
        .slice(0, 100);
    }

    if (typeof input.masterVolume === "number") {
      data.masterVolume = Math.min(2, Math.max(0, input.masterVolume));
    }

    return data;
  }

  /**
   * All personal sounds, in the order they should be shown.
   */
  get personalSounds(): SoundboardSound[] {
    return this.get().personalSounds;
  }

  /**
   * Master soundboard volume, applied on top of each sound's own volume.
   */
  get masterVolume(): number {
    return this.get().masterVolume;
  }

  set masterVolume(value: number) {
    this.set("masterVolume", Math.min(2, Math.max(0, value)));
  }

  /**
   * Add a sound to the personal soundboard: creates it on the backend
   * (Detached parent) first, then caches it locally on success.
   * @param client Client
   * @param sound Name, optional emoji, Autumn file ID and volume
   * @returns The newly created sound
   */
  async addSound(
    client: Client,
    sound: {
      name: string;
      emoji?: string;
      fileId: string;
      volume?: number;
    },
  ): Promise<SoundboardSound> {
    const parent: SoundboardSoundParent = { type: "Detached" };
    const created = await client.soundboardSounds.createSound({
      name: sound.name.slice(0, 32),
      parent,
      fileId: sound.fileId,
      emoji: sound.emoji,
      volume: sound.volume,
    });

    const entry: SoundboardSound = {
      id: created.id,
      name: created.name,
      emoji: created.emoji,
      fileId: created.fileId,
      volume: created.volume,
    };

    this.cacheSound(entry);
    return entry;
  }

  /**
   * Remove a sound from the personal soundboard: deletes it on the backend
   * first, then drops it from the local cache on success.
   * @param client Client
   * @param id Sound ID
   */
  async removeSound(client: Client, id: string): Promise<void> {
    await client.soundboardSounds.deleteSound(id);
    this.uncacheSound(id);
  }

  /**
   * Rename a sound or change its emoji/volume. Local-cache only for now —
   * there is no `PATCH /soundboard/sound/<id>` call from this client yet,
   * this just keeps the cache consistent if the backend pushes an update
   * (see PersonalSoundboardWorker).
   * @param id Sound ID
   * @param patch Fields to update
   */
  updateSound(
    id: string,
    patch: Partial<Pick<SoundboardSound, "name" | "emoji" | "volume">>,
  ) {
    this.set(
      "personalSounds",
      this.get().personalSounds.map((sound) =>
        sound.id === id ? { ...sound, ...patch } : sound,
      ),
    );
  }

  /**
   * Add (or replace) a sound in this device's local cache without calling
   * the backend — used both after this device's own `addSound` succeeds,
   * and by PersonalSoundboardWorker when another session creates a
   * personal sound and this device learns about it over the websocket.
   * @param sound Sound to cache
   */
  cacheSound(sound: SoundboardSound) {
    const existing = this.get().personalSounds;
    const next = existing.some((s) => s.id === sound.id)
      ? existing.map((s) => (s.id === sound.id ? sound : s))
      : [...existing, sound];
    this.set("personalSounds", next);
  }

  /**
   * Drop a sound from this device's local cache without calling the
   * backend — used both after this device's own `removeSound` succeeds,
   * and by PersonalSoundboardWorker for a delete made elsewhere.
   * @param id Sound ID
   */
  uncacheSound(id: string) {
    this.set(
      "personalSounds",
      this.get().personalSounds.filter((sound) => sound.id !== id),
    );
  }
}
