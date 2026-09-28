import { ulid } from "ulid";

import { State } from "..";

import { AbstractStore } from ".";

/**
 * A single sound in a soundboard.
 */
export interface SoundboardSound {
  /**
   * Locally-generated stable ID for this sound (not a server-assigned ID —
   * there is no soundboard API on the backend, this store IS the source of
   * truth and syncs via the regular settings-sync mechanism).
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
   * Per-sound playback volume, 0 to 2 (1 = normal).
   */
  volume: number;
}

export interface TypeSoundboard {
  /**
   * Sounds on this user's personal soundboard, usable in any DM or voice
   * channel they join. Synced across this account's devices.
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
 * Per-server soundboards (shared with everyone in a server) are a separate
 * concern, stored differently since they aren't account-specific — see
 * `ServerSoundboard` (tracked as a follow-up).
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
              ? Math.min(2, Math.max(0, sound.volume))
              : 1.0,
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
   * Add a sound to the personal soundboard.
   * @param sound Name, optional emoji, Autumn file ID and volume
   * @returns The newly created sound
   */
  addSound(sound: {
    name: string;
    emoji?: string;
    fileId: string;
    volume?: number;
  }): SoundboardSound {
    const entry: SoundboardSound = {
      id: ulid(),
      name: sound.name.slice(0, 32),
      emoji: sound.emoji,
      fileId: sound.fileId,
      volume: sound.volume ?? 1.0,
    };

    this.set("personalSounds", [...this.get().personalSounds, entry]);
    return entry;
  }

  /**
   * Remove a sound from the personal soundboard.
   * @param id Sound ID
   */
  removeSound(id: string) {
    this.set(
      "personalSounds",
      this.get().personalSounds.filter((sound) => sound.id !== id),
    );
  }

  /**
   * Rename a sound or change its emoji/volume.
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
}
