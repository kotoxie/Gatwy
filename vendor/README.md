# IronRDP browser backend

This npm tarball is a build of [Devolutions/IronRDP at `da016ce860040c6cb37943cfc857d836735d252c`](https://github.com/Devolutions/IronRDP/tree/da016ce860040c6cb37943cfc857d836735d252c). It uses the upstream Cargo lockfile (SSPI `0.23.1`) so CredSSP retains the full UPN or Microsoft account address. See [SSPI #718](https://github.com/Devolutions/sspi-rs/issues/718) and [IronRDP #2080](https://github.com/Devolutions/IronRDP/pull/2080). Replace this tarball with an official npm release containing the fix when available.

The build uses Rust `1.94.1`, `wasm32-unknown-unknown`, `wasm-bindgen-cli` `0.2.129` and Node `24.11.1`. From the upstream checkout:

```sh
RUSTFLAGS='-Ctarget-feature=+simd128,+bulk-memory --cfg getrandom_backend="wasm_js" -Copt-level=s -Ccodegen-units=1 -Cllvm-args=-enable-dfa-jump-thread' \
  cargo build --locked --release --target wasm32-unknown-unknown -p ironrdp-web
wasm-bindgen --target web --out-dir crates/ironrdp-web/pkg target/wasm32-unknown-unknown/release/ironrdp_web.wasm
```

Apply the Vite URL rewrite from upstream `xtask/src/web.rs`: prepend `import wasmUrl from './ironrdp_web_bg.wasm?url';` to `crates/ironrdp-web/pkg/ironrdp_web.js` and replace `new URL('ironrdp_web_bg.wasm', import.meta.url)` with `wasmUrl`. Then run `npm ci` and `npm run build-alone` under `web-client/iron-remote-desktop-rdp`. In `dist`, include the upstream `LICENSE-APACHE` and `LICENSE-MIT`, append them to `package.json`'s `files`, set the version to `0.7.0-gatwy.1`, and run `npm pack --ignore-scripts`.

SHA-256: `a36ea679f1d326346d9741df99a6f99f7059f0fbd358d083684284838276ade1`.
