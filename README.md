# uWolf — a browser raycaster, served by OpenWrt / uhttpd

A small, dependency-free JavaScript raycaster that reads the **original
Wolfenstein 3D data formats** and renders them in the browser.

To be clear about the division of labour, because the name invites the wrong
idea: **the router does not run the game.** It serves a handful of static files
over `uhttpd` — the JavaScript, and the data files you supply. Every ray is cast
client-side, in the browser on your phone or PC. A BPI-R3 is comical overkill for
the job it actually does here, which is being a file server.

**No game content is shipped.** You supply the data files from a copy you own.
The engine only *interprets* them.

## Data files

Copy these from your registered **Wolfenstein 3D v1.4 (GT/ID/Activision)** into
the page's folder (your uhttpd Wolfenstein root). File names are matched
case-insensitively. The same list applies to **Spear of Destiny** with a `.SOD`
extension instead of `.WL6`; both sets can sit side by side and the menu lets
you choose (see the Spear of Destiny section).

Don't own a copy? Wolfenstein 3D can be bought (around €4.99) e.g. on GOG:
<https://www.gog.com/en/game/wolfenstein_3d> — the `.WL6` and `.SOD` data files are in the
installed game folder.

Required (the game will not start without all three):

- `VSWAP.<WL6|SOD>` — wall textures, sprites and digitized sound effects
- `MAPHEAD.<WL6|SOD>` — map directory / RLEW tag
- `GAMEMAPS.<WL6|SOD>` — the level data

Recommended but optional (only for the original status bar and BJ face; without them a small
built-in HUD is used):

- `VGAGRAPH.<WL6|SOD>` — UI graphics (status bar, face, number/weapon/key icons)
- `VGAHEAD.<WL6|SOD>` — chunk offsets into `VGAGRAPH`
- `VGADICT.<WL6|SOD>` — Huffman dictionary for `VGAGRAPH`

Optional (only for the music):

- `AUDIOHED.<WL6|SOD>` — chunk offsets into `AUDIOT`
- `AUDIOT.<WL6|SOD>` — the FM instruments, the sound effects and the 27 music tracks

With those two files you also get the **FM sound effects** — the pickup, key,
locked-door and player-death sounds. Those were never digitised (they are not in
`VSWAP` at all), so without an OPL2 there was nothing to play but a synthesised
stand-in. They are independent of the **Music** toggle, exactly as the original keeps
its music and sound settings apart.

## What it does

- DDA raycaster with textured walls sampled straight from `VSWAP`
- Original two-tone lighting (light N/S faces, darker E/W faces)
- Sliding doors that open on use / on bump and auto-close
- **Enemies rendered as billboarded, direction-correct sprites** (guards,
  officers, SS, mutants, dogs, bosses, ghosts, dead guards) with the proper
  8-rotation frame chosen relative to your viewpoint
- **Enemy AI and combat** ported from the original game logic: standing and
  patrolling actors, line-of-sight sighting with per-class reaction delay,
  grid-based chase pathing (the real `SelectChaseDir` / `TryWalk` behaviour,
  including opening doors), shooting with the original distance-based hit
  probability and damage, dog melee, pain/death animations, and scoring
- **Player weapons** (knife, pistol, machine gun, chain gun) with ammo,
  hitscan targeting under the crosshair, health, damage flash, and scoring
- **God mode is faithful, including what it does *not* do**: it takes no health, so
  you cannot die and the BJ face — which is picked purely from health — keeps
  grinning. But the hit still registers: `TakeDamage()` skips only the health
  subtraction and still calls `StartDamageFlash()`, so the screen flashes red and you
  can see you are being shot at. (Spear of Destiny has a dedicated god-mode face;
  WL6 has none, so there is nothing to show.)
- **Lives, respawn and game over**, exactly as the original does it: dying
  decrements your lives and restarts the floor, and a respawn costs you the good
  weapons and your spare ammo (back to the pistol and 8 rounds) while the score
  is kept. Lives is decremented *before* the check, so you keep playing while the
  bar shows 0 — the next death after that ends the run on a GAME OVER screen.
- **Scoring as the original counts it**: an extra life every 40,000 points
  (the threshold walks up, so one fat bonus can hand out several), and the
  end-of-floor payout — 500 points per whole second saved against the floor's
  par time, plus 10,000 for each of kill/secret/treasure finished at 100%. The
  par-time tables for both games come from `wl_inter.cpp`; boss and secret floors
  have no par, exactly as in the original.
- **The four Wolfenstein ghosts** (Blinky, Pinky, Clyde, Inky) on the secret
  floor: dog-speed, ambush-flagged, **invulnerable**, and harmful only by touch.
  They count toward the kill total *and* the kill count on spawn, so being unable
  to shoot them never keeps you off 100%.
- **Difficulty levels** (all four skill settings) affecting enemy hitpoints,
  reaction/aim, damage taken, and which actors spawn; plus a **God-mode** toggle.
  Enemy *count* follows the original exactly: the base placements spawn at every
  skill, a second set is added at "Bring 'em on" (medium) and a third at "I am
  Death incarnate" (hard) — so medium has ~2x and hard ~3x the base count.
  "Can I play, Daddy?" and "Don't hurt me" place the *same* enemies; they differ
  only in hitpoints and damage, exactly as in the original.
- **Secret pushwalls and the level elevator.** Press use (Space) against a
  pushable wall to slide it two tiles and reveal the chamber behind it (with the
  secret counted and the push sound); press use against an elevator switch
  (facing east/west) to flip it, play the "level done" jingle and ride to the
  next floor. Player health/ammo/weapons/score carry across floors, and a floor
  intermission shows kill and secret percentages and waits for a key press (or
  tap) to continue.
- Static decorations and pickups rendered as billboarded sprites; solid props
  (barrels, tables, pillars, armour, cages, wells, …) block movement as in the
  original, while bullets and line of sight still pass over them
- **Item pickups**: health (dog food / food / first aid / gibs), ammo clips,
  the machine gun and chain gun, treasure (scored) and the one-up (heal + ammo +
  extra life), and the gold/silver keys. Items that wouldn't help (a medkit at
  full health, a clip at full ammo) are left on the floor, as in the original.
- **Keys and locked doors.** Gold and silver keys are collected and shown on the
  status bar; doors locked to a colour won't open (for you or the enemies) until
  you carry the matching key. Keys are per-floor, as in the original. God mode
  counts as carrying every key, so locked doors never block exploration.
- **Digitized sound effects from your `VSWAP`** (weapons, enemy fire, sighting
  calls, death screams, dog bark/attack, doors), 8-bit mono at 7042 Hz via Web
  Audio
- **FM music**, decoded from your `AUDIOT` and played through an OPL2 (YM3812)
  synthesiser written for this project. Optional: tick **Music** on the menu, and
  supply `AUDIOHED.<WL6|SOD>` + `AUDIOT.<WL6|SOD>`. Each floor gets its own track,
  from the same `songs[]` table the original uses.
- Solid-colour floor/ceiling (as in the original)
- **The original VGAGRAPH status bar and BJ face** (health-driven, with the
  number/weapon/key icons), when you also supply `VGAGRAPH`/`VGAHEAD`/`VGADICT`;
  otherwise a minimal built-in HUD is used
- **Saved games**, stored in the browser's `localStorage` — an autosave written
  on entering each new floor, an F8 quick-save, and three manual slots, all
  listed on the menu with load/overwrite/delete. Entirely client-side; the
  router stores nothing.
- Minimap (off by default — toggle with M or the MAP button). Secret doors you
  haven't opened yet are marked with a **red dot**; the marker disappears once
  you push the wall. This is a comfort feature — the original never showed them.
- Keyboard + mouse on desktop, dual-zone touch controls plus WPN button on
  mobile

## Controls

Desktop: **W/A/S/D** move, **←/→** turn, **Ctrl** fire, **1–4** switch weapon,
**Space** (or **E**) use — open doors, push secret walls, ride the elevator;
**M** toggle map, **F8** quick-save, **F9** quick-load, **Esc** pause and go back to
the menu (a **Resume game** button there picks the run straight back up).

Touch: the left half of the screen is a move stick, the right half drags to
turn, and a quick tap on the left half acts as *use* (doors, pushwalls,
elevator). **WPN** cycles weapons, **MAP** toggles the minimap and **SAVE**
quick-saves.

Tick **Mobile controls** on the menu for on-screen controls: a **D-pad** bottom
left and a **FIRE** button bottom right (hold it down for the automatic weapons).
The pad is laid out like the original's arrow keys — up/down walk, left/right
*turn* — so you never have to swipe the screen to look around; its centre button
is *use* (doors, secret walls, elevator). The pad is one capture surface, so your
thumb can slide from "forward" straight into "turn left" without lifting.

Mobile controls are off on desktop, where they would only cover the view, and on
by default if the browser reports a touch device; either way the choice is
remembered. There is no swipe-to-turn: turning lives on the pad, which is far
less tiring than dragging the screen around.

On the menu, before entering a level, you can set the difficulty and toggle
**God mode**, **Infinite ammo**, and **All weapons**.

## Saved games

Saves live in the browser's `localStorage`, so they work entirely offline and
the router never stores anything — but they are per-browser and per-origin, and
clearing the site data removes them.

- **Autosave** — written whenever you ride the elevator onto a new floor.
- **Quicksave** — **F8** in game (or the **SAVE** button); **F9** loads it back.
- **Slots 1–3** — from the menu: press **MENU** during a game and store the run
  into a slot (or overwrite/delete an existing one). Saves are listed with
  floor, health, score and difficulty.

Slots are **namespaced per data set**, so a Wolfenstein run and a Spear run never
overwrite each other, and a save carries the game it was made in — loading one
into the other game is refused rather than silently producing nonsense.

A save is a JSON snapshot of the run: floor, player position and facing, health,
ammo, weapons, keys, score and lives, plus door states, the pushwalls you have
already opened, the flipped elevator switch, which items you picked up, and where
every enemy stands — including who is already dead and who is hunting you. Only
the *deltas* against a freshly parsed map are stored rather than the level
itself, so a save is a few KB.

One deliberate simplification: an actor's mid-animation frame is not preserved.
On load, enemies resume cleanly as dead, as hunting you, or as originally placed
— an enemy caught mid-shot won't finish that particular shot.

## Console helpers

The page exposes the running game as `window.game`, and a few diagnostics hang
off it. They were written while tracking real bugs and are kept because they make
the next one cheaper to find:

```js
game.dumpSprite(421)          // how a sprite page decodes: column span, colour
                              // histogram, and an ASCII view of the 64x64 result
game.dumpSprite()             // ...for the weapon currently in hand
game.dumpSpritePosts(421, 25) // the RAW post structure and palette indices of a
                              // sprite column, straight out of VSWAP
game.dumpMap()                // the decoded geometry around you as ASCII
game.dumpActors()             // live actors: facing, rotation frame, sprite, state
game.sound.count() / play(i)  // walk the digitised-sound directory
```

Turning is tunable at runtime, since taste varies:

```js
game.turnSpeed   = 1.7        // radians/second at full tilt
game.turnRampMin = 0.15       // fraction of that a fresh tap starts at
game.turnRampRate = 4.0       // how quickly it eases up to full speed
```

Turning eases in rather than snapping to full speed: a short tap moves a fraction
as far as a held key, which is what makes fine aiming possible at 60 fps.

## Layout

```
uWolf/
  index.html        menu (difficulty + God-mode), data loading, HUD
  favicon.ico       16/32/48 px pixel-art wolf head (also favicon.svg)
  favicon.svg
  css/style.css
  js/variants.js    per-dataset tables (Wolfenstein 3D vs. Spear of Destiny)
  js/palette.js     256-colour VGA palette (+ runtime override hook)
  js/wl_formats.js  VSWAP + Carmack/RLEW map parsing, texture/sprite/sound decode
  js/raycaster.js   the renderer
  js/enemies.js     enemy spawn decoding + 8-direction sprite selection
  js/sound.js       Web Audio playback of the VSWAP digitized sounds
  js/opl2.js        a YM3812 (OPL2) FM synthesiser — the one piece of hardware here
  js/music.js       AUDIOHED/AUDIOT parsing, the IMF sequencer, Web Audio output
  js/ai.js          enemy AI, the actor state machine, and player combat
  js/vgagraph.js    VGAGRAPH decoder (Huffman + planar) for the status bar/face
  js/game.js        loop, input, doors, combat wiring, HUD, collision, minimap
  js/main.js        menu / loading glue
```

Optional data files for the original status bar/face: `VGAGRAPH`, `VGAHEAD`,
`VGADICT` (same extension as the rest, `.WL6` or `.SOD`). Copy them next to
`index.html` alongside `VSWAP` / `MAPHEAD` / `GAMEMAPS`. Both data sets may live
in the same folder; the menu then lets you pick which game to load.

## Deploy on OpenWrt (uhttpd)

Serve the whole thing from a mounted disk (USB/NVMe) via its own uhttpd
instance, so you don't touch the router's flash — the data files are ~1–2 MB
each:

```sh
mkdir -p /mnt/data/uWolf      # your USB/NVMe mount
# copy the uWolf/ contents + your <WL6|SOD> data files here, next to index.html:
#   /mnt/data/uWolf/VSWAP.<WL6|SOD>  /mnt/data/uWolf/MAPHEAD.<WL6|SOD>  /mnt/data/uWolf/GAMEMAPS.<WL6|SOD>
#   /mnt/data/uWolf/VGAGRAPH.<WL6|SOD>  /mnt/data/uWolf/VGAHEAD.<WL6|SOD>  /mnt/data/uWolf/VGADICT.<WL6|SOD>
```

Add an instance to `/etc/config/uhttpd`:

```
config uhttpd 'wolf'
    option listen_http '0.0.0.0:8088'
    option home '/mnt/data/uWolf'
    option index_page 'index.html'
    option max_requests '5'
```

```sh
/etc/init.d/uhttpd restart
```

Then browse to `http://<router-ip>:8088/`.

`uhttpd` serves the binary data files as-is; the engine reads them with
`fetch().arrayBuffer()`, so no special MIME configuration is needed. The data
loads automatically from the page's own folder on open; if it isn't found, add
the WL6 files there and press **Retry**.

## Source & credits

This is an original, from-scratch implementation, but its behaviour — the actor
state tables and timings, the AI (sighting, chase pathing, hit/damage formulas),
the VSWAP/map/VGAGRAPH decoders and the exact 256-colour palette — was ported
and verified against the GPL-licensed **Wolf4SDL** source:

- Wolf4SDL (SDL port of Wolfenstein 3D / Spear of Destiny):
  <https://github.com/fabiangreffrath/wolf4sdl>

Wolf4SDL is itself a port of id Software's Wolfenstein 3D source, released by id
Software under the GPL. Huge thanks to both.

This browser port — "uWolf" — was written by Dirk Brenken with **Claude Opus
4.8** (Anthropic).

## Legal

The engine is original code. Wolfenstein 3D and its data files are the property
of their respective rights holders; nothing from the game is included here. Use
only data from a copy you legally own.
