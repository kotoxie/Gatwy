## 🚀 What's New in 1.2.3

### ✨ Features
- ⚠️ **Warning before connecting to a host that is already in use** (#94), thanks to @aetasoul.

### 🔒 Security
- Recording chunk upload and finalize are now **owner-only**. Owners can no longer rewrite recordings or foreign file-session events (#96, @aetasoul).
- The RDP file-transfer audit endpoint is now **validated and authorized** (#102, @aetasoul).
- The RDP recording path is now derived from the validated session id.
- Session and backup import routes are now rate-limited.

### 🐛 Fixes
- The admin disconnect reason is now shown on session error (#93, @aetasoul).
- Hidden RDP tabs now ignore keyboard input, paste and file drops (#100, @aetasoul).
- The page now asks for confirmation before closing while a terminal session is live, and reload shortcuts no longer trigger the prompt (#101, @aetasoul).
- Fixed clipped descenders in file manager filenames.

### 🔧 Other
- Updated moonlight-web-stream to v3.0.0.
- Dependency updates: nodemailer 10.1.4, body-parser 2.4.0, vite 8.2.4.

### 🙌 Contributors
@aetasoul, @kotoxie
