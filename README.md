# homebridge-samsung-rac

Control a Samsung room air conditioner from HomeKit over its **local network API**
(`https://<ip>:8888`, mutual TLS) instead of the SmartThings cloud.

The local API is richer than the cloud one. Most importantly it exposes the vane
position — `Wind.direction` — which the SmartThings API does not expose at all,
and which is the reason this plugin exists.

Developed against a **TP6X_RAC_16K** (SmartThings vendor id `DA-AC-RAC-100001`).
Other units of the same generation should work; older port-2878 models will not.

## What it exposes

A single `HeaterCooler` accessory per unit:

| HomeKit | Comes from |
|---|---|
| On / off | `Operation.power` |
| Current temperature | `Temperatures[0].current` |
| Target temperature | `Temperatures[0].desired`, with the range the unit reports |
| Mode | `Mode.modes`, limited to the modes the unit says it supports |
| Fan speed | `Wind.speedLevel` / `Wind.maxSpeedLevel` |
| Swing | `Wind.direction` |
| Filter indicator | the `FilterAlarm` entry in `Alarms` |

Dry and fan-only modes have no HomeKit equivalent. The plugin reports them as
Auto/Idle and leaves them alone rather than overwriting a mode you chose in the
Samsung app.

A service only appears once the unit has actually published a reading for it, and
is never withdrawn afterwards — some units publish nothing until they are running.

## Setup

1. Install the plugin and open its settings in the Homebridge UI.
2. **Fetch the certificate.** The local API requires a client certificate that
   bundles a private key. It is not shipped with this plugin: it is downloaded
   once and stored next to your Homebridge config, on your machine only.
3. **Add your air conditioner's IP address** and save. Give it a fixed DHCP lease
   on your router — the plugin cannot follow a unit that moves. You can add
   several units.
4. **Pair.** This is the awkward part, and the order matters:
   - power the air conditioner **off**
   - press *Start pairing*
   - power it back **on** when the UI asks

   The unit does not hand out a token on request. It calls back to Homebridge on
   port 8889 the moment it powers on, and that callback carries the token.

The token is stored alongside the certificate, outside `config.json`.

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
    { "name": "Lounge", "host": "10.0.0.9" }
  ],
  "updateInterval": 10,
  "swingDirection": "Up_And_Low"
}
```

| Key | Default | |
|---|---|---|
| `devices[].host` | — | The unit's IP address. Required. |
| `devices[].name` | the unit's own name | Shown in the Home app. |
| `devices[].token` | — | Only if you paired outside this plugin. |
| `updateInterval` | `10` | Seconds between polls; minimum 5. |
| `swingDirection` | `Up_And_Low` | What to set the vane to for "swing on". Units differ; the log says if yours ignores it. |
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
