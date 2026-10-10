# Desktop release trust configuration (`updates.json`)

Lane U owns the updater's trust boundary. This file is the **packaged** authority
that makes release delivery possible; it is read by
`port/src-tauri/app/src/update_security.rs` and
`port/src-tauri/app/src/update_flow.rs`.

## Why it is not a setting

The release feed used to come from the renderer-writable settings store
(`updates.feed-url`, `updates.feed-url-beta`). A page document can write
settings, so that made the renderer able to choose which artifact the shell would
download and, eventually, execute. Authority now comes from a file that ships
with the build, matching upstream's rule that an application without a packaged
update source (`app-update.yml`) has no release delivery at all.

**Missing trust disables delivery.** If this file is absent, unreadable,
unparseable, or internally inconsistent, `update_check` reports a classified
failure and no network request is made. An unsigned or hash-only manifest is
never installable.

## Where it is read from

`load_packaged_trust` searches, in order:

1. `<directory of the running executable>/updates.json`
2. `<Tauri resource directory>/updates.json`

The first `Loaded` result wins. A malformed file at either location **disables
delivery** rather than falling through to the next candidate: silently using
another file would hide a broken installation.

## Schema

```json
{
  "configVersion": 1,
  "pinnedChannel": "stable",
  "stable": {
    "feedUrl": "https://updates.example.com/stable/latest.json",
    "allowedOrigins": ["updates.example.com"],
    "trustedKeys": [
      "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c"
    ]
  },
  "beta": {
    "feedUrl": "https://updates.example.com/beta/latest.json",
    "allowedOrigins": ["updates.example.com"],
    "trustedKeys": [
      "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"
    ]
  }
}
```

Unknown fields are rejected (`deny_unknown_fields`), so a typo cannot silently
drop a security-relevant field.

| Field | Rule |
| --- | --- |
| `configVersion` | Positive integer. Required. |
| `pinnedChannel` | Optional `"stable"` or `"beta"`. When set, the other channel is refused, so a deployment cannot silently check a different channel than the one its build targets. |
| `stable` / `beta` | At least one is required. |
| `feedUrl` | Absolute **https** URL. Required. |
| `allowedOrigins` | Non-empty, no duplicates. Each entry is a bare `host` or `host:port`, lowercase. The feed's own host must appear. |
| `trustedKeys` | Zero or more 64-hex-character (32-byte) Ed25519 public keys. **An empty list disables delivery for that channel** — the config still loads, so the UI can explain *why* rather than reporting a generic missing feed. |

`allowedOrigins` matching is **exact**, including an explicit port. It is not a
suffix or wildcard match, so `example.com` does not authorize
`evil-example.com` or `example.com.evil.test`. `*` is rejected outright.

## Manifest format

The feed serves:

```json
{
  "version": "0.1.8",
  "url": "https://updates.example.com/stable/DeepSeek-Harness-Setup-0.1.8.exe",
  "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "signature": "fca5cf4ad52c06fdabe188534338a6c36940b0def732efd82681451cddfe71e6bb8d5a17670a8326debc256e8affd72a91cce784dc462afbc096cb5e3bdb7b0e"
}
```

- `version` must be valid SemVer 2.0.0 and strictly greater than the installed
  version.
- `sha256` is **required** and is the lowercase hex SHA-256 of the artifact.
- `signature` is **required** and is the lowercase hex Ed25519 signature (64
  bytes).
- `url` must be https and on an allow-listed origin. A manifest cannot widen the
  allow list.

## Signing contract

The signature covers this exact byte string, with `sha256` lowercased:

```
dsh-desktop-release/v1
version={version}
channel={channel}
sha256={sha256}
```

Every field ends with `\n`, including the last. The artifact **URL is
deliberately excluded**, so an operator may move mirrors without re-signing; the
host is still constrained by `allowedOrigins`, not by the signature.

Because `version` and `channel` are inside the signed message, a signature
cannot be replayed onto a different version, across channels, or onto different
artifact bytes. All three bindings are asserted by tests in
`update_security.rs`.

## Generating keys and signatures

Verification is implemented in-tree (RFC 8032 Ed25519 over the reference
formulation) because the workspace has no network-fetched crypto crate
available. Verification is checked against the RFC 8032 §7.1 published vectors
and against fixtures produced by an independent implementation
(`cryptography`/`pynacl`), so a bug in the local arithmetic cannot certify
itself.

Signing is **not** implemented in-tree. Sign releases with any RFC 8032
Ed25519 tool over the canonical message above. `app/tests/fixtures/` contains
the generator used for the test fixtures:

```
python port/src-tauri/app/tests/fixtures/generate-update-signatures.py
```

**Never commit a private signing key.** Only public keys belong in
`updates.json`.

## Qualification-only configuration

`qualification/updates.test.json` is an example for isolated local testing. It
uses the RFC 8032 §7.1 TEST 2 public key, whose private key is published in the
RFC, so it proves nothing about provenance and **must never ship**. Real builds
must generate their own key pair and keep the private half outside the
repository.
