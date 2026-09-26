import type { Room } from "livekit-client";

import {
  exportCallKeyRaw,
  generateCallKey,
  importPublicKey,
  unwrapCallKey,
  wrapCallKeyForParticipant,
  type WrappedBundle,
} from "./cryptoEngine";
import { getDeviceId } from "./deviceIdentity";

const MESSAGE_TYPE = "starknet-e2ee-call-key";

interface KeyMessage {
  type: typeof MESSAGE_TYPE;
  to_device_id: string;
  from_device_id: string;
  sender_public_key: JsonWebKey;
  bundle: WrappedBundle;
}

interface StoatApiLike {
  get: (path: string) => Promise<{ devices: { device_id: string; public_key: JsonWebKey }[] }>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Solo lo llama quien INICIA la llamada. Reparte una clave nueva,
 * generada exclusivamente para esta llamada, envuelta por separado
 * para cada dispositivo de cada participante ya presente en la sala.
 * Devuelve la clave en crudo para que el propio iniciador también la
 * use localmente.
 */
export async function distributeNewCallKey(
  room: Room,
  api: StoatApiLike,
  myDeviceId: string,
  myPrivateKey: CryptoKey,
  myPublicKeyJwk: JsonWebKey,
): Promise<Uint8Array> {
  const callKey = await generateCallKey();

  const remoteUserIds = [...room.remoteParticipants.values()].map(
    (p) => p.identity,
  );

  for (const userId of remoteUserIds) {
    let devices: { device_id: string; public_key: JsonWebKey }[] = [];
    try {
      const res = await api.get(`/e2ee/devices/${userId}`);
      devices = res.devices;
    } catch (e) {
      console.error(
        `[e2ee] No se pudieron obtener los dispositivos de ${userId}:`,
        e,
      );
      continue;
    }

    for (const device of devices) {
      try {
        const theirPublicKey = await importPublicKey(device.public_key);
        const bundle = await wrapCallKeyForParticipant(
          callKey,
          myPrivateKey,
          theirPublicKey,
        );

        const message: KeyMessage = {
          type: MESSAGE_TYPE,
          to_device_id: device.device_id,
          from_device_id: myDeviceId,
          sender_public_key: myPublicKeyJwk,
          bundle,
        };

        await room.localParticipant.publishData(
          encoder.encode(JSON.stringify(message)),
          { reliable: true },
        );
      } catch (e) {
        console.error(
          `[e2ee] No se pudo enviar la clave al dispositivo ${device.device_id}:`,
          e,
        );
      }
    }
  }

  return exportCallKeyRaw(callKey);
}

/**
 * Lo llama todo el mundo (iniciador incluido, por si acaso, aunque
 * normalmente ya tiene la clave de sobra). Se queda escuchando el
 * canal de datos de la sala hasta que llega un paquete dirigido a
 * ESTE dispositivo, lo desenvuelve, y resuelve con la clave en
 * crudo lista para dársela a LiveKit.
 *
 * Importante: hay que llamar a esto ANTES de que el iniciador
 * reparta la clave (o aceptar perderse el primer intento y esperar
 * a una futura re-negociación) — en la integración real conviene
 * registrar este listener justo después de conectar a la sala.
 */
export function listenForIncomingCallKey(
  room: Room,
  myDeviceId: string,
  myPrivateKey: CryptoKey,
): Promise<Uint8Array> {
  return new Promise((resolve) => {
    const handler = async (payload: Uint8Array) => {
      let message: KeyMessage;
      try {
        message = JSON.parse(decoder.decode(payload));
      } catch {
        return; // no es un mensaje nuestro, se ignora
      }

      if (
        message.type !== MESSAGE_TYPE ||
        message.to_device_id !== myDeviceId
      ) {
        return; // no es para este dispositivo
      }

      try {
        const senderPublicKey = await importPublicKey(
          message.sender_public_key,
        );
        const callKey = await unwrapCallKey(
          message.bundle,
          myPrivateKey,
          senderPublicKey,
        );
        room.off("dataReceived", handler);
        resolve(await exportCallKeyRaw(callKey));
      } catch (e) {
        console.error("[e2ee] No se pudo desenvolver la clave recibida:", e);
      }
    };

    room.on("dataReceived", handler);
  });
}
