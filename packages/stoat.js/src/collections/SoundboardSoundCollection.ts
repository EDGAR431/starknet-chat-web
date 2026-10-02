import { SoundboardSound } from "../classes/SoundboardSound.js";
import type {
  APISoundboardSound,
  HydratedSoundboardSound,
  SoundboardSoundParent,
} from "../hydration/soundboardSound.js";

import { ClassCollection } from "./Collection.js";

/**
 * The slice of `Client` this collection needs to make raw requests against
 * `/soundboard/*`. Declared narrow (rather than importing `Client`/`API`)
 * because `API#baseURL` is private on the `stoat-api` class — going through
 * a plain object type here is how the rest of this client already reaches
 * routes that package doesn't know about yet (see e2ee/deviceIdentity.ts
 * in the client package for the same trick against a different endpoint).
 */
type SoundboardApiClient = {
  api: { baseURL: string };
  authenticationHeader: [string, string];
};

/**
 * `client.api.get/post/delete` only accept paths baked into the `stoat-api`
 * package's generated route types, so they can't be used for
 * `/soundboard/*` until that package ships them. This makes the same kind
 * of request by hand, reusing the client's own base URL and auth header.
 */
async function soundboardRequest<T>(
  client: SoundboardApiClient,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const [headerName, headerValue] = client.authenticationHeader;

  const res = await fetch(`${client.api.baseURL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      [headerName]: headerValue,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = res.status === 204 ? "" : await res.text();
  const data = text ? JSON.parse(text) : undefined;

  if (!res.ok) {
    throw data ?? new Error(`Soundboard request failed (${res.status})`);
  }

  return data as T;
}

/**
 * Collection of SoundboardSound
 */
export class SoundboardSoundCollection extends ClassCollection<
  SoundboardSound,
  HydratedSoundboardSound
> {
  /**
   * `this.client` typed down to just what `soundboardRequest` needs.
   * `API#baseURL` is private, so reaching it from outside the `API` class
   * requires going through `unknown` first — same cast the client package
   * already uses in e2ee/deviceIdentity.ts for the same reason.
   */
  get #apiClient(): SoundboardApiClient {
    return this.client as unknown as SoundboardApiClient;
  }

  /**
   * Get or create
   * @param id Id
   * @param data Data
   * @param isNew Whether this object is new
   */
  getOrCreate(
    id: string,
    data: APISoundboardSound,
    isNew = false,
  ): SoundboardSound {
    if (this.has(id) && !this.isPartial(id)) {
      return this.get(id)!;
    } else {
      const instance = new SoundboardSound(this, id);
      this.create(id, "soundboardSound", instance, this.client, data);
      if (isNew) this.client.emit("soundboardSoundCreate", instance);
      return instance;
    }
  }

  /**
   * Get or return partial
   * @param id Id
   */
  getOrPartial(id: string): SoundboardSound | undefined {
    if (this.has(id)) {
      return this.get(id)!;
    } else if (this.client.options.partials) {
      const instance = new SoundboardSound(this, id);
      this.create(id, "soundboardSound", instance, this.client, { id });
      return instance;
    }
  }

  /**
   * Fetch every sound on a server's shared soundboard.
   * @param serverId Server Id
   */
  async fetchForServer(serverId: string): Promise<SoundboardSound[]> {
    const sounds = await soundboardRequest<APISoundboardSound[]>(
      this.#apiClient,
      "GET",
      `/soundboard/server/${serverId}`,
    );

    return sounds.map((sound) => this.getOrCreate(sound._id, sound));
  }

  /**
   * Create a soundboard sound, either on a server's board (requires
   * ManageCustomisation there) or on the current user's personal
   * (Detached) board.
   * @param data Name, parent, already-uploaded file id, and optional emoji/volume
   */
  async createSound(data: {
    name: string;
    parent: SoundboardSoundParent;
    fileId: string;
    emoji?: string;
    volume?: number;
  }): Promise<SoundboardSound> {
    const sound = await soundboardRequest<APISoundboardSound>(
      this.#apiClient,
      "POST",
      "/soundboard/sound",
      {
        name: data.name,
        parent: data.parent,
        emoji: data.emoji,
        file_id: data.fileId,
        volume: data.volume,
      },
    );

    return this.getOrCreate(sound._id, sound, true);
  }

  /**
   * Delete a soundboard sound. Creator or (for Server-parented sounds)
   * ManageCustomisation may delete; a Detached sound may only be deleted
   * by its creator.
   * @param id Sound Id
   */
  async deleteSound(id: string): Promise<void> {
    await soundboardRequest(this.#apiClient, "DELETE", `/soundboard/sound/${id}`);

    if (this.getOrPartial(id)) {
      const sound = this.getUnderlyingObject(id);
      this.client.emit("soundboardSoundDelete", sound);
      this.delete(id);
    }
  }
}
