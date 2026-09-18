# VNC touch mode milestones

Working notes for `feat/vnc-touch-mode`. Rebuild from this branch, then hard-refresh the iPad after each image.

## Current baseline

**Last known-good cursor:** `f853b55` / `b349aad` (remote cursor visible, no extra overlay pointer).

**Freeze fix (confirmed):** `a7182a3` — each tap is one left click; `window` `mouseup` after click so noVNC `setCapture()` releases. Do **not** remove `#noVNC_mouse_capture_elem`.

**Window drag (confirmed):** `602f829` — long-press then drag, or tap then drag, holds left button.

**Right-click polish (confirmed by user):** `a834729` — Moonlight-style two-finger tap. Aim with one finger, plant a second finger. Do **not** move the remote cursor for the second finger.

**Two-finger scroll:** `33644d7` locked the cursor (better, still a little wander on leftover finger). Speed was slow in **both** modes because noVNC only emits one wheel notch per `wheel` event and only after 50px of delta — leftover pixels are discarded.

**Scroll speed:** `ff4c729` helped touchscreen more than touchpad. Touchpad still lost the leftover finger to cursor-move, which jumped the pointer to the top of the screen.

**Touchpad leftover-finger (confirmed):** `20405fd` — leftover finger stays in scroll; cursor no longer jumps to the top.

**Desktop vs touch UI:** Gate Touch Input and overlays with `useIsCoarsePointer()` / `isCoarsePointer()` — `(hover: none) and (pointer: coarse)` — same as Sidebar edit/delete. Desktop and hover-capable hybrids never mount overlays. Phones/tablets keep the toggle. Stored touchscreen vs touchpad preference is unchanged. VNC mobile keyboard uses the same hook. Touchpad overlay cleanup sends mouseup so switching to Touchscreen mid-drag does not stick LMB.

Keep:

- Extra overlay cursor gone
- Remote VNC cursor visible and usable
- One-finger move / tap / hold-drag / freeze-free double-tap
- Two-finger tap right-click without moving the cursor

Do not reintroduce:

- Calls into minified noVNC internals (`_handleMouseMove`, `_handleMouseButton`, `_cursor.move`)
- A second local SVG cursor overlay
- Removing `#noVNC_mouse_capture_elem` as the primary cursor strategy

## Checklist

### Done

- [x] Touchscreen vs Touchpad toggle in the VNC sidebar while a session is running
- [x] Touchpad: one-finger drag moves the remote pointer
- [x] Touchpad: tap = left click
- [x] Touchpad: two-finger drag = scroll
- [x] Extra overlay cursor removed (only the remote VNC cursor)
- [x] Cursor visible and usable after extra-cursor removal (`f853b55` / `b349aad`)
- [x] Double-tap on iPad does not freeze (`a7182a3`)
- [x] Double-tap = left click, cursor still visible (`a7182a3`)
- [x] Touchpad: drag a Steam Deck / KDE window (`602f829`)
- [x] Right-click: aim with one finger, tap a second finger, cursor stays on the folder (`a834729`)
- [x] Touchpad two-finger scroll does not jump the cursor to the top (`20405fd`)

### In test

- [ ] Desktop sidebar has no Touch section; mouse still works
- [ ] iPad / phone / tablet still show Touchscreen / Touchpad
- [ ] Saved touchpad mode on iPad does not overlay a later desktop session

## What we already learned

| Attempt | Result |
| --- | --- |
| Extra SVG cursor on the overlay | Two cursors (one dummy, one real). Dummy sat above the real one. |
| Remove overlay cursor, send canvas `MouseEvent`s (`64df2e9` / `f853b55`) | **Cursor works.** Double-tap on a link still freezes. |
| Drive RFB private methods instead of DOM events (`6b83433`) | Cursor gone. Clicks unreliable. Built JS names do not match source internals. |
| Draw a local cursor again + strip capture overlay (`1c345d1`, `29fb141`) | Cursor missing, or only flashes after long-press drag, then vanishes. |
| Extra click on second tap (`f853b55` double-click path) | Freeze; a later single tap unfreezes (matches stuck `setCapture()`). |
| Window `mouseup` after each canvas click (`a7182a3`) | **Freeze gone.** Cursor still visible. |
| Long-press then drag / tap then drag (`602f829`) | **Window drag works.** |
| Two-finger tap moved the cursor (midpoint / first-finger jitter) | Right-click missed the folder. Moonlight iOS `RelativeTouchHandler` only moves on finger 1; two-finger tap clicks **where the cursor already is**. |
| Two-finger scroll (`a834729`) | Page scrolled slowly **and** the leftover finger moved the cursor off-screen (Safari often reports 1 touch mid-scroll). |
| Cursor lock (`33644d7`) | Wander reduced. Still slow: noVNC `WHEEL_STEP` is 50px and leftover delta is thrown away. |
| Extra wheel notches + touchscreen intercept (`ff4c729`) | Touchscreen faster. Touchpad still slower; leftover finger jumped cursor to top of screen. |
| Leftover-finger stays in scroll / ignore 1-finger start while locked (`20405fd`) | **Cursor stays put.** Scroll usable. |
| Hide Touch UI unless `(pointer: coarse)` (`f9e5f53`) | Desktop hid Touch; hybrid coarse+hover could still disagree with Sidebar. |
| Gate Touch Input with `useIsCoarsePointer()` / `COARSE_NO_HOVER` | TBD. |
| Hide noVNC iOS fallback cursor (`820ba30`) | **Cursor vanished.** Reverted. Remote framebuffer pointer is the only cursor; do not hide noVNC sprites. |
| Unmount mouseup only while dragging (redo of LMB nit) | TBD — must not hide/misalign cursor. |

## Moonlight (iOS relative / trackpad) — what we copied

From `moonlight-ios` `RelativeTouchHandler.m` and `moonlight-qt` `reltouch.cpp`:

- Only the **primary finger** moves the mouse.
- Two-finger tap = right-click at the **current** pointer. Second finger does not aim.
- Tiny move deadzone (~5px) so a tap is not a drag.
- Going 2 fingers → 1 marks the remaining finger as moved so it does not left-click.
- Two-finger **drag** (after leaving the deadzone) is scroll, not a tap.

## Gestures (touchpad)

| Gesture | Action |
| --- | --- |
| One-finger move | Move remote cursor (button up). Small deadzone so a tap does not nudge. |
| Tap | Left click |
| Double-tap | Two left clicks (not a freeze) |
| Long-press (~350ms) then drag | Left button down, drag windows, up on lift |
| Tap, then immediately drag | Same window-drag (tap-and-a-half) |
| Aim, then second-finger tap | Right click **without moving** the cursor |
| Two-finger drag | Scroll only (cursor stays put, including leftover finger until both lift) |

## Next work

1. Confirm a desktop browser has no Touch block and the mouse works.
2. Confirm iPad still has Touchscreen / Touchpad and gestures.
3. Optional: Android phone still shows Touch.

## Test rebuild

```bash
cd /docker/komodo/periphery/stacks/gatwy
docker compose build --no-cache --pull
docker compose up -d --force-recreate
```

Hard-refresh the iPad. Put the cursor on a folder, tap a second finger, lift. The menu should open on that folder.
