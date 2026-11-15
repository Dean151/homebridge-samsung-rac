# Native off-timer investigation

Read-only observations on 2026-11-15, using the existing paired local HTTPS API.
No appliance writes, re-pairing, plugin deployment or Homebridge restart were
performed. Device identifiers, addresses and room names are omitted.

## Observed responses

All three configured ACs authenticated successfully and were off. Each advertised
these resources in `GET /devices`: Alarms, Configuration, Diagnosis,
EnergyConsumption, Information, Mode, Operation, Temperatures and Wind.
`Mode.options` contained `Comode_Off` and `Sleep_0`, but no option whose name
identified a general on/off timer. `GET /capability` returned
HTTP 404 on all three units.

One unit was inspected further. Its information resource identifies
`TP6X_RAC_17K`, software `01853A200403`, firmware `17022300,16122300`.

| Read | Response |
| --- | --- |
| `/devices/0/configuration` | HTTP 200; region only |
| `/devices/0/information` | HTTP 200; model and version information |
| `/devices/0/timer` | HTTP 404, Invalid resource |
| `/devices/0/timers` | HTTP 404, Invalid resource |
| `/devices/0/schedule` | HTTP 404, Invalid resource |
| `/devices/0/schedules` | HTTP 404, Invalid resource |

The last four paths were candidates, not advertised resources. These observations
are **not proof that a native timer is absent**: a field may appear only while a
timer is active, or use another resource or encoding. Good Sleep is a separate
mode-dependent function; its known `Sleep` duration does not establish a general
off timer.

The [LocalThings legacy HTTPS resource mapping](https://github.com/mbillow/localthings/blob/cc82809811af591a3fabb9c2fb14e05540a228b6/custom_components/localthings/legacy_http.py)
also contains no general timer resource. Its Good Sleep support is not evidence
that a general timer can be driven on these units. Implementations of Samsung's
older port-2878 protocol or newer CoAP resources cannot be assumed to apply to
this port-8888 firmware.

## Remaining comparison

With someone at the AC, record the complete local document with the unit running
and no timer. Set an ordinary Off timer using the Samsung remote, record the
selected duration and another document, then cancel and record again. Restore
the starting power/settings. Repeat with the app if its timer is a separate
control. Distinguish a device timer from a cloud-scheduled action.

Compare all fields, including unknown option tokens and newly advertised
resources. If a candidate is found, confirm it changes consistently for a second
duration before proposing a narrowly scoped write/read-back/restore test.
Absence of a visible change would establish only that these reads do not expose
that remote/app timer. Device-side expiry while the controller is disconnected
would be a separate test; it has not been performed.
