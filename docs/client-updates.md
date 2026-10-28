# Client updates (Android / Windows x64)

Main still runs existing CI and Android artifact builds. `Client test prerelease`
additionally tests both clients, builds installers, then publishes an immutable
GitHub **Pre-release** only after project checks and both builds pass.
No NAS/Server deployment is involved. Default client channel is **stable**;
users must explicitly select **test** to receive main builds.

## Identity and channels

One workflow owns the test sequence: `buildNumber = 1000 + github.run_number`,
version `0.3.<buildNumber>`, tag `client-test-<buildNumber>`, commit is full SHA.
Reruns keep identity and never overwrite published assets. Build number is bounded
to 65535 (Windows numeric version component); plan a version scheme migration
before reaching that bound, do not reset it or rename this workflow's sequence.
Android `versionCode` equals the build number. Local development defaults to 3,
which is higher than the previous versionCode 2 but is not a published identity.

Clients enumerate releases (up to 500), ignore drafts, and match explicit
prerelease + `client-test-*` for test, non-prerelease + `client-stable-*` for
stable. They compare numeric build numbers, not commit hashes. Stable publication
is manual/not implemented by this main workflow; its metadata must follow the
same contract, have `channel: stable`, and use a higher global build number.
Stable and test builds share app identity and data: switching channels never
forces downgrade. No available newer version is not a network error.

`update-manifest.json` schemaVersion 1 carries channel, buildNumber, version,
commit, minimumServerVersion (null = no additional requirement), and platforms
`android` / `windows-x64`, each with file, sha256, size. Metadata and files come
only from the configured public repository release. No GitHub token is embedded.
SHA256 authenticates package bytes against the HTTPS release metadata, not an
independent signing authority. Protect repository write permissions.

## Fixed Android signing — required before publishing

**Do not generate a new key. Do not upload a debug keystore from a different
machine and assume compatibility.** Use the existing keystore that signed the
user's installed compatible APK, with a secure offline backup.

A repository administrator must configure these Actions Secrets through GitHub's
secure UI (Settings → Secrets and variables → Actions), not chat:

- `ANDROID_TEST_KEYSTORE_BASE64`: base64 of the existing compatible keystore
- `ANDROID_TEST_STORE_PASSWORD`
- `ANDROID_TEST_KEY_ALIAS`
- `ANDROID_TEST_KEY_PASSWORD`

Configure repository Actions variable `ANDROID_TEST_CERT_SHA256` with the
64-hex SHA256 certificate fingerprint of the known-compatible APK, with no
colons. This is a public certificate digest, not a private key. Verify using
`apksigner verify --print-certs <known-compatible.apk>` on the owner's machine.

The workflow materializes the key only under runner.temp, cleans it on exit,
never uploads it, verifies resulting APK certificate against the pinned digest,
and refuses publishing when any signing input is absent. Regular debug tests
still run without secrets. Successful publication does **not** prove real-device
cover installation: that requires user-confirmed installation, never uninstall.
The client independently checks APK package ID, versionCode, SHA256 and current
installed signer before offering installation. Signing rotation is not supported.

## Upgrade interaction and boundaries

Settings → Client updates → choose channel → check → explicitly download →
verify → explicitly install. Android invokes the platform package installer,
requests unknown-source permission only on explicit installation, and rechecks
file integrity and refreshed Bot activity before install. If tasks are running,
installation is deferred; users must also end calls/phone control first. No
silent installation, background forced restart, uninstall or data migration.
Windows installer is currently unsigned, and must be confirmed by the user.
Existing installations without the updater need one manual bootstrap install.
Network/rate-limit/download/hash/signature failure must leave the old app usable.

## Verification

- `node --test scripts/client-update/update.test.mjs`
- Android: `./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug`
- Windows: `npm run pack:win --workspace=pi-bot-desktop` on native Windows x64
- Main workflow gates publication on reusable full CI and both platform builds.
- Final acceptance: a real release with both packages/manifest; stable sees no
  test prompt; test sees newer numeric build; corrupt file rejected; update
  overlay preserves settings; activity defers install; network failure preserves
  old app. These are acceptance steps, not claims of completed device tests.
