"""Generate Ed25519 release-signature fixtures for the desktop updater tests.

Uses the independent `cryptography` implementation to sign the exact canonical
message the Rust verifier reconstructs, then emits the fixtures as JSON next to
the Rust tests. Never used at runtime; run only to (re)record fixtures.
"""

import json
import pathlib
import sys

from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

OUT = pathlib.Path(__file__).resolve().parent / "update-signatures.json"

# Deterministic seeds keep the fixture reproducible without storing secret keys
# anywhere in the repository.
SEEDS = {
    "stable": bytes(range(1, 33)),
    "beta": bytes(range(201, 233)),
}


def public_hex(private: Ed25519PrivateKey) -> str:
    from cryptography.hazmat.primitives import serialization

    raw = private.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return raw.hex()


def message(version: str, channel: str, sha256: str) -> bytes:
    return (
        "dsh-desktop-release/v1\n"
        f"version={version}\n"
        f"channel={channel}\n"
        f"sha256={sha256.lower()}\n"
    ).encode("utf-8")


def main() -> int:
    import hashlib

    payload = b"dsh-desktop-update-fixture-payload"
    digest = hashlib.sha256(payload).hexdigest()

    fixtures = {"payloadSha256": digest, "cases": []}
    for channel, seed in SEEDS.items():
        private = Ed25519PrivateKey.from_private_bytes(seed)
        key = public_hex(private)
        for label, version, message_channel, message_digest in (
            ("valid", "0.1.8", channel, digest),
            ("other-version", "0.1.9", channel, digest),
            ("other-channel", "0.1.8", "beta" if channel == "stable" else "stable", digest),
            ("other-digest", "0.1.8", channel, hashlib.sha256(b"other").hexdigest()),
        ):
            signed = message(version, message_channel, message_digest)
            signature = private.sign(signed).hex()
            fixtures["cases"].append(
                {
                    "label": label,
                    "channel": channel,
                    "trustedKey": key,
                    "version": version,
                    "messageChannel": message_channel,
                    "messageSha256": message_digest,
                    "signature": signature,
                    # A signature is cryptographically valid for exactly the
                    # values it signed. The "valid" case signs the tuple the
                    # release must carry; every other case signs different
                    # values, so presenting it with the real release (asserted
                    # in Rust by the binding tests) must fail. Recording
                    # "valid-over-signed-values" states that plainly instead of
                    # implying the bytes are corrupt.
                    "expected": "ok" if label == "valid" else "valid-over-signed-values",
                }
            )

    OUT.write_text(json.dumps(fixtures, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUT} ({len(fixtures['cases'])} cases)")
    # Cross-check the independent implementation against an RFC 8032 vector so a
    # broken local library cannot silently record wrong fixtures.
    rfc_key = bytes.fromhex(
        "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c"
    )
    rfc_sig = bytes.fromhex(
        "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da"
        "085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"
    )
    Ed25519PublicKey.from_public_bytes(rfc_key).verify(rfc_sig, bytes([0x72]))
    print("independent implementation reproduces RFC 8032 TEST 2")
    return 0


if __name__ == "__main__":
    sys.exit(main())
