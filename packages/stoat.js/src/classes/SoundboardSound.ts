import { decodeTime } from "ulid";

import type { SoundboardSoundCollection } from "../collections/SoundboardSoundCollection.js";
import type { SoundboardSoundParent } from "../hydration/soundboardSound.js";

import type { User } from "./User.js";

/**
 * SoundboardSound Class
 *
 * A single sound on a soundboard — either shared on a server
 * (`parent.type === "Server"`) or personal to the current account
 * (`parent.type === "Detached"`). Backed by the real `/soundboard/*`
 * backend routes, not by a message/attachment hack.
 */
export class SoundboardSound {
  readonly #collection: SoundboardSoundCollection;
  readonly id: string;

  /**
   * Construct SoundboardSound
   * @param collection Collection
   * @param id Sound Id
   */
  constructor(collection: SoundboardSoundCollection, id: string) {
    this.#collection = collection;
    this.id = id;
  }

  /**
   * Whether this object exists
   */
  get $exists(): boolean {
    return !!this.#collection.getUnderlyingObject(this.id).id;
  }

  /**
   * Time when this sound was created
   */
  get createdAt(): Date {
    return new Date(decodeTime(this.id));
  }

  /**
   * Where this sound lives: a server's shared board, or the creator's
   * personal (Detached) board
   */
  get parent(): SoundboardSoundParent {
    return this.#collection.getUnderlyingObject(this.id).parent;
  }

  /**
   * Id of whoever created this sound
   */
  get creatorId(): string {
    return this.#collection.getUnderlyingObject(this.id).creatorId;
  }

  /**
   * Creator of the sound, if known locally
   */
  get creator(): User | undefined {
    return this.#collection.client.users.get(this.creatorId);
  }

  /**
   * Display name
   */
  get name(): string {
    return this.#collection.getUnderlyingObject(this.id).name;
  }

  /**
   * Optional emoji shown alongside the name
   */
  get emoji(): string | undefined {
    return this.#collection.getUnderlyingObject(this.id).emoji;
  }

  /**
   * Autumn file id of the uploaded audio
   */
  get fileId(): string {
    return this.#collection.getUnderlyingObject(this.id).fileId;
  }

  /**
   * Playback volume, 0-200 (100 = normal)
   */
  get volume(): number {
    return this.#collection.getUnderlyingObject(this.id).volume;
  }

  /**
   * Whether this is one of the permanent starter-pack sounds, which can
   * never be deleted
   */
  get isDefault(): boolean {
    return this.#collection.getUnderlyingObject(this.id).isDefault;
  }

  /**
   * URL to download/play the sound's audio file
   */
  get url(): string | undefined {
    const autumnUrl = this.#collection.client.configuration?.features.autumn
      .url;
    return autumnUrl ? `${autumnUrl}/attachments/${this.fileId}` : undefined;
  }

  /**
   * Delete this sound. Creator or (for a Server-parented sound)
   * ManageCustomisation may delete; a Detached sound may only be deleted
   * by its creator.
   */
  async delete(): Promise<void> {
    await this.#collection.deleteSound(this.id);
  }
}
