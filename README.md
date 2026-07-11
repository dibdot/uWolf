# uWolf — a raycasting engine for OpenWrt / uhttpd

A small, dependency-free JavaScript raycaster that reads the **original
Wolfenstein 3D data formats** and renders them in the browser. It is meant to
be served as static files by OpenWrt's `uhttpd`. The router only hands out
files — all rendering runs client-side on your phone or PC, so a BPI-R3 is
massive overkill as a file server here.

**No game content is shipped.** You supply the data files from a copy you own.
The engine only *interprets* them.

## Data files

Copy these from your registered **Wolfenstein 3D v1.4 (GT/ID/Activision)** into
the page's folder (your uhttpd Wolfenstein root). File names are matched
case-insensitively.

Don't own a copy? Wolfenstein 3D can be bought (around €4.99) e.g. on GOG:
<https://www.gog.com/en/game/wolfenstein_3d> — the `.WL6` data files are in the
installed game folder.

Required (the game will not start without all three):

- `VSWAP.WL6` — wall textures, sprites and digitized sound effects
- `MAPHEAD.WL6` — map directory / RLEW tag
- `GAMEMAPS.WL6` — the level data

Recommended but optional (only for the original status bar and BJ face; without them a small
built-in HUD is used):

- `VGAGRAPH.WL6` — UI graphics (status bar, face, number/weapon/key icons)
- `VGAHEAD.WL6` — chunk offsets into `VGAGRAPH`
- `VGADICT.WL6` — Huffman dictionary for `VGAGRAPH`

The chunk/sprite numbering is the WL6 layout; other releases (shareware `.WL1`,
Spear of Destiny `.SOD`, …) are not supported.

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
- **Lives, respawn and game over**, exactly as the original does it: dying
  decrements your lives and restarts the floor, and a respawn costs you the good
  weapons and your spare ammo (back to the pistol and 8 rounds) while the score
  is kept. Lives is decremented *before* the check, so you keep playing while the
  bar shows 0 — the next death after that ends the run on a GAME OVER screen.
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
- Solid-colour floor/ceiling (as in the original)
- **The original VGAGRAPH status bar and BJ face** (health-driven, with the
  number/weapon/key icons), when you also supply `VGAGRAPH`/`VGAHEAD`/`VGADICT`;
  otherwise a minimal built-in HUD is used
- **Saved games**, stored in the browser's `localStorage` — an autosave written
  on entering each new floor, an F8 quick-save, and three manual slots, all
  listed on the menu with load/overwrite/delete. Entirely client-side; the
  router stores nothing.
- Minimap (off by default — toggle with M or the MAP button)
- Keyboard + mouse on desktop, dual-zone touch controls plus WPN button on
  mobile
- Adjustable internal render resolution for weaker devices

## Controls

Desktop: **W/A/S/D** move, **←/→** turn, **Ctrl** fire, **1–4** switch weapon,
**Space** (or **E**) use — open doors, push secret walls, ride the elevator;
**M** toggle map, **F8** quick-save, **F9** quick-load, **Esc** back to the menu.

Touch: the left half of the screen is a move stick, the right half drags to
turn, and a quick tap on the left half acts as *use* (doors, pushwalls,
elevator). **WPN** cycles weapons, **MAP** toggles the minimap and **SAVE**
quick-saves. Firing is currently keyboard-only (**Ctrl**).

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

A save is a JSON snapshot of the run: floor, player position and facing, health,
ammo, weapons, keys, score and lives, plus door states, the pushwalls you have
already opened, the flipped elevator switch, which items you picked up, and where
every enemy stands — including who is already dead and who is hunting you. Only
the *deltas* against a freshly parsed map are stored rather than the level
itself, so a save is a few KB.

One deliberate simplification: an actor's mid-animation frame is not preserved.
On load, enemies resume cleanly as dead, as hunting you, or as originally placed
— an enemy caught mid-shot won't finish that particular shot.

## What it does NOT do (yet)

Still out of scope: Adlib/IMF music (`AUDIOT`/`AUDIOHED`, which needs an OPL2
emulator). The pickup and locked-door sounds are Adlib in the original (not in
VSWAP's digitized bank), so they are short **synthesized** Web Audio tones here —
distinct blips for health, ammo, weapons, treasure, keys and the one-up, plus a
low buzz for a locked door — pending a real OPL2/AUDIOT path. Combat, enemy and
door sounds still use the genuine digitized samples from your VSWAP.

The status bar, BJ face and UI icons are read from `VGAGRAPH`/`VGAHEAD`/`VGADICT`
if present. Those three are optional — without them the engine falls back to a
small built-in HUD. The graphics-chunk numbers used are the WL6 layout; only the registered
WL6 data set is targeted.

### Combat: what is faithful vs. simplified

Faithful to the Wolf4SDL source: the actor state tables (frames and 70 Hz
timings), sighting and per-class reaction times, `SelectChaseDir`/`TryWalk`/
`MoveObj` grid movement, the `T_Shoot` hit-probability and damage formulas,
`DamageActor`/`KillActor` (including the double-damage surprise bonus and
per-difficulty hitpoints), and the player `GunAttack`/`KnifeAttack` damage
tables and baby-mode damage discount. Patrolling guards follow the map's
scripted routes: the invisible turn-arrow tiles (`ICONARROWS`, plane-1 codes
90–97) steer them exactly as `SelectPathDir` does, so they walk the loops the
level designers laid out — opening doors along the way — instead of wandering.

Deliberately simplified (and easy to extend later):

- **Activation is approximated by line of sight plus a one-hop gunfire noise.**
  A shot floods the current room and any room exactly ONE open doorway away
  (closed doors and walls block it, and a second door is never crossed), so it
  alerts immediate neighbours without cascading across the level. Actors also
  wake on line of sight. (The original instead flood-fills connected map
  "areas", which are opened up door by door as you play.)
- **Line-of-sight treats a door as see-through once it is roughly half open**,
  rather than testing the exact door-slab intercept.
- **Bosses use a generic ranged chase** (correct frames, hitpoints and sounds)
  rather than each boss's unique attack pattern.

The player's POV weapon (knife / pistol / machine gun / chain gun) **is** drawn,
using the ready/attack frames straight from your `VSWAP` sprite pages. The
sprite-page numbering is the registered WL6 layout, like the rest of the actor
sprites here.

## Layout

```
uWolf/
  index.html        menu (difficulty + God-mode), data loading, HUD
  favicon.ico       16/32/48 px pixel-art wolf head (also favicon.svg)
  favicon.svg
  css/style.css
  js/palette.js     256-colour VGA palette (+ runtime override hook)
  js/wl_formats.js  VSWAP + Carmack/RLEW map parsing, texture/sprite/sound decode
  js/raycaster.js   the renderer
  js/enemies.js     enemy spawn decoding + 8-direction sprite selection
  js/sound.js       Web Audio playback of the VSWAP digitized sounds
  js/ai.js          enemy AI, the actor state machine, and player combat
  js/vgagraph.js    VGAGRAPH decoder (Huffman + planar) for the status bar/face
  js/game.js        loop, input, doors, combat wiring, HUD, collision, minimap
  js/main.js        menu / loading glue
```

Optional data files for the original status bar/face: `VGAGRAPH`, `VGAHEAD`,
`VGADICT` (same variant as the rest, e.g. `.WL6`). Copy them next to
`index.html` alongside VSWAP.WL6 / MAPHEAD.WL6 / GAMEMAPS.WL6.

## Deploy on OpenWrt (uhttpd)

Serve the whole thing from a mounted disk (USB/NVMe) via its own uhttpd
instance, so you don't touch the router's flash — the data files are ~1–2 MB
each:

```sh
mkdir -p /mnt/data/uWolf      # your USB/NVMe mount
# copy the uWolf/ contents + your WL6 data files here, next to index.html:
#   /mnt/data/uWolf/VSWAP.WL6  /mnt/data/uWolf/MAPHEAD.WL6  /mnt/data/uWolf/GAMEMAPS.WL6
#   /mnt/data/uWolf/VGAGRAPH.WL6  /mnt/data/uWolf/VGAHEAD.WL6  /mnt/data/uWolf/VGADICT.WL6
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

## Sound

Browsers only start audio after a user interaction, so the first key press or
touch unlocks it. Door open/close and enemy-approach sounds then play from your
`VSWAP`'s digitized-sound bank. To audit the whole bank against your data, the
running game exposes the manager: after clicking into the game once, open the
console and sweep them by index, e.g. `game.sound.count()` and
`game.sound.play(0)` (0 = "Halt!", 2/3 = door close/open — see `sound.js`
`DIGI` for the WL6 names). Note these are the *digitized* effects; the Adlib
music and Adlib-only cues arrive with the `AUDIOT` step.

## Palette

The palette lives in `js/palette.js`. If some colours look wrong for your data,
set `window.WOLF_PALETTE_OVERRIDE` (256 `[r,g,b]` triples or a flat 768-int
array) before the scripts load, or paste the byte-exact table from the GPL'd
Wolf4SDL/ECWolf `gamepal.inc`.

## Tuning

- `game.renderScale` (default `1.0`) — internal resolution vs. CSS size. Lower
  is faster on phones; raise toward `1.0` on a desktop.
- `raycaster.depthShade` — optional distance darkening on top of the two-tone
  lighting (off by default for an authentic look).
- `raycaster.ceilColor` / `floorColor` — per-taste, or wire up the original
  per-level ceiling table if you want.

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
