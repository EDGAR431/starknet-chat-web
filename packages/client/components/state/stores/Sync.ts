import isEqual from "lodash.isequal";
import { batch } from "solid-js";

import { ReactiveSet } from "@solid-primitives/set";
import { Client } from "stoat.js";

import { State } from "..";

import { AbstractStore } from ".";
import { TypeLocale } from "./Locale";
import { TypeNotificationOptions } from "./NotificationOptions";
import { TypeOrdering } from "./Ordering";
import { TypeReleaseNotes } from "./ReleaseNotes";
import { TypeSettings } from "./Settings";
import { TypeSounds } from "./Sounds";
import { TypeTheme } from "./Theme";
import { TypeVoice } from "./Voice";

type SynchronisedStores =
  | "ordering"
  | "notifications"
  | "release-notes"
  | "server-folders"
  | "theme"
  | "locale"
  | "sounds"
  | "voice"
  | "settings";

const STORE_KEYS: SynchronisedStores[] = [
  "ordering",
  "notifications",
  "release-notes",
  "server-folders",
  "theme",
  "locale",
  "sounds",
  "voice",
  "settings",
];

/**
 * Categories the user can individually turn off from this device's sync —
 * the rest (ordering, notifications, release notes, server folders) always
 * synced already before this was introduced, so they stay on unconditionally.
 */
export const OPTIONAL_SYNC_CATEGORIES: SynchronisedStores[] = [
  "theme",
  "locale",
  "sounds",
  "voice",
  "settings",
];

export interface TypeSynchronisation {
  revision: Record<SynchronisedStores, number>;

  /**
   * Categories from OPTIONAL_SYNC_CATEGORIES that THIS device has opted
   * out of syncing. This choice is itself local-only — whether to sync a
   * kiosk/shared computer's theme is a decision about that computer, not
   * about the account.
   */
  disabledOnThisDevice: SynchronisedStores[];

  /**
   * Timestamp of the last successful sync in either direction, so the
   * settings screen can show something real instead of a placeholder.
   */
  lastSyncedAt: number;
}

/**
 * Synchronisation orchestration
 */
export class Sync extends AbstractStore<"sync", TypeSynchronisation> {
  /**
   * Block sync for remote updates
   */
  #blockSync: Set<SynchronisedStores>;

  /**
   * Keys that need to be synced out
   */
  #syncQueue: ReactiveSet<SynchronisedStores>;

  /**
   * Construct store
   * @param state State
   */
  constructor(state: State) {
    super(state, "sync");
    this.#blockSync = new Set();
    this.#syncQueue = new ReactiveSet();
  }

  /**
   * Hydrate external context
   */
  hydrate(): void {}

  /**
   * Generate default values
   */
  default(): TypeSynchronisation {
    return {
      revision: STORE_KEYS.reduce(
        (d, k) => ({ ...d, [k]: 0 }),
        {} as TypeSynchronisation["revision"],
      ),
      disabledOnThisDevice: [],
      lastSyncedAt: 0,
    };
  }

  /**
   * Validate the given data to see if it is compliant and return a compliant object
   */
  clean(input: Partial<TypeSynchronisation>): TypeSynchronisation {
    return {
      revision: Object.keys(input.revision ?? {})
        .filter((key) => STORE_KEYS.includes(key as SynchronisedStores))
        .filter((key) => input.revision?.[key as SynchronisedStores])
        .reduce(
          (d, k) => ({ ...d, [k]: input.revision?.[k as SynchronisedStores] }),
          this.default().revision,
        ),
      disabledOnThisDevice: (input.disabledOnThisDevice ?? []).filter((key) =>
        OPTIONAL_SYNC_CATEGORIES.includes(key),
      ),
      lastSyncedAt:
        typeof input.lastSyncedAt === "number" ? input.lastSyncedAt : 0,
    };
  }

  /**
   * Whether a category is currently syncing from/to this device
   * @param key Store key
   */
  isEnabled(key: SynchronisedStores): boolean {
    return !this.get().disabledOnThisDevice.includes(key);
  }

  /**
   * Turn syncing of a category on/off for this device only. This choice is
   * never uploaded — it stays local, same reasoning as localOnlyKeys().
   * @param key Store key
   * @param enabled Whether this device should sync this category
   */
  setEnabled(key: SynchronisedStores, enabled: boolean) {
    if (!OPTIONAL_SYNC_CATEGORIES.includes(key)) return;

    const disabled = this.get().disabledOnThisDevice.filter((k) => k !== key);
    if (!enabled) disabled.push(key);
    this.set("disabledOnThisDevice", disabled);

    // re-enabling: push what's currently on this device up right away,
    // rather than waiting for the next unrelated change to that category
    if (enabled) this.touch(key);
  }

  /**
   * Strip out this store's local-only fields before it leaves the device
   * @param key Store key
   */
  private stripLocalOnly(key: SynchronisedStores): unknown {
    const value = this.state.get(key) as Record<string, unknown>;
    const localOnlyKeys = this.state[key].localOnlyKeys() as string[];
    if (localOnlyKeys.length === 0) return value;

    const copy = { ...value };
    for (const localKey of localOnlyKeys) {
      delete copy[localKey];
    }
    return copy;
  }

  /**
   * Synchronise data into store
   * @param client Client
   */
  async initialSync(client: Client) {
    const keys = STORE_KEYS.filter((key) => this.isEnabled(key));
    const response = await client.api.post("/sync/settings/fetch", {
      keys,
    });

    for (const key in response) {
      const [ts, data] = response[key];
      this.merge(ts, key as SynchronisedStores, data);
    }

    this.set("lastSyncedAt", +new Date());
  }

  /**
   * Send data to remote
   * @param client Client
   */
  async save(client: Client) {
    // find all keys for sync, skipping any category disabled on this device
    const keys = this.#syncQueue
      .keys()
      .toArray()
      .filter((key) => this.isEnabled(key));

    if (keys.length === 0) {
      // everything queued belongs to a category disabled on this device —
      // drop it from the queue rather than spinning on it forever
      const disabledKeys = this.#syncQueue.keys().toArray();
      batch(() => disabledKeys.forEach((k) => this.#syncQueue.delete(k)));
      return;
    }

    // due to API constraints, merge ts down
    const ts = +new Date();

    // generate payload, leaving out anything that must stay on this device
    const payload = keys.reduce(
      (d, k) => ({
        ...d,
        [k]: JSON.stringify(this.stripLocalOnly(k)),
      }),
      {
        timestamp: ts,
      },
    );

    // apply new ts and remove all of the keys
    batch(() =>
      keys.forEach((key) => {
        this.set("revision", key, ts);
        this.#syncQueue.delete(key);
      }),
    );

    // send data to the server
    await client.api.post("/sync/settings/set", payload);

    this.set("lastSyncedAt", +new Date());
  }

  /**
   * Get revision for key
   * @param key Key
   * @returns Revision timestamp
   */
  private ts(key: SynchronisedStores) {
    return this.get().revision[key];
  }

  /**
   * Update timestamp for key
   * @param key Key
   */
  touch(key: SynchronisedStores) {
    if (this.#blockSync.has(key)) {
      this.#blockSync.delete(key);
      return;
    }

    if (!this.isEnabled(key)) return;

    this.set("revision", key, +new Date());
    this.#syncQueue.add(key);
  }

  /**
   * Update timestamp for key
   * @param key Key
   */
  touchIfSyncable(key: string) {
    if (STORE_KEYS.includes(key as SynchronisedStores)) {
      this.touch(key as SynchronisedStores);
    }
  }

  /**
   * Merge data
   * @param ts Timestamp
   * @param key Store key
   * @param data Data to merge
   */
  merge(ts: number, key: SynchronisedStores, data: string) {
    if (!this.isEnabled(key)) return;

    if (import.meta.env.DEV)
      console.info(`[sync] merge ${key} at ${ts} with`, data);

    const parsed = this.state[key].clean(JSON.parse(data));
    if (!this.ts(key) || ts > this.ts(key)) {
      // preserve this device's local-only fields — the remote copy never
      // had them (they're stripped before upload), so `parsed` only holds
      // their defaults, which would otherwise wipe out what's set here
      const localOnlyKeys = this.state[
        key
      ].localOnlyKeys() as (keyof typeof parsed)[];
      const current = this.state.get(key) as typeof parsed;
      for (const localKey of localOnlyKeys) {
        parsed[localKey] = current[localKey];
      }

      // if ts is newer or this value does not exist on the local store, hydrate the store with it
      this.set("revision", key, ts);
      this.#blockSync.add(key);
      this.state.set(key, parsed);
    } else if (ts !== this.ts(key)) {
      // if ts is old, trigger write to synchronise to remote, but only if the data has been updated
      if (
        !isEqual(
          this.state.get(key),
          parsed as TypeOrdering &
            TypeNotificationOptions &
            TypeReleaseNotes &
            TypeTheme &
            TypeLocale &
            TypeSounds &
            TypeVoice &
            TypeSettings,
        )
      ) {
        this.touch(key);
      }
    }
  }

  /**
   * Consume client events
   * @param event Update event
   */
  consumeEvent(event: Record<string, [number, string]>) {
    for (const key in event) {
      if (STORE_KEYS.includes(key as SynchronisedStores)) {
        const [ts, data] = event[key];
        this.merge(ts, key as SynchronisedStores, data);
      }
    }
  }

  /**
   * Whether there are items in queue to sync
   */
  get shouldSync() {
    return this.#syncQueue
      .keys()
      .toArray()
      .some((key) => this.isEnabled(key));
  }

  /**
   * Timestamp of the last successful sync, for display in settings
   */
  get lastSyncedAt(): number {
    return this.get().lastSyncedAt;
  }
}
