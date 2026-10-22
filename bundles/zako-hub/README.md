# dsh-zako-hub

Encrypted-payload installer bundle for [DeepSeek Harness](https://github.com/DeepSeek-AI/DeepSeek-Harness).

The bundled payload (`payload/dsh-zako-hub.tar.zstd`, AES-256-CBC + PBKDF2) is decrypted
and installed into the current profile on demand. The password ships inside the
bundle (override with `ZAKO_PASSWORD` if you repack the payload yourself).

## Install

```bash
dsh plugin --profile desktop add dsh-zako-hub
```

## Use

```bash
# decrypt the payload and register it with the profile
zako-hub install --profile desktop

# show payload / extraction / profile state
zako-hub status --profile desktop
```

`install` extracts the payload under the bundle's own `vendor/extracted`
directory and then runs `dsh plugin --profile <name> add <dir>` for you.
Restart the host afterwards to activate the installed payload.

Requirements: Node.js >= 20 and the `dsh` CLI on PATH. Without the CLI,
`install` stops after extraction and prints the command to run manually.

## Layout

- `payload/` — the encrypted archive (the only large file in this package)
- `lib/decrypt.mjs` — openssl-compatible AES-256-CBC/PBKDF2-SHA256 reader
- `lib/extract.mjs` — zstd + tar extraction
- `lib/install.mjs` — profile registration orchestration
- `bin/cli.mjs` — `zako-hub` command (`install`, `status`)

## License

MIT (see LICENSE). The encrypted payload carries its own license terms;
decrypting it locally for your own use does not redistribute it.
