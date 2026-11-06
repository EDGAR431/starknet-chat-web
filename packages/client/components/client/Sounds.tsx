import { createContext, JSXElement, useContext } from "solid-js";

import { Sounds, TypeSounds, useState } from "@revolt/state";
import deafenSound from "../../public/assets/sounds/deafen.ogg";
import messageSound from "../../public/assets/sounds/message_sound.ogg";
import muteSound from "../../public/assets/sounds/mute.ogg";
import ringtoneIncomingSound from "../../public/assets/sounds/ringtone_incoming.ogg";
import ringtoneOutgoingSound from "../../public/assets/sounds/ringtone_outgoing.ogg";
import streamEndSound from "../../public/assets/sounds/stream_end.ogg";
import streamStartSound from "../../public/assets/sounds/stream_start.ogg";
import streamViewerJoinSound from "../../public/assets/sounds/stream_viewer_join.ogg";
import streamViewerLeaveSound from "../../public/assets/sounds/stream_viewer_leave.ogg";
import undeafenSound from "../../public/assets/sounds/undeafen.ogg";
import unmuteSound from "../../public/assets/sounds/unmute.ogg";
import userJoinVoiceSound from "../../public/assets/sounds/user_join_voice.ogg";
import userLeaveVoiceSound from "../../public/assets/sounds/user_leave_voice.ogg";
import userMovedSound from "../../public/assets/sounds/user_moved.ogg";

/**
 * Play an audio element. If the browser blocks it (autoplay policy: no user
 * gesture yet), try again on the next click/key press instead of dropping it
 * silently. Other failures are logged.
 */
function playWithRetry(node: HTMLAudioElement) {
  node.play().catch((err: unknown) => {
    if ((err as DOMException)?.name !== "NotAllowedError") {
      console.warn("[sound] playback failed", err);
      return;
    }
    const retry = () => {
      document.removeEventListener("pointerdown", retry, true);
      document.removeEventListener("keydown", retry, true);
      // only if it is still wanted (loops are paused/cleared on stop)
      if (node.loop && !node.getAttribute("src")) return;
      node.play().catch(() => {});
    };
    document.addEventListener("pointerdown", retry, true);
    document.addEventListener("keydown", retry, true);
  });
}

/**
 * A controller class for making sure sounds are managed in one place and to prevent undesirable sound overlaps
 */
export class SoundController {
  readonly soundState: Sounds;

  node?: HTMLAudioElement;

  lastPlayedSound?: keyof TypeSounds;

  constructor(soundState: Sounds) {
    this.soundState = soundState;

    this.isPlaying = this.isPlaying.bind(this);
    this.canPlay = this.canPlay.bind(this);
    this.playSound = this.playSound.bind(this);
  }

  /**
   * Get whether a sound is currently being played by the sound controller
   *
   * @returns Whether a sound is currently playing
   */
  isPlaying(): boolean {
    return this.node?.paused ?? false;
  }

  /**
   * Get whether a sound can be played right now
   *
   * @param newSound Sound to check for playability
   * @returns Whether the sound passed is playable currently
   */
  canPlay(newSound: keyof TypeSounds): boolean {
    // Never let a sound turned off play
    if (!this.soundState.enabled(newSound)) {
      return false;
    }

    // Always let the sound play if nothing is currently playing
    if (!this.isPlaying()) {
      return true;
    }

    // If there are any cases where you don't want sound collisions, put them here.
    // None for now.
    return true;
  }

  /**
   * Play a sound, following the rules of sound playability unless force is true
   *
   * @param sound The sound to play
   * @param force Bypass canPlay check
   * @returns Whether the sound played
   */
  playSound(sound: keyof TypeSounds, force?: boolean): boolean {
    if (!force && !this.canPlay(sound)) {
      return false;
    }
    switch (sound) {
      case "deafen": {
        this.node = new Audio(deafenSound);
        break;
      }
      case "message": {
        this.node = new Audio(messageSound);
        break;
      }
      case "mute": {
        this.node = new Audio(muteSound);
        break;
      }
      case "ringtoneIncoming": {
        this.node = new Audio(ringtoneIncomingSound);
        break;
      }
      case "ringtoneOutgoing": {
        this.node = new Audio(ringtoneOutgoingSound);
        break;
      }
      case "streamEnd": {
        this.node = new Audio(streamEndSound);
        break;
      }
      case "streamStart": {
        this.node = new Audio(streamStartSound);
        break;
      }
      case "streamViewerJoin": {
        this.node = new Audio(streamViewerJoinSound);
        break;
      }
      case "streamViewerLeave": {
        this.node = new Audio(streamViewerLeaveSound);
        break;
      }
      case "undeafen": {
        this.node = new Audio(undeafenSound);
        break;
      }
      case "unmute": {
        this.node = new Audio(unmuteSound);
        break;
      }
      case "userJoinVoice": {
        this.node = new Audio(userJoinVoiceSound);
        break;
      }
      case "userLeaveVoice": {
        this.node = new Audio(userLeaveVoiceSound);
        break;
      }
      case "userMoved": {
        this.node = new Audio(userMovedSound);
        break;
      }
    }
    this.lastPlayedSound = sound;
    // Browsers may block audio before the first user interaction; never throw.
    playWithRetry(this.node);
    return true;
  }

  #loopNode?: HTMLAudioElement;

  /**
   * Start a looping ringtone (incoming / outgoing call). Stops any ringtone
   * that is already looping. Respects the user's sound settings.
   *
   * @param sound Which ringtone to loop
   * @returns Whether the ringtone started
   */
  startLoop(sound: "ringtoneIncoming" | "ringtoneOutgoing"): boolean {
    this.stopLoop();
    if (!this.soundState.enabled(sound)) return false;

    const node = new Audio(
      sound === "ringtoneIncoming"
        ? ringtoneIncomingSound
        : ringtoneOutgoingSound,
    );
    node.loop = true;
    this.#loopNode = node;
    playWithRetry(node);
    return true;
  }

  /**
   * Stop the looping ringtone, if any
   */
  stopLoop() {
    if (!this.#loopNode) return;
    this.#loopNode.pause();
    this.#loopNode.removeAttribute("src");
    this.#loopNode = undefined;
  }
}

const soundContext = createContext(null! as SoundController);

export function SoundContext(props: { children: JSXElement }) {
  const { sounds } = useState();

  const controller = new SoundController(sounds);

  return (
    <soundContext.Provider value={controller}>
      {props.children}
    </soundContext.Provider>
  );
}

export function useSound(): SoundController {
  return useContext(soundContext);
}
