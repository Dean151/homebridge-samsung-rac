# homebridge-samsung-rac

[![CI](https://github.com/Dean151/homebridge-samsung-rac/actions/workflows/ci.yml/badge.svg)](https://github.com/Dean151/homebridge-samsung-rac/actions/workflows/ci.yml)

HomeKit control for a Samsung room air conditioner that stays **entirely on your
own network**. The plugin talks to the unit's own API — `https://<ip>:8888`, mutual
TLS — and, once the one-time certificate download in step 2 below is done, to
nothing else: no SmartThings account, no OAuth token to keep alive, no cloud round
trip between the Home app and the machine in your room. It keeps working when your
internet does not, and it answers in the time a LAN request takes rather than
whatever a cloud API is doing today.

Being local is also what makes the vane work. The unit publishes its vane
position directly as `Wind.direction`, so swing is read and written as a first
class control instead of depending on which capabilities a given model exposes to
the cloud — on the reference unit, the cloud integration could not reach it at all.

Developed against a **TP6X_RAC_16K** (SmartThings vendor id `DA-AC-RAC-100001`).
Other units of the same generation should work; older port-2878 models will not.

Your Homebridge machine has to be on the same network as the air conditioner. If
it is not — or you would rather not pair against the hardware — the cloud route is
[homebridge-samsung-windfree-ac](https://github.com/igorxmath/homebridge-samsung-windfree-ac),
which drives the same class of unit through SmartThings.

## What it exposes

A single `HeaterCooler` accessory per unit:

| HomeKit | Comes from |
|---|---|
| On / off | `Operation.power` |
| Current temperature | `Temperatures[0].current` |
| Target temperature | `Temperatures[0].desired`, with the range the unit reports |
| Mode | `Mode.modes`, plus `WarmCapa` to tell whether the unit can heat |
| Fan speed | `Wind.speedLevel` / `Wind.maxSpeedLevel` |
| Swing | `Wind.direction` |
| Filter indicator | the `FilterAlarm` entry in `Alarms` |
| Filter life | `FilterTime` against `FilterAlarmTime`, as a percentage |
| Outdoor temperature | `Mode.options.OutdoorTemp`, as its own sensor |
| Convenience modes | `Mode.options.Comode`, as switches you ask for |
| Dry and fan-only | `Mode.modes`, as switches you ask for |

Dry and fan-only modes have no HomeKit equivalent. The plugin reports them as
Auto/Idle and leaves them alone rather than overwriting a mode you chose in the
Samsung app — and `modeSwitches` adds a switch for either, which is the only way
to *set* them from the Home app. Switching one off puts the unit back in the
mode it was in before.

The filter tile shows how much life is left as well as whether the alarm has
fired. The unit counts the filter's hours in tenths of an hour and states the
reminder threshold in whole hours — two adjacent values in two different units,
neither labelled — and that threshold is yours to set in the Samsung app (180,
300, 500 or 700 hours), so the plugin reads it rather than assuming it. Resetting
the counter is still done in the Samsung app; the plugin has no way to write it.

**Convenience modes** — the family WindFree belongs to — are switches too, via
`convenienceModes`. The unit keeps one convenience mode at a time, so the
switches behave as one group: turning Quiet on turns Comfort off, including when
the change was made on the remote. They all read off while the air conditioner
is off: the unit goes on reporting the mode it will resume with, but that is a
setting rather than something running.

Neither list has a default, on purpose. The unit reports the mode it is *in* but
never the ones it would accept, so there is nothing to detect from, and a switch
for a name your model does not know would simply refuse to stay on. A
TP6X_RAC_16K applies `Comfort`, `Quiet`, `Speed`, `Smart`, `2Step` and `Sleep`,
confirmed by read-back; `WindFree` and `SoftCool` are not names it knows, so one
of those six is what it calls WindFree. Which one is stated nowhere — try them,
and name the one that turns out to be it.

### Naming the switches

An entry in either list can be a bare mode name or an object carrying the name
to show in the Home app:

```json
"convenienceModes": [
  { "mode": "Quiet", "name": "WindFree" },
  "Comfort"
],
"modeSwitches": [
  { "mode": "Wind", "name": "Ventilation" }
]
```

A name you write is used **exactly as written** — no air conditioner name in
front of it, which is the point of writing one. An entry without a name keeps
the derived `<air conditioner> <mode>`, so `Comfort` above still reads "Living
Room AC Comfort"; that prefix is what tells two units' Quiet switches apart in a
flat list, which is why it is still the default.

`mode` is the unit's own word, and it is what the switch's HomeKit identity is
built from. Renaming a switch therefore never disturbs the automations pointing
at it — and a switch already published under the derived name is renamed in
place rather than published a second time.

A rename made in the Home app still wins over the config, and is kept: it comes
back to the plugin and is stored with the accessory, rather than being undone at
the next restart. So if a switch you have already renamed there ignores the name
you set here, that is why — clear it in the Home app and the config name takes
over.

Both shapes are read, so `"convenienceModes": ["Quiet"]` keeps meaning what it
always did; opening the plugin settings rewrites such a list into the object
form for you.

**Heat is offered even though the unit denies supporting it.** The reference
unit lists `Cool`, `Dry`, `Wind` and `Auto` as its supported modes and leaves
`Heat` out — while sitting in `Heat`, reporting it, and accepting a write of it.
The advertised list is therefore a floor, not a ceiling, so the plugin reads
heat support from the unit's rated heating capacity (`WarmCapa`) instead. If
that guesses wrong for your unit in either direction, `heating` settles it.

A unit set to Fahrenheit is converted to Celsius, which is the only scale
HomeKit accepts — what you see in the Home app is your phone's own display
setting, independent of the unit's. Such a unit is offered half-degree Celsius
steps rather than whole ones, because a whole degree Fahrenheit is 0.56 °C and a
1 °C step would put half of its setpoints out of reach.

The outdoor sensor is a tile of its own rather than part of the air conditioner
control. By default it sits on the air conditioner, which puts it in that unit's
room; `outdoorTemperature: "separate"` gives it an accessory of its own instead,
so the Home app will let you assign it wherever it belongs — an outdoor room, or
the one you actually look at. `off` hides it.

**Which scale it is in is stated nowhere**, and is independent of the unit's own
setting: the reference unit reports itself in Celsius and this in Fahrenheit, in
the same document, with only the former labelled. Fahrenheit is the default for
that reason. If the tile reads far too cold, set `outdoorTemperatureUnit` to
`celsius`.

Some units keep publishing an outdoor figure with the compressor stopped, and it
is not one the sensor took — it drifts towards the room's temperature instead.
`hideOutdoorTemperatureWhenOff: true` makes the tile read "No Response" while the
unit is off rather than show a number nothing measured; it goes live again the
moment the unit starts. Off by default, since a unit that reads correctly when
idle should keep reporting and nothing it publishes says which kind yours is.
Only the outdoor tile is affected — the air conditioner's own room temperature
keeps reporting either way, or the whole tile would go unresponsive and take the
means of switching the unit back on with it.

The room temperature on the air conditioner itself can be unreliable the same way
— some units report it oddly with the fan stopped.
`freezeIndoorTemperatureWhenOff: true` holds the tile at the last temperature
read while the unit was running, until it starts again; the held value is kept
with the cached accessory, so restarting Homebridge while the unit is off does
not lose it. This one holds a reading rather than reading "No Response" because
HomeKit requires a room temperature on the air conditioner: an error there greys
out the whole tile, and with it the switch you would use to turn the unit back
on. The two settings are independent — a unit can be wrong about one sensor and
right about the other.

A service only appears once the unit has actually published a reading for it, and
is never withdrawn afterwards — some units publish nothing until they are running.

## Setup

1. Install the plugin and open its settings in the Homebridge UI.
2. **Fetch the certificate.** The local API requires a client certificate that
   bundles a private key. It is not shipped with this plugin: it is downloaded
   once and stored next to your Homebridge config, on your machine only.
3. **Add your air conditioner's IP address** and save. Reserve its DHCP address,
   or enable UUID-based discovery below to follow address changes. You can add
   several units.
4. **Pair.** This is the awkward part, and the order matters:
   - power the air conditioner **off**
   - press *Start pairing*
   - power it back **on** when the UI asks

   The unit does not hand out a token on request. It calls back to Homebridge on
   port 8889 the moment it powers on, and that callback carries the token.

The token is stored alongside the certificate, outside `config.json`.

### Automatic address discovery

To follow DHCP address changes, add the unit's `deviceUuid` alongside its
current `host`. Use the UUID from its local `/devices` response or the
`deviceUuid` field in its existing pairing record; do not copy the token into
configuration. For example:

```json
{
  "name": "Lounge",
  "host": "192.168.1.50",
  "deviceUuid": "C0970000-0001-0000-0000-000000000000"
}
```

With a UUID configured, `host` is a fallback and unicast discovery hint. The
plugin sends a bounded SSDP search on directly connected private IPv4 networks,
then verifies the UUID returned by the authenticated AC API. Existing pairing
tokens are looked up by UUID without rewriting the credential file. Existing
HomeKit identities and room assignments are retained.

After a connection fails, the next request discovers the unit again. Failed
connection attempts back off for 30 seconds. Units unavailable at Homebridge
startup are retried every 30 seconds; their cached accessories are retained.
Concurrent discovery requests share a scan. An uncertain control command is
never automatically replayed: a later status read reconciles the AC's state.

Discovery requires SSDP traffic between Homebridge and the ACs on the same
subnet. It cannot follow a moved unit if the network blocks discovery. Without
`deviceUuid`, the original fixed-address behavior is unchanged. To pair again,
use the AC's current address in the pairing UI. Status still uses local polling;
SSDP discovers addresses, not changes in temperature or operating state.

### If pairing never completes

The air conditioner connects back to whatever address asked it for a token, so
the callback has to be able to reach Homebridge:

- **Homebridge in Docker without host networking** — the callback cannot arrive.
  Pair from the host with the probe CLI below and paste the token into the
  *Paste token* box:

  ```bash
  npx homebridge-samsung-rac-probe pair --host 10.0.0.9
  ```
- **A firewall on the Homebridge machine** — allow inbound TCP on port 8889.
- **A listener left over from an earlier attempt** — it keeps the port and the
  next run fails in a way that looks identical to the unit never calling back.

## Debug logs

Run Homebridge with `-D` (or tick *Debug Mode* in the UI) and this plugin traces
everything it does with the unit:

```
[Samsung RAC] Configured with 1 unit(s), polling every 10s, 5000ms timeout, swing direction 'Up_And_Low'.
[Samsung RAC] Lounge raw device document: {"id":"0","uuid":"…","Wind":{"direction":"Fix",…}}
[Samsung RAC] 10.0.0.9:8888 > GET /devices
[Samsung RAC] 10.0.0.9:8888 < 200 GET /devices in 41ms (1888 bytes)
[Samsung RAC] Lounge changed: active false -> true, currentTemperature 23 -> 22
[Samsung RAC] Lounge: HomeKit asked for swing on, sending direction 'Up_And_Low'.
[Samsung RAC] Lounge writing Wind.direction = Up_And_Low
[Samsung RAC] 10.0.0.9:8888 > PUT /devices/0/wind {"Wind":{"direction":"Up_And_Low"}}
[Samsung RAC] Lounge confirmed Wind.direction = Up_And_Low.
```

What each kind of line is for:

| Line | Tells you |
|---|---|
| `raw device document` | The whole document, once per start. The first thing to attach to a bug report. |
| `> ` / `< ` / `x ` | Request, answer, failure — with timings. Poll responses are summarised by size; writes and anything non-2xx are printed in full. |
| `changed:` | One line per real change, including changes made from the remote or the Samsung app. Silence means the unit reported the same thing again. |
| `HomeKit asked for …` | What the Home app requested and what the plugin decided to send — the place to look when a tap does the wrong thing. |
| `confirmed` / `accepted a write and did not apply it` | Whether the read-back proved the change landed. |

Two things are logged without `-D`, because they matter at normal volume: a unit
that stops answering is warned about **once** per outage (`not responding`) and
announced when it comes back (`responding again`), and a write the unit accepts
and silently discards is warned about once per field.

## Probe CLI

A command-line driver over the plugin's own transport code, for setting a unit up
without the UI and for working out what a misbehaving one is doing.

```bash
npx homebridge-samsung-rac-probe cert                   # download the certificate
npx homebridge-samsung-rac-probe pair   --host 10.0.0.9 # run the pairing ritual
npx homebridge-samsung-rac-probe dump   --host 10.0.0.9 # print the device state
npx homebridge-samsung-rac-probe writes --host 10.0.0.9 --power-on
```

It ships with the plugin, so it works from an ordinary install. From a checkout,
`npm run probe -- dump --host 10.0.0.9` runs the same thing through ts-node.

Progress goes to stderr and the payload to stdout, so either can be redirected
without the running commentary landing in the file:

```bash
npx homebridge-samsung-rac-probe dump --host 10.0.0.9 > unit.json
npx homebridge-samsung-rac-probe writes --host 10.0.0.9 --power-on > report.md
```

`dump` is the first thing to ask for in a bug report about an unfamiliar model:
it separates a parsing bug from a genuine hardware difference, and its stdout is
the device's own JSON.

`writes` matters more than it sounds. **This hardware answers HTTP 200 to commands
it silently discards.** The probe writes a value, reads it back, and counts only a
*changed read-back* as success. It restores everything it touched and leaves a
report, printed to stdout (`--out <path>` saves it to a file instead). The
findings for the reference unit are summarised below.

Always pass `--power-on`. On the reference unit **every write except power is
silently discarded while it is off** — 200, no error, no effect — so a run without
it says nothing about whether a field is writable.

The run also searches `Mode.options`, where the unit keeps its convenience mode,
auto-clean and sleep timer. Nothing documents how to write those keys, nor what
names they take, so the probe tries each in turn and reports which the unit
applied, rejected, or accepted and discarded. That search is what settled the
convenience mode on the reference unit, and it is how a different model gets
settled too — **if yours applies a name this one does not, that report is the
thing to attach to an issue.**

The plugin applies the same rule at runtime: every write is confirmed by a
read-back, and a value the unit quietly refuses is corrected in the Home app
rather than left showing something that never happened.

### What the reference unit accepts

Measured on a TP6X_RAC_16K, 2026-09-15:

| | |
|---|---|
| Method | `PUT` only — `POST` returns 405 |
| Power, fan speed, setpoint, mode | all applied |
| Vane | `Fix` and `Up_And_Low` applied; `Vertical` and `SwingUD` rejected with 400; `All` accepted and then ignored |
| Convenience mode (`Comode`) | `Comfort`, `Quiet`, `Speed`, `Smart`, `2Step` and `Sleep` applied; `WindFree` and `SoftCool` ignored |
| Auto-clean | applied |
| Sleep timer (`Sleep`) | not applied |
| `Mode.options` body | one entry at a time — `{"Mode":{"options":["Comode_Quiet"]}}`. The whole array echoed back is rejected |

These are the original TP6X_RAC_16K probe results. Optional switches now expose
verified presets and Auto Clean; see the TP6X_RAC_17K additions below for native Good Sleep.

Consequence worth knowing: **changing anything in the Home app while the unit is
off does nothing**, and the tile will snap back after a second. Turn it on first.
That is the hardware's behaviour, not the plugin's — the plugin reports it
honestly rather than pretending the change stuck.

## Configuration

Everything is editable in the Homebridge UI. The equivalent `config.json`:

```json
{
  "platform": "SamsungRacLocal",
  "devices": [
    { "name": "Lounge", "host": "10.0.0.9", "heating": "auto" }
  ],
  "updateInterval": 10,
  "swingDirection": "Up_And_Low",
  "convenienceModes": [{ "mode": "Quiet" }],
  "modeSwitches": [{ "mode": "Dry" }],
  "outdoorTemperature": "linked",
  "outdoorTemperatureUnit": "fahrenheit",
  "hideOutdoorTemperatureWhenOff": false,
  "freezeIndoorTemperatureWhenOff": false
}
```

| Key | Default | |
|---|---|---|
| `devices[].host` | — | The unit's IP address, or last-known address when discovery is enabled. Required. |
| `devices[].deviceUuid` | — | Optional stable UUID; enables SSDP discovery and identity checks. |
| `devices[].name` | the unit's own name | Shown in the Home app. |
| `devices[].token` | — | Only if you paired outside this plugin. |
| `devices[].heating` | `auto` | `on` or `off` to override whether Heat is offered. `auto` reads it from the unit, which is right for every unit seen so far. |
| `updateInterval` | `10` | Seconds between polls; minimum 5. |
| `adaptivePolling` | `false` | Brief two-second follow-ups after controls and progressive offline backoff. |
| `shutdownTimers` | `[]` | Optional local shutoff durations in whole minutes, from 1 to 1440, with up to eight distinct choices. |
| `detailedSwing` | `false` | Separate vertical and horizontal swing switches. |
| `spiSwitch` | `false` | Expose the reported Purify (SPI) setting. |
| `sharedOutdoorName` | `AC Outdoor Temperature` | Name of the optional shared outdoor sensor. |
| `swingDirection` | `Up_And_Low` | What to set the vane to for "swing on". Units differ; the log says if yours ignores it. |
| `convenienceModes` | none | `Comode` values to publish a switch for, as `"Quiet"` or `{ "mode": "Speed", "name": "Fast Turbo" }`. One runs at a time, so the switches act as one group. |
| `modeSwitches` | none | `Mode.modes` values to publish a switch for — `Dry` and `Wind`, the two HomeKit's air conditioner tile cannot express. Same two shapes. |
| `goodSleepMinutes` | `0` (disabled) | Native Good Sleep switch for verified TP6X_RAC_17K units: `60` or `120` minutes. Start with the AC running in Cool mode. |
| `autoCleanSwitch` | `false` | Expose Auto Clean when the unit reports `Autoclean_On` or `Autoclean_Off`. This is an enabled setting, not a cleaning-in-progress indicator. |
| `outdoorTemperature` | `linked` | `linked` on each AC, `separate` per-AC accessories, `shared` for one multisplit outdoor unit, or `off`. |
| `outdoorTemperatureUnit` | `fahrenheit` | The scale that sensor reports in. Not the same setting as the unit's own scale. |
| `hideOutdoorTemperatureWhenOff` | `false` | Stop reporting the outdoor tile while the unit is off, for units whose reading is only trustworthy when running. |
| `freezeIndoorTemperatureWhenOff` | `false` | Hold the room temperature at its last running value while the unit is off, for units whose reading is only trustworthy when running. |
| `requestTimeout` | `5` | Seconds. |
| `certificateUrl` | community URL | Only if you mirror the certificate yourself. |

## Security notes

- The client certificate contains a private key and is **not** in this
  repository. It is fetched at setup time and written `0600` under your
  Homebridge storage path.
- Device tokens grant full local control of the air conditioner. They are stored
  `0600` in the same directory, not in `config.json`.
- The connection to the unit uses TLS 1.0 with OpenSSL security level 0, because
  that is all its firmware speaks. It never leaves your network.

## Development

```bash
npm install
npm test
npm run lint
npm run build
npm run watch    # rebuild and restart Homebridge on change
```

Unit tests never touch the network: `nock` is locked down and `fetch` is replaced
outright. The fixture in `tests/fixtures/devices.json` is a real capture from the
reference unit.


### Auto Clean and usage history

Auto Clean is an opt-in switch. Use `"autoCleanSwitch": true` with
`"modeSwitches": [{"mode":"Dry"}, {"mode":"Wind"}]` to expose all three controls.
Dry and Fan select an operating mode; the main AC tile controls power.
Turning a mode switch off returns to the last ordinary mode (or Cool as fallback).
Auto Clean is independent of those modes and continues to read enabled while the
unit is off. Some firmware accepts setting changes only while powered on. Every
write is confirmed by a status read; a rejected setting returns to the actual value.

In the plugin settings, **History** beside a paired unit reads its local usage
database on demand. The table shows the latest 60 records; CSV exports every
record. It requires Node.js 22.13+ with `node:sqlite` available.
There are no new dependencies or background history polls. The database is opened
read-only in a private temporary directory and removed after reading.

The observed date keys use `YYYYMMDDHH`, with an unconfirmed device timezone.
Runtime values are cumulative counters whose units are not yet calibrated; the
view shows raw values and increases between consecutive records, not hours or
per-hour consumption. Counter decreases are marked as resets. All three tested
TP6X_RAC_17K units report zero for every energy counter, so this is not usable
energy/kWh monitoring. The data can also lag recent operation.


### Local shutoff timers

Set `"shutdownTimers": [30, 60, 120]` to add **Off in 30 min**, **Off in 60 min**,
and **Off in 120 min** switches to each AC. Durations are whole minutes from 1
through 1440, with up to eight distinct durations. No timers are exposed by default.

Start the AC using its main tile, then turn on a timer switch. This schedules
power-off; it never powers on an idle AC. Selecting another duration replaces the
countdown, and turning the active timer switch off cancels it without turning off
the AC. A power-off observed from Home, SmartThings, or the remote also cancels it.
A duplicate On command deliberately starts a fresh countdown from that moment.

The deadline is stored with the existing Homebridge accessory and resumes after a
restart. The Homebridge host must be available to execute it. A brief failure is
retried for up to five minutes after the original deadline; older deadlines are
discarded rather than shutting down a possibly new session hours later. Each
attempt reads the AC first and confirms the resulting off state. Power cycles
that happen entirely while Homebridge is offline cannot be detected.

Quiet and Fast Turbo use the existing `convenienceModes` setting:
`[{"mode":"Quiet"}, {"mode":"Speed"}]`. Both values were confirmed by local
read-back on all three TP6X_RAC_17K units in Cool mode on 2026-11-04. This confirms
the setting, not a measured acoustic or cooling-performance change, and does not
identify either preset as WindFree. Presets are mutually exclusive and can change
fan settings as part of their intended operation.


## Swing axes, SPI and one multisplit outdoor sensor

The optional configuration below adds two swing switches and an SPI setting
switch to each AC, plus **one** separate temperature accessory for the shared
outdoor unit:

```json
{
  "detailedSwing": true,
  "spiSwitch": true,
  "outdoorTemperature": "shared",
  "outdoorTemperatureUnit": "fahrenheit",
  "sharedOutdoorName": "AC Outdoor Temperature",
  "hideOutdoorTemperatureWhenOff": false
}
```

Only use `shared` when every AC in this platform belongs to the same outdoor unit.
It does not infer shared hardware merely because temperatures happen to match.
The accessory has a stable identity independent of source IPs and can be assigned
to an outdoor room in Apple Home. Existing per-AC outdoor sensors are removed when
all devices are reachable; AC identities and pairing are retained.

**Swing:** Up Down and Left Right are independent switches. Both on sends `All`;
both off sends `Fix`. Disabling one axis preserves the other. The main AC swing
control still enables the configured `swingDirection` or disables both axes.
These are oscillation controls, not fixed vane-angle selectors. Settings do not
power the AC on; firmware may ignore changes while it is off. All four direction
values were confirmed by read-back on three TP6X_RAC_17K units in fan-only mode.
Other model families can accept fewer directions, so this remains opt-in.

**Purify (SPI):** The switch reflects the Samsung `Spi_On` / `Spi_Off` setting, including
its retained value while the AC is off. Both values were confirmed by local
read-back on all three tested units. This verifies the setting, not the presence
or output of ionizer hardware; no air-quality measurement is implied.

**Outdoor temperature:** Existing AC polls feed one shared sensor. Prefer a fresh
reading from a running indoor unit, otherwise use the first available source;
never average duplicate readings. A source expires after 60 seconds (or three
poll intervals if longer), using the last successful LAN read time rather than
the time a cached response was returned. If every source expires, HomeKit reports
No Response. Recovery reuses the same accessory. With `hideOutdoorTemperatureWhenOff`
enabled, only running indoor units supply the sensor.

The outdoor field has no unit label. Fahrenheit is documented for the related
TP6X_RAC_16K; the tested 17K units all reported raw `65` (18.3°C when interpreted
as Fahrenheit), both idle and running. This scale remains an explicit assumption
until compared with an independent thermometer. A successful poll cannot prove
that the outdoor hardware refreshed its sensor while idle.


## Adaptive local polling

```json
{
  "updateInterval": 5,
  "adaptivePolling": true
}
```

Normal status checks run five seconds after the preceding check finishes, even
when an AC is off. A control change detected from the remote/app, or a HomeKit
command with a successful read-back, starts thirty seconds of two-second
follow-ups. A subsequent control change renews that window. Temperature drift
and usage counters do not keep the faster polling active. A remote's first
change still has to wait for a normal poll; this is not a push subscription.

Reads and writes use one operation queue per AC. Concurrent reads share one
request, polls wait behind commands, and a fresh command read-back can satisfy
waiting polls. In adaptive mode the cache lasts one second so it does not swallow
the two-second checks. Timer actions retain their fresh-state checks and run on
their own deadlines.

Failed reads progressively wait 10, 20, 40 and then 60 seconds with the above
five-second base interval. A successful read returns to normal polling; a
confirmed HomeKit command can resume the follow-up window. Backoff still applies
when the adapter temporarily serves its last good cached state. Cached state has
a sixty-second grace period, after which the next unsuccessful read reports No
Response. Offline recovery can therefore take up to the retry interval, plus
request/discovery time. Normal commands are queued immediately, not postponed to
the next scheduled poll. Only background retries are slowed.

`adaptivePolling` defaults to false for existing configurations. A longer normal
interval remains supported; backoff is capped at the greater of sixty seconds
and that configured interval. There are no extra dependencies, persistent
connections or cloud requests.


## Samsung controls on TP6X_RAC_17K

Local read-back tests on three TP6X_RAC_17K units confirmed the following
controls. Wind free and Good Sleep were also matched against SmartThings on
one of those units. These protocol model results do not establish support on every
Samsung retail model.

| Home name | Local option |
|---|---|
| Wind free | `Comode_Nano` |
| 2-Step | `Comode_2Step` |
| Fast Turbo | `Comode_Speed` |
| Comfort | `Comode_Comfort` |
| Quiet | `Comode_Quiet` |
| Purify | `Spi_On` / `Spi_Off` |
| Good Sleep | `Comode_Sleep` with `Sleep_2` for one hour or `Sleep_4` for two hours |

```json
{
  "convenienceModes": [
    { "mode": "Nano", "name": "Wind free" },
    { "mode": "2Step", "name": "2-Step" },
    { "mode": "Speed", "name": "Fast Turbo" },
    { "mode": "Comfort", "name": "Comfort" },
    { "mode": "Quiet", "name": "Quiet" }
  ],
  "modeSwitches": [{ "mode": "Dry", "name": "Dry" }, { "mode": "Wind", "name": "Fan" }],
  "goodSleepMinutes": 60,
  "spiSwitch": true,
  "detailedSwing": true
}
```

Good Sleep is one switch with a default duration chosen in Homebridge settings.
Start it while the AC is running in Cool mode. The switch also reflects Good
Sleep started from SmartThings, even with a different duration. It stays on
while the AC reports active sleep mode. A configured legacy `Sleep` preset
switch is suppressed when this duration-aware control is enabled.

Starting stages the duration, enters Sleep, then explicitly reapplies the
duration while Sleep is active. The sequence shares the device write queue
and is confirmed with a fresh read. Cancelling sends `Comode_Off`, preserving
power. **Do not cancel with `Sleep_0`: these units turn off immediately.**
One- and two-hour settings and cancellation were verified; a complete sleep
cycle and automatic expiry have not been observed. Other durations and base
modes are deliberately unavailable until tested.

The AC owns Good Sleep timing. The existing **Off in …** switches are separate
countdowns that Homebridge owns. Avoid scheduling both when you want the full
Good Sleep cycle.

Apple Home's HeaterCooler mode picker is fixed to Auto, Heat and Cool, with
power separate. Fan and Dry cannot be added as custom picker entries, so they
remain separate switches. They select a base mode; the main AC tile controls
power. Presets are mutually exclusive and reflect the AC's current state.

Existing service subtypes and accessory UUIDs are retained. Legacy default
names migrate once to Fan, Fast Turbo, Purify, Vertical swing and Horizontal
swing; other custom Home names remain intact. New custom names survive future
restarts, including a deliberate return to an old label.
