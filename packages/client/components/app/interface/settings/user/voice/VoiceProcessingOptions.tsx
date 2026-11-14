import { Show, createSignal } from "solid-js";

import { Trans } from "@lingui/solid/macro";

import { getVoiceLog, voiceProcessorStatus } from "@revolt/rtc/VoiceProcessor";
import { useState } from "@revolt/state";
import { CategoryButton, Checkbox, Column, Text } from "@revolt/ui";

/** Equipos con pocos núcleos: DeepFilterNet3 puede entrecortar el audio */
const LOW_CORES = (navigator.hardwareConcurrency ?? 8) <= 4;

/**
 * Voice processing options
 */
export function VoiceProcessingOptions() {
  const { voice } = useState();
  const [copied, setCopied] = createSignal(false);

  /** Copia el registro de audio (o lo descarga como .log si no se puede copiar) */
  async function copyLog() {
    const text = getVoiceLog(voice);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "starknetchat-audio.log";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 4000);
  }

  return (
    <Column>
      <Text class="title">
        <Trans>Voice Processing</Trans>
      </Text>
      <CategoryButton.Group>
        <CategoryButton.Select
          icon={"blank"}
          title={<Trans>Select noise suppression</Trans>}
          options={{
            disabled: { title: <Trans>Disabled</Trans> },
            browser: { title: <Trans>Browser</Trans> },
            enhanced: {
              title: <Trans>Enhanced</Trans>,
              description: <Trans>Powered by RNNoise</Trans>,
              shortDesc: <Trans>Enhanced (RNNoise)</Trans>,
            },
            deepfilter: {
              title: <Trans>Maximum quality (experimental)</Trans>,
              description: LOW_CORES ? (
                <Trans>
                  Powered by DeepFilterNet3. Your device has few CPU cores, so
                  this may cause choppy audio. Use Enhanced if it does.
                </Trans>
              ) : (
                <Trans>
                  Powered by DeepFilterNet3. Better voice quality, uses more
                  CPU. Falls back to Enhanced if it cannot load.
                </Trans>
              ),
              shortDesc: <Trans>Maximum (DeepFilterNet3)</Trans>,
            },
          }}
          value={voice.noiseSupression}
          onUpdate={(ns) => (voice.noiseSupression = ns)}
        />
        <CategoryButton
          icon="blank"
          action={<Checkbox checked={voice.echoCancellation} />}
          onClick={() => (voice.echoCancellation = !voice.echoCancellation)}
        >
          <Trans>Browser Echo Cancellation</Trans>
        </CategoryButton>
        <CategoryButton
          icon="blank"
          action={<Checkbox checked={voice.autoGainControl} />}
          onClick={() => (voice.autoGainControl = !voice.autoGainControl)}
        >
          <Trans>Automatic Gain Control</Trans>
        </CategoryButton>
      </CategoryButton.Group>
      <Show when={voiceProcessorStatus()}>
        <Text class="label">Audio: {voiceProcessorStatus()}</Text>
      </Show>
      <CategoryButton.Group>
        <CategoryButton
          icon="blank"
          description={
            copied() ? (
              <Trans>
                Copied. Paste it in a message to the person helping you.
              </Trans>
            ) : (
              <Trans>
                Technical details to find out why the microphone or noise
                suppression fails.
              </Trans>
            )
          }
          onClick={() => void copyLog()}
        >
          <Trans>Copy audio log</Trans>
        </CategoryButton>
      </CategoryButton.Group>
    </Column>
  );
}
