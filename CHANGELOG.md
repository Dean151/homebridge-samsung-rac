# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `hideOutdoorTemperatureWhenOff`, off by default: some units keep publishing an
  outdoor figure with the compressor stopped, and it is not one the sensor took
  — it drifts towards the room's temperature. With this on, the outdoor tile
  reads "No Response" while the unit is off instead of showing a number nothing
  measured, and goes live again the moment it starts. It stays off by default
  because a unit that reads correctly when idle should keep reporting, and
  nothing a unit publishes says which kind it is. The air conditioner's own room
  temperature is deliberately left alone: a "No Response" there would take the
  whole tile with it, and with it any way to switch the unit back on.

- Switches can be named. An entry in `convenienceModes` or `modeSwitches` can
  now be `{ "mode": "Quiet", "name": "WindFree" }` rather than a bare `"Quiet"`,
  and the name is used exactly as written — no air conditioner name in front of
  it. Which convenience mode a unit calls WindFree is stated nowhere, so the one
  that turns out to be it can finally say so. An entry without a name keeps the
  derived `<air conditioner> <mode>`, which is what tells two units' Quiet
  switches apart.

  The switch's HomeKit identity is still built from the mode, not the name, so
  naming one leaves the automations pointing at it alone, and a switch already
  published under the derived name is renamed in place rather than published
  again. A rename made in the Home app continues to win over both.

  Bare mode names are still read and still mean what they meant, and opening
  the plugin settings rewrites an old list into the new shape.

- `freezeIndoorTemperatureWhenOff`, off by default: the same unreliability on
  the unit's own room sensor, which some units report oddly with the fan
  stopped. The air conditioner tile then holds the last temperature read while
  the unit was running until it starts again. It holds a reading rather than
  reading "No Response" like the outdoor sensor because HomeKit requires a room
  temperature on a HeaterCooler — an error there greys out the whole tile, and
  with it the switch that turns the unit back on. The held value lives in the
  cached accessory, so a Homebridge restarted while the unit is off keeps it.

### Fixed

- Switching one convenience mode on left the previous one reading on for the
  second and a half it took to write the change and read it back. The switches
  have always been one group backed by one field, so two could never both be
  on for real — but the Home app showed it that way until the unit answered.
  The rest of the group now goes off as the write leaves, and the read-back
  still has the last word if the unit refuses the change.

- Switching off a mode switch that was already off sent `Comode_Off` to the
  unit anyway. A scene that turns a whole group off sends one write per switch,
  so a scene could cancel the very mode a later switch in it had just set.
  Switching off something that is not on now sends nothing.

## [0.3.1] - 2026-09-15

### Fixed

- Every switch, and the filter and outdoor sensor with them, showed up in the
  Home app under the air conditioner's own name — two convenience-mode switches
  on one unit both read "Climatiseur" and nothing said which was which. The
  plugin was setting each service's `Name`, which the Home app does not use for
  this; it reads `ConfiguredName`, which is now set for every service the
  accessory carries.

  `ConfiguredName` is writable, so renaming a tile in the Home app reaches the
  plugin as a write. That name is kept in the accessory's context and used from
  then on, instead of being overwritten by the plugin's own on the next restart.

## [0.3.0] - 2026-09-15

### Added

- The filter's remaining life, next to the alarm that was already there. The
  unit counts the filter's running time in tenths of an hour (`FilterTime`) and
  states the cleaning threshold in whole hours (`FilterAlarmTime`) — two
  adjacent values in the same array, in two different units, neither of them
  labelled, confirmed against the Samsung app's own filter screen. The
  threshold is a user setting in that app (180, 300, 500 or 700 hours), so it
  is read from the unit rather than assumed, and a filter past it reads as 0%
  rather than as a negative.

- Switches for the modes HomeKit's air conditioner tile has no room for, each
  off by default and added by naming it in the config:

  - `convenienceModes` publishes a switch per `Comode` value — the convenience
    modes, the family WindFree belongs to. The unit runs one at a time, so the
    switches are one group backed by one field: turning Quiet on turns Comfort
    off, including when the change was made on the remote.
  - `modeSwitches` publishes a switch for `Dry` and `Wind`, which until now
    could only be set from the Samsung app. Switching one off returns the unit
    to the mode it was in before.

  Neither list defaults to anything, deliberately: the unit reports the value
  each field holds but never the values it would accept, so there is nothing to
  detect from, and a switch for a name a given model does not know would refuse
  to stay on. The Homebridge UI offers the six names a TP6X_RAC_16K applies.

- `probe writes` now also searches `Mode.options` — `Comode` (the unit's
  convenience mode), `Autoclean` and `Sleep`. Neither the body shape for those
  keys nor the names they take is documented anywhere, so the probe tries three
  shapes and eight names and reports what each one did, restoring whatever it
  changed through the shape that worked.

  On the reference unit this settled both: writes land as a single entry,
  `{"Mode":{"options":["Comode_Quiet"]}}`, and `Comode` accepts `Comfort`,
  `Quiet`, `Speed`, `Smart`, `2Step` and `Sleep` while ignoring `WindFree` and
  `SoftCool`. `Autoclean` applies; the `Sleep` timer does not. The switches
  above are built on what that run settled; `Autoclean` is writable and has no
  switch yet.

### Fixed

- `devices[].heating` never appeared in the Homebridge UI. It has been in the
  config schema since 0.2.0, but the form's layout listed the fields around it
  and not that one, so the only way to set it was by hand in `config.json`.

- `probe writes` left the unit in whatever state it had probed it into, rather
  than restoring it, whenever the unit had been **on** when the run started. The
  matrix ends by flipping power, so by the time the restores ran the unit was
  off — and this hardware accepts and discards every write except power while it
  is off. The restore step decided whether to power the unit back on from the
  state it had captured at the start of the run instead of the state the unit
  was in, so it skipped that step in exactly the case that needed it.

### Changed

- The outdoor sensor can now be published as an accessory of its own, so it can
  be assigned to a different room from the air conditioner — HomeKit gives a
  room to a whole accessory, so until now the sensor was stuck in the room of
  the unit it hangs off. `outdoorTemperature` now says where the sensor goes —
  `linked` (the default, the previous behaviour), `separate` or `off` — and the
  scale it reports in moved to its own setting, `outdoorTemperatureUnit`.

  Configs written before this keep working unchanged: `outdoorTemperature` still
  accepts `fahrenheit` and `celsius`, and such a config shows the sensor on the
  air conditioner in the scale it names, exactly as it did. The settings UI
  splits the old value across the two fields when you open it.

## [0.2.0] - 2026-09-15

### Fixed

- Heat was missing from the Home app on units that support it. The plugin built
  its mode list from `Mode.supportedModes`, which the firmware under-reports:
  the reference unit returns `modes: ["Heat"]` and
  `supportedModes: ["Cool","Dry","Wind","Auto"]` in the *same* document while it
  is actively heating, and applies a write of `Heat` confirmed by read-back.
  Heat support is now taken from the unit's rated heating capacity
  (`WarmCapa` in `Mode.options`) when the advertised list omits it, and
  `devices[].heating` overrides both.

- A unit configured in Fahrenheit had its temperatures passed to HomeKit as
  though they were Celsius, so a room at 71 °F read as 71 °C and every setpoint
  written to it was wrong by the same margin. Temperatures are now converted at
  the transport boundary, and such a unit is given half-degree Celsius steps,
  since a whole degree Fahrenheit is 0.56 °C and a 1 °C step would put half its
  setpoints out of reach. Celsius units are unaffected.

- A failure while discovering devices could take the whole Homebridge process
  down with it, and one unit failing to set up its accessory aborted the units
  after it. Discovery now catches, and each unit is set up on its own.

### Added

- `devices[].heating`, to force heat support on or off for a unit whose own
  signals are wrong. It defaults to `auto`, which is right for every unit seen
  so far and needs no configuration.

- The unit's outdoor temperature sensor, as a tile of its own, from the
  `OutdoorTemp` entry in `Mode.options`. Which scale that is in is stated nowhere
  and is independent of the unit's own setting — the reference unit reports
  itself in Celsius and this in Fahrenheit, in one document, with only the former
  labelled — so Fahrenheit is the default, confirmed against a known outdoor
  temperature, and `outdoorTemperature` switches it to `celsius` or `off`.
  A value that cannot be a temperature is discarded rather than published, since
  `Mode.options` is a grab-bag of unrelated counters.

- A debug-level trace of what actually crosses the wire: every request, the raw
  device document once per start, and, on each poll, only the values that
  changed — so the log reads as a history of what the unit did, including
  changes made from the remote or the Samsung app, without a line per poll.

- A warning when a unit stops answering, once per outage rather than once per
  poll, and a line at normal volume when it answers again. A unit that dropped
  out overnight is worth seeing without having turned debug on first.

## [0.1.1] - 2026-09-15

### Fixed

- The plugin settings screen showed no form on a fresh install, so there was no
  field to type an air conditioner's IP address into — and no way out of that,
  since entering one is what would have created the config block the Homebridge
  UI requires before it renders the form. An empty block is now seeded before the
  form is shown; nothing is written to `config.json` until you save.
- The "Re-fetch certificate" button used a Font Awesome 5 icon name and rendered
  as a missing-glyph box.

## [0.1.0] - 2026-09-14

Initial release. Controls a Samsung room air conditioner from HomeKit over its
local network API (`https://<ip>:8888`, mutual TLS) rather than the SmartThings
cloud, which is what makes the vane/swing control reachable at all.

### Added

- A `HeaterCooler` accessory per unit: power, current temperature, target
  temperature over the range the unit reports, the modes it says it supports, fan
  speed, swing, and a linked filter indicator. A service appears once the unit has
  published a reading for it and is never withdrawn afterwards, so a restart while
  the AC is off cannot hide a control permanently.
- Certificate download, device listing and pairing from the Homebridge UI.
  Pairing needs the unit powered off, then on when prompted — the air conditioner
  does not hand out a token on request, it calls back on port 8889 at power-on.
- Credentials are kept out of `config.json`: the Samsung client certificate is
  downloaded at setup time and device tokens are written `0600` beside it, under
  the Homebridge storage path.
- A `homebridge-samsung-rac-probe` CLI (`pair`, `dump`, `writes`) for the cases
  the UI cannot reach, such as Homebridge in a container without host networking.

### Known limitations

- Developed against one model, a `TP6X_RAC_16K`. Others of the same generation
  should work; the older port-2878 units will not.
- Accepted vane values are model-specific. On the reference unit only
  `Up_And_Low` works. Configurable, and the log says when the unit refuses the
  value you picked.
- The hardware discards every write except power while the unit is off, so
  changes made in the Home app then do nothing and the tile snaps back.
- Dry and fan-only modes are not exposed; HomeKit has no equivalent, so they
  report as Auto/Idle and are left alone.

[0.3.1]: https://github.com/Dean151/homebridge-samsung-rac/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Dean151/homebridge-samsung-rac/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Dean151/homebridge-samsung-rac/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Dean151/homebridge-samsung-rac/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Dean151/homebridge-samsung-rac/releases/tag/v0.1.0
