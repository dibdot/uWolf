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

Optional (only for the music):

- `AUDIOHED.WL6` — chunk offsets into `AUDIOT`
- `AUDIOT.WL6` — the AdLib instruments, the sound effects and the 27 music tracks

With those two files you also get the **AdLib sound effects** — the pickup, key,
locked-door and player-death sounds. Those were never digitised (they are not in
`VSWAP` at all), so without an OPL2 there was nothing to play but a synthesised
stand-in. They are independent of the **Music** toggle, exactly as the original keeps
its music and sound settings apart.

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
- **AdLib music**, decoded from your `AUDIOT` and played through an OPL2 (YM3812)
  synthesiser written for this project. Optional: tick **Music** on the menu, and
  supply `AUDIOHED.WL6` + `AUDIOT.WL6`. Each floor gets its own track, from the same
  `songs[]` table the original uses.
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
- Adjustable internal render resolution for weaker devices

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

Still out of scope: The pickup and locked-door sounds are Adlib in the original (not in
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
tables and baby-mode damage discount. A body left lying in a doorway props that
door open — dying sets `FL_NONMARK`, so the corpse keeps re-marking its tile and
`CloseDoor()` refuses to close on it, while the walk tests ignore it because it is
no longer shootable. Patrolling guards follow the map's
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
- **Bosses use a generic ranged chase** rather than each boss's unique attack
  pattern. Everything else about them is per-boss and taken from the source:
  frames, sounds (each has his own taunt and death cry), points, the real
  `starthitpoints` (Schabbs has 2400 on hard, Fake Hitler only 500 — they are
  nowhere near each other), and how the floor ends:
  - **Hans** (episode 1) and **Gretel** (episode 5) drop the **gold key**. You unlock
    the door with it and walk out of the castle onto the **exit tile** — which is
    also the only place B.J. ever says anything.
  - **Schabbs**, **Giftmacher** and **Fat Face** end the floor the moment they die
    (`A_StartDeathCam` → `ex_victorious`). Those floors have no elevator at all.
  - **Mecha Hitler** ends nothing: `A_HitlerMorph` puts **Adolf** himself in his
    place — faster than any other boss, a five-shot burst, seven frames to die —
    and only *his* death ends the floor.
  - **Fake Hitler** is none of the above: just a very tough regular enemy.

  The kill itself doesn't end the floor either — the ending hangs off the *last*
  death frame, exactly as `A_StartDeathCam` does, so the boss finishes going down
  before the intermission appears.
- **Sight and death cries are per class**, each mapped to the digi chunk the
  original plays: the guard picks from eight death screams (`US_RndT()%8` — and
  chunk 13 sits in that pool twice, so it genuinely is twice as likely), and every
  boss has one of his own. The mutant is the only enemy that spots you in complete
  silence.

  The sound *names* are id's own identifiers rather than transcriptions, and the two
  don't always line up: `DEATHSCREAM2` and `DEATHSCREAM3` both point at chunk 13, and
  `DEATHSCREAM6` is simply called `FART`. This port uses the identifiers only to pick
  the right chunk — what a given sample actually says is a question for your ears, not
  for the source code. (The samples are 8-bit mono at 7042 Hz and shouted; several of
  them are famously hard to make out.)
- **The secret-floor easter egg is in.** On the secret floor only, every regular
  enemy has a 1-in-256 chance of dying on `DEATHSCREAM6` instead of his usual cry.
  The source's own name for that sound is, and we quote, `FART`. Bosses are
  excluded.
- **Floor progression is per episode**, not a flat +1: ten floors each (eight
  normal, the boss floor, then the secret floor). The elevator takes you to the
  next floor; standing on the *alternate* elevator tile takes you to the secret
  floor instead; leaving the secret floor drops you back at `ElevatorBackTo[]`
  = 1,1,7,3,5,3. Killing the boss — or stepping on the castle **exit tile**
  (plane-1 code 99), which is how the Hans and Gretel floors finish and where
  B.J.'s one and only line comes from — ends the whole **episode**.

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
  js/opl2.js        a YM3812 (OPL2) FM synthesiser — the one piece of hardware here
  js/music.js       AUDIOHED/AUDIOT parsing, the IMF sequencer, Web Audio output
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

## The music

`AUDIOT` contains no notes. It contains *register writes* for the AdLib card's OPL2
chip, in IMF format: four bytes per packet — register, value, and a 16-bit delay in
ticks of a 700 Hz clock. To hear the music you therefore have to *be* the chip, which
is what `js/opl2.js` is: nine channels of two-operator FM synthesis, phase
accumulators feeding a quarter-sine table in the log domain, with envelope, key
scaling and tremolo added as attenuation *in that same log domain* and converted back
through an exp table — which is exactly how the silicon avoids ever multiplying.

It is written from the documented behaviour of the part rather than transcribed from
an existing emulator. That is partly a matter of taste and partly a matter of
licensing: the emulator Wolf4SDL itself uses is MAME's `fmopl.c`, which is explicitly
**not** GPL — it is the one file its own changelog carves out of the GPL relicensing.
If you ever want a reference implementation to compare against, use DOSBox's `dbopl`,
which is GPL.

There is no reference recording to diff against, so `test/test_opl.js` checks the chip
against physics instead: that a key-on makes a sound and a key-off stops it, that the
pitch really is `FNUM * 49716 / 2^(20-BLOCK)`, that raising the block by one doubles
the frequency, that `MULT=2` is an octave, that eight steps of total level halve the
amplitude, that envelopes rise and fall in the right order, that the four waveforms are
chopped up the way the datasheet says, and that nine voices saturate rather than fold
over.

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
