import { Trans } from "@lingui-solid/solid/macro";

import { useState } from "@revolt/state";
import { CategoryButton, Checkbox, Column, Time, iconSize } from "@revolt/ui";

import MdBrush from "@material-design-icons/svg/outlined/brush.svg?component-solid";
import MdLanguage from "@material-design-icons/svg/outlined/language.svg?component-solid";
import MdMic from "@material-design-icons/svg/outlined/mic.svg?component-solid";
import MdPalette from "@material-design-icons/svg/outlined/palette.svg?component-solid";
import MdVolumeUp from "@material-design-icons/svg/outlined/volume_up.svg?component-solid";

/**
 * Sync Configuration Page
 */
export default function Sync() {
  const { sync } = useState();

  return (
    <Column gap="lg">
      <CategoryButton.Group>
        <CategoryButton
          action={
            <Checkbox
              checked={sync.isEnabled("settings")}
              onChange={(e) =>
                sync.setEnabled("settings", e.currentTarget.checked)
              }
            />
          }
          onClick={() =>
            sync.setEnabled("settings", !sync.isEnabled("settings"))
          }
          icon={<MdPalette {...iconSize(22)} />}
          description={
            <Trans>
              Sync appearance options, such as chosen emoji pack and message
              density.
            </Trans>
          }
        >
          <Trans>Appearance</Trans>
        </CategoryButton>
        <CategoryButton
          action={
            <Checkbox
              checked={sync.isEnabled("theme")}
              onChange={(e) =>
                sync.setEnabled("theme", e.currentTarget.checked)
              }
            />
          }
          onClick={() => sync.setEnabled("theme", !sync.isEnabled("theme"))}
          icon={<MdBrush {...iconSize(22)} />}
          description={
            <Trans>Sync your chosen theme, colours, and any custom CSS.</Trans>
          }
        >
          <Trans>Theme</Trans>
        </CategoryButton>
        <CategoryButton
          action={
            <Checkbox
              checked={sync.isEnabled("locale")}
              onChange={(e) =>
                sync.setEnabled("locale", e.currentTarget.checked)
              }
            />
          }
          onClick={() => sync.setEnabled("locale", !sync.isEnabled("locale"))}
          icon={<MdLanguage {...iconSize(22)} />}
          description={<Trans>Sync your currently chosen language.</Trans>}
        >
          <Trans>Language</Trans>
        </CategoryButton>
        <CategoryButton
          action={
            <Checkbox
              checked={sync.isEnabled("voice")}
              onChange={(e) =>
                sync.setEnabled("voice", e.currentTarget.checked)
              }
            />
          }
          onClick={() => sync.setEnabled("voice", !sync.isEnabled("voice"))}
          icon={<MdMic {...iconSize(22)} />}
          description={
            <Trans>
              Sync your voice preferences, such as noise suppression and volume
              levels. Your chosen microphone/speakers stay on this device.
            </Trans>
          }
        >
          <Trans>Voice</Trans>
        </CategoryButton>
        <CategoryButton
          action={
            <Checkbox
              checked={sync.isEnabled("sounds")}
              onChange={(e) =>
                sync.setEnabled("sounds", e.currentTarget.checked)
              }
            />
          }
          onClick={() => sync.setEnabled("sounds", !sync.isEnabled("sounds"))}
          icon={<MdVolumeUp {...iconSize(22)} />}
          description={<Trans>Sync which sound effects are enabled.</Trans>}
        >
          <Trans>Sounds</Trans>
        </CategoryButton>
      </CategoryButton.Group>
      <CategoryButton.Group>
        <CategoryButton>
          <Trans>
            Last sync <Time format="relative" value={sync.lastSyncedAt} />
          </Trans>
        </CategoryButton>
      </CategoryButton.Group>
    </Column>
  );
}
