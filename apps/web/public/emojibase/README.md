# Emoji data (self-hosted)

`17.0.0/en/{data.json,messages.json}` and `17.0.0/LICENSE` are copied verbatim from the npm tarball
`emojibase-data@17.0.0` (MIT, github.com/milesj/emojibase; tarball integrity
`sha512-Yvgb5AWoHViHV/gq1qr5ZAarcBip+B27/ZLRsUJkbgAEaLlZ/fof9g882LTpmEpyhBNEC0m2SEmItljHsTygjA==`).

The emoji picker (`components/chat/emoji-picker.tsx`, frimousse) loads them from this origin instead of its default
CDN, so the picker works on air-gapped self-hosted installs and no browser talks to a third party (AGENTS.md
principle 10). Data only: nothing here is executed.

To upgrade: `npm pack emojibase-data@<version>`, copy `en/data.json`, `en/messages.json` and `LICENSE` into a new
`<version>/` directory and update `EMOJIBASE_URL` in the picker.
