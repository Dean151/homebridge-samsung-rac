import type { Characteristic, CharacteristicValue, PlatformAccessory, Service, WithUUID } from 'homebridge';
import type { OutdoorAccessory, SamsungRacPlatform } from './platform';
import type { ApplyResult, DeviceAdapter } from './deviceAdapter';
import type { RacStatus } from './racStatus';
import { setpointStep } from './temperature';

/**
 * Device modes that run the unit without driving towards a setpoint. HomeKit's
 * HeaterCooler has no target state for them, so they report as AUTO + IDLE and
 * are left alone rather than being overwritten with 'Auto'.
 */
const nonThermalModes = ['dry', 'wind', 'fan'];

/** How far from the setpoint AUTO has to be before we call it heating or cooling. */
const autoModeDeadBand = 0.5;

/** The value Wind.direction takes when the vane is parked. */
const swingOffDirection = 'Fix';

/** The value Comode takes when no convenience mode is running. */
const comodeOff = 'Off';

/**
 * Names the unit uses that read badly on a tile. Everything else keeps the
 * unit's own name, so the word in the Home app is the word in the log and in
 * the config — and anything here can still be renamed in the Home app.
 */
const switchLabels: Record<string, string> = {
  wind: 'Fan Only',
  '2step': '2 Step',
};

/** Subtype prefixes for the switches this plugin owns, so it only removes its own. */
const switchSubtypes = { comode: 'comode-', mode: 'mode-' } as const;

function labelFor(name: string): string {
  return switchLabels[name.toLowerCase()] ?? name;
}

/**
 * One switch in a group backed by a single field on the unit.
 *
 * The group is a radio button, not a set of independent toggles: every member
 * reads from the same value, so they cannot disagree with each other. Turning
 * Quiet on makes Comfort read false on the same push — including when the
 * change was made on the remote rather than in the Home app.
 */
interface ModeSwitch {
  /** Stable, and the HomeKit subtype: it is what carries the user's automations. */
  subtype: string;
  /** Which field this switch is backed by, and so which switches it excludes. */
  group: 'comode' | 'mode';
  label: string;
  /** Whether the unit publishes the field this switch is backed by at all. */
  available: (status: RacStatus) => boolean;
  isOn: (status: RacStatus) => boolean;
  /** What to send, or null when there is nothing sensible to send. */
  write: (on: boolean) => (() => Promise<ApplyResult>) | null;
}

/** HAP pins HeatingThresholdTemperature to 0-25 °C, unlike the cooling threshold. */
const hapHeatingThresholdMin = 0;
const hapHeatingThresholdMax = 25;

enum TargetState { AUTO = 0, HEAT = 1, COOL = 2 }
enum CurrentState { INACTIVE = 0, IDLE = 1, HEATING = 2, COOLING = 3 }

export class SamsungRacAccessory {
  private readonly service: Service;
  private status: RacStatus;

  /**
   * Starts false: until the first read lands there is nothing truthful to
   * report, and "No Response" beats inventing placeholder values.
   */
  private responsive = false;

  /** Warn once per outage, not once per poll. */
  private loggedOffline = false;

  /** Guards adoptLateCapabilities() against initialize()'s own first read. */
  private configured = false;

  private pollTimer: NodeJS.Timeout | null = null;

  private minTemp = 16;
  private maxTemp = 30;
  /** 1 °C, or 0.5 °C for a unit that stores whole degrees Fahrenheit. */
  private setpointStep = 1;
  private speedStep = 0;
  private maxSpeedLevel = 0;
  private loggedHeatingCap = false;

  /** `devices[].heating` for this unit: true, false, or undefined for auto. */
  private readonly heatingOverride?: boolean;

  /** Whether HEAT is currently on offer, so adoption stays one-way. */
  private offersHeat = false;

  /** The switches currently published for modes HeaterCooler cannot express. */
  private modeSwitches: ModeSwitch[] = [];

  /**
   * The last mode seen that a switch does not stand for, so switching Dry off
   * can put the unit back where it was rather than somewhere arbitrary.
   */
  private lastPlainMode?: string;

  static async create(
    platform: SamsungRacPlatform,
    accessory: PlatformAccessory,
    adapter: DeviceAdapter,
    outdoor?: OutdoorAccessory,
  ): Promise<SamsungRacAccessory> {
    const instance = new SamsungRacAccessory(platform, accessory, adapter, outdoor);
    await instance.initialize();
    return instance;
  }

  private constructor(
    private readonly platform: SamsungRacPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly adapter: DeviceAdapter,
    /**
     * Where the outdoor sensor goes when the user asked for one of its own, so
     * it can live in a different room from the air conditioner. Undefined hangs
     * it off this accessory instead.
     */
    private readonly outdoor?: OutdoorAccessory,
  ) {
    this.status = emptyStatus();

    const context = this.accessory.context as { model?: string; uuid?: string; heating?: boolean };
    this.heatingOverride = context.heating;

    this.accessory.getService(this.platform.Service.AccessoryInformation)
      ?.setCharacteristic(this.platform.Characteristic.Manufacturer, 'Samsung')
      .setCharacteristic(this.platform.Characteristic.Model, context.model ?? 'Room Air Conditioner')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, context.uuid ?? this.accessory.UUID);

    this.service = this.accessory.getService(this.platform.Service.HeaterCooler)
      || this.accessory.addService(this.platform.Service.HeaterCooler);
    this.service.setCharacteristic(this.platform.Characteristic.Name, this.accessory.displayName);
    // Said out loud rather than left to the order services happen to be added
    // in: once this accessory carries switches too, the Home app has to know
    // which of them is the air conditioner.
    this.service.setPrimaryService(true);

    this.service.getCharacteristic(this.platform.Characteristic.Active)
      .onGet(this.getActive.bind(this))
      .onSet(this.setActive.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState)
      .onGet(this.getCurrentState.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState)
      .onGet(this.getTargetState.bind(this))
      .onSet(this.setTargetState.bind(this));

    // The unit exposes a single setpoint, so both thresholds read and write it;
    // only the range HomeKit is told about differs.
    this.service.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
      .onGet(this.getCoolingThreshold.bind(this))
      .onSet(this.setTargetTemperature.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
      .onGet(this.getHeatingThreshold.bind(this))
      .onSet(this.setTargetTemperature.bind(this));
  }

  private async initialize(): Promise<void> {
    // Not fatal: updateStatus swallows the failure, the accessory reports
    // "No Response", and the next poll recovers.
    await this.updateStatus();

    this.applySetpointRange();
    this.configureTargetStates();
    this.configureFanSpeed();
    this.configureSwing();
    this.configureFilter();
    this.configureOutdoorSensor();
    this.configureModeSwitches();
    this.configured = true;

    const interval = this.platform.settings.updateInterval;
    this.pollTimer = setInterval(() => {
      void this.updateStatus();
    }, interval * 1000);
    this.pollTimer.unref();

    this.platform.log.info(`${this.accessory.displayName}: polling every ${interval}s.`);
  }

  /** Called when Homebridge shuts the platform down. */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.adapter.close();
  }

  // --- configuration -------------------------------------------------------

  private applySetpointRange(): void {
    const min = Number.isFinite(this.status.minSetpoint) ? this.status.minSetpoint! : this.minTemp;
    const max = Number.isFinite(this.status.maxSetpoint) ? this.status.maxSetpoint! : this.maxTemp;

    if (min >= max) {
      this.platform.log.warn(
        `${this.accessory.displayName}: the unit reports an unusable temperature range (${min}-${max}); `
        + `keeping ${this.minTemp}-${this.maxTemp}.`,
      );
      return;
    }

    this.minTemp = min;
    this.maxTemp = max;
    this.setpointStep = setpointStep(this.status.temperatureUnit);

    if (this.status.temperatureUnit === 'F') {
      this.platform.log.info(
        `${this.accessory.displayName}: the unit reports Fahrenheit; converting to Celsius for HomeKit `
        + `(range ${min}-${max}°C, ${this.setpointStep}°C steps).`,
      );
    }

    this.service.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
      .setProps({ minValue: min, maxValue: max, minStep: this.setpointStep });

    const heatingMax = Math.min(hapHeatingThresholdMax, max);
    if (heatingMax < max && !this.loggedHeatingCap) {
      this.loggedHeatingCap = true;
      this.platform.log.info(
        `${this.accessory.displayName}: heating threshold capped at ${heatingMax}°C, which is all HomeKit allows.`,
      );
    }

    this.service.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
      .setProps({
        minValue: Math.max(hapHeatingThresholdMin, min),
        maxValue: heatingMax,
        minStep: this.setpointStep,
      });
  }

  /**
   * Whether to offer HEAT, which `supportedModes` alone cannot answer.
   *
   * The reference unit reports `modes: ['Heat']` and `supportedModes:
   * ['Cool','Dry','Wind','Auto']` in the SAME document, and applies a write of
   * 'Heat' confirmed by read-back — so the advertised list omits a mode the
   * hardware genuinely has, and trusting it hides working heating from HomeKit.
   * Settled 2026-09-15; see notes/HANDOFF.md.
   *
   * Order: the user's override wins outright, in both directions — it is the
   * escape hatch for a unit whose signals are wrong either way. Failing that,
   * the advertised list and `WarmCapa` can only ADD heat, never take it away,
   * because each is a floor rather than a ceiling: the failure being fixed is a
   * mode wrongly absent, not a mode wrongly present.
   */
  private supportsHeat(): boolean {
    if (this.heatingOverride !== undefined) {
      return this.heatingOverride;
    }
    if (this.status.supportedModes.some((mode) => mode.toLowerCase() === 'heat')) {
      return true;
    }
    return this.status.heatCapable === true;
  }

  /** Why heat is or is not on offer, so a wrong guess is diagnosable from the log. */
  private heatSource(): string {
    if (this.heatingOverride !== undefined) {
      return `the 'heating' setting for this unit (${this.heatingOverride ? 'on' : 'off'})`;
    }
    if (this.status.supportedModes.some((mode) => mode.toLowerCase() === 'heat')) {
      return 'the unit advertising it in supportedModes';
    }
    if (this.status.heatCapable === true) {
      return `WarmCapa_${this.status.options.WarmCapa} (supportedModes does not list Heat)`;
    }
    return this.status.heatCapable === false
      ? `WarmCapa_${this.status.options.WarmCapa}`
      : 'neither supportedModes nor WarmCapa';
  }

  /**
   * Only advertise the target states the unit actually supports: offering a
   * control that does nothing is worse than omitting it. `supportedModes` is
   * the starting point rather than the whole answer — see supportsHeat().
   */
  private configureTargetStates(): void {
    // supportsHeat() is the sole authority on heat, so an override of 'off'
    // removes it even from a unit that does advertise it.
    const supported = new Set(this.status.supportedModes.map((mode) => mode.toLowerCase()));
    supported.delete('heat');
    if (this.supportsHeat()) {
      supported.add('heat');
    }
    const values = new Set<number>();
    this.offersHeat = supported.has('heat');

    this.platform.log.info(
      `${this.accessory.displayName}: heat ${this.offersHeat ? 'available' : 'not available'}, `
      + `from ${this.heatSource()}.`,
    );

    for (const mode of supported) {
      if (mode === 'cool') {
        values.add(TargetState.COOL);
      } else if (mode === 'heat') {
        values.add(TargetState.HEAT);
      } else if (mode === 'auto' || nonThermalModes.includes(mode)) {
        values.add(TargetState.AUTO);
      }
    }

    if (values.size === 0) {
      values.add(TargetState.AUTO);
    }

    this.service.getCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState)
      .setProps({ validValues: [...values].sort((a, b) => a - b) });
  }

  private hasFanReading(): boolean {
    return Number.isFinite(this.status.maxSpeedLevel)
      && (this.status.maxSpeedLevel as number) > 0
      && Number.isFinite(this.status.speedLevel);
  }

  private configureFanSpeed(): void {
    if (!this.hasFanReading()) {
      this.removeCharacteristicIfPresent(this.platform.Characteristic.RotationSpeed);
      this.speedStep = 0;
      this.platform.log.info(`${this.accessory.displayName}: fan speed is not available.`);
      return;
    }

    this.maxSpeedLevel = this.status.maxSpeedLevel as number;
    // Grid-aligned, as in the sibling plugin: every percentage this accessory
    // ever reports is one HomeKit accepts back unchanged.
    this.speedStep = Math.max(1, Math.floor(100 / this.maxSpeedLevel));

    this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: this.speedStep * this.maxSpeedLevel, minStep: this.speedStep })
      .onGet(this.getRotationSpeed.bind(this))
      .onSet(this.setRotationSpeed.bind(this));

    this.platform.log.info(
      `${this.accessory.displayName}: fan speed available, levels 0-${this.maxSpeedLevel}.`,
    );
  }

  private hasSwingReading(): boolean {
    return typeof this.status.windDirection === 'string' && this.status.windDirection.length > 0;
  }

  private configureSwing(): void {
    if (!this.hasSwingReading()) {
      this.removeCharacteristicIfPresent(this.platform.Characteristic.SwingMode);
      this.platform.log.info(`${this.accessory.displayName}: swing is not available.`);
      return;
    }

    this.service.getCharacteristic(this.platform.Characteristic.SwingMode)
      .onGet(this.getSwingMode.bind(this))
      .onSet(this.setSwingMode.bind(this));

    this.platform.log.info(`${this.accessory.displayName}: swing available.`);
  }

  private hasFilterReading(): boolean {
    return this.status.resources.includes('Alarms');
  }

  private configureFilter(): void {
    const existing = this.accessory.getService(this.platform.Service.FilterMaintenance);

    if (!this.hasFilterReading()) {
      if (existing) {
        this.accessory.removeService(existing);
      }
      this.platform.log.info(`${this.accessory.displayName}: filter status is not available.`);
      return;
    }

    const service = existing ?? this.accessory.addService(this.platform.Service.FilterMaintenance);
    this.nameService(this.accessory, service, 'filter', `${this.accessory.displayName} Filter`);
    service.getCharacteristic(this.platform.Characteristic.FilterChangeIndication)
      .onGet(this.getFilterChange.bind(this));
    this.service.addLinkedService(service);

    if (this.hasFilterLifeReading()) {
      service.getCharacteristic(this.platform.Characteristic.FilterLifeLevel)
        .onGet(this.getFilterLife.bind(this));
      this.platform.log.info(
        `${this.accessory.displayName}: filter status available, `
        + `${this.status.filterLife}% left of ${this.status.filterAlarmHours}h `
        + `(${this.status.filterHours}h used).`,
      );
      return;
    }

    this.removeCharacteristicIfPresent(this.platform.Characteristic.FilterLifeLevel, service);
    this.platform.log.info(`${this.accessory.displayName}: filter status available.`);
  }

  /**
   * Both counters, not just one: the threshold is the user's to set in the
   * Samsung app — 180, 300, 500 or 700 hours — so a percentage cannot be
   * computed from the hours used alone.
   */
  private hasFilterLifeReading(): boolean {
    return Number.isFinite(this.status.filterLife);
  }

  private hasOutdoorReading(): boolean {
    return Number.isFinite(this.status.outdoorTemperature);
  }

  /**
   * Whether the outdoor reading is one the user has asked us to withhold — they
   * have set `hideOutdoorTemperatureWhenOff` and the unit is off.
   *
   * Deliberately not folded into hasOutdoorReading: that one decides whether the
   * sensor gets published at all, and a unit that happens to be off when
   * Homebridge starts must not lose its tile. This only silences the value.
   */
  private outdoorReadingSuppressed(): boolean {
    return this.platform.settings.hideOutdoorTemperatureWhenOff && !this.status.active;
  }

  /** The accessory the outdoor sensor belongs on, per the user's setting. */
  private outdoorHost(): PlatformAccessory {
    return this.outdoor?.accessory ?? this.accessory;
  }

  private outdoorService(): Service | undefined {
    return this.outdoorHost().getService(this.platform.Service.TemperatureSensor);
  }

  /**
   * The unit's outdoor sensor, as a temperature sensor of its own — either on
   * this accessory or, when the user asked for it, on an accessory of its own
   * that HomeKit will let them put in a different room.
   *
   * Its scale is a config decision rather than something the document states —
   * the reference unit reports this in Fahrenheit while reporting itself in
   * Celsius — so by the time it reaches here it is already Celsius or already
   * discarded. See RacStatusOptions.
   */
  private configureOutdoorSensor(): void {
    const host = this.outdoorHost();

    // A cached accessory can still carry the sensor from a run under the other
    // setting; the one that no longer belongs there has to go, or the reading
    // would show up twice.
    if (host !== this.accessory) {
      const stray = this.accessory.getService(this.platform.Service.TemperatureSensor);
      if (stray) {
        this.accessory.removeService(stray);
      }
    }

    const existing = host.getService(this.platform.Service.TemperatureSensor);

    if (!this.hasOutdoorReading()) {
      if (existing) {
        host.removeService(existing);
      }
      this.platform.log.info(`${this.accessory.displayName}: no outdoor temperature reading.`);
      return;
    }

    const service = existing ?? host.addService(this.platform.Service.TemperatureSensor);
    this.nameService(host, service, 'outdoor', `${this.accessory.displayName} Outdoor`);
    service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getOutdoorTemperature.bind(this));

    // Deliberately NOT linked to the HeaterCooler, unlike the filter. A linked
    // service reads as part of the control it hangs off; this is an independent
    // measurement, and it is more useful as a tile of its own.

    // Only now is there something worth showing, so this is where an accessory
    // of its own reaches HomeKit — including units that only start reporting a
    // reading hours into a run.
    this.outdoor?.publish();

    this.platform.log.info(
      `${this.accessory.displayName}: outdoor temperature available `
      + `(${this.status.outdoorTemperature}°C)${this.outdoor ? ', as an accessory of its own' : ''}`
      + `${this.platform.settings.hideOutdoorTemperatureWhenOff ? ', hidden while the unit is off' : ''}.`,
    );
  }

  /**
   * The switches the user asked for, in two groups: the unit's convenience mode
   * (`Comode`, where WindFree lives) and the modes `HeaterCooler` cannot
   * express (`Dry`, `Wind`).
   *
   * Both are empty by default. The unit publishes the value each field holds
   * but never the values it would ACCEPT — the reference unit takes six
   * convenience modes while reporting `Off` — so there is nothing to detect
   * from, and a guessed default would leave switches that cannot work on a
   * model whose vocabulary differs. `probe writes` is how a name gets confirmed.
   */
  private modeSwitchSpecs(): ModeSwitch[] {
    const specs: ModeSwitch[] = [];

    for (const name of this.platform.settings.convenienceModes) {
      specs.push({
        subtype: `${switchSubtypes.comode}${name.toLowerCase()}`,
        group: 'comode',
        label: labelFor(name),
        available: (status) => typeof status.comode === 'string' && status.comode.length > 0,
        isOn: (status) => status.comode?.toLowerCase() === name.toLowerCase(),
        // Off is the one value every unit that has the field agrees on: it is
        // what it reports when nothing is running.
        write: (on) => () => this.adapter.setComode(on ? name : comodeOff),
      });
    }

    for (const name of this.platform.settings.modeSwitches) {
      specs.push({
        subtype: `${switchSubtypes.mode}${name.toLowerCase()}`,
        group: 'mode',
        label: labelFor(name),
        available: (status) => status.mode.length > 0,
        isOn: (status) => status.mode.toLowerCase() === name.toLowerCase(),
        write: (on) => {
          if (on) {
            return () => this.adapter.setMode(this.deviceModeNamed(name.toLowerCase()));
          }
          const back = this.modeToReturnTo();
          return back ? () => this.adapter.setMode(back) : null;
        },
      });
    }

    return specs;
  }

  /**
   * Where to put the unit when a mode switch is turned off. There is no "no
   * mode" on this hardware — it is always in one — so off means going back to
   * whatever it was doing before, and failing that to something HomeKit can
   * drive from the tile.
   */
  private modeToReturnTo(): string | null {
    if (this.lastPlainMode) {
      return this.lastPlainMode;
    }
    for (const wanted of ['cool', 'auto', 'heat']) {
      const found = this.status.supportedModes.find((mode) => mode.toLowerCase() === wanted);
      if (found) {
        return found;
      }
    }
    return null;
  }

  private modeSwitchService(spec: ModeSwitch): Service | undefined {
    return this.accessory.getServiceById(this.platform.Service.Switch, spec.subtype);
  }

  private configureModeSwitches(): void {
    const specs = this.modeSwitchSpecs();
    const wanted = new Set(specs.map((spec) => spec.subtype));

    // A cached accessory can still carry switches from an earlier config. The
    // ones the user has since dropped have to go, or they sit in the Home app
    // forever as tiles that no longer control anything — and only ours are
    // touched, hence the subtype prefixes.
    for (const service of [...this.accessory.services]) {
      const subtype = service.subtype ?? '';
      const ours = subtype.startsWith(switchSubtypes.comode) || subtype.startsWith(switchSubtypes.mode);
      if (service.UUID === this.platform.Service.Switch.UUID && ours && !wanted.has(subtype)) {
        this.platform.log.info(`${this.accessory.displayName}: removing the switch for '${subtype}'.`);
        this.accessory.removeService(service);
      }
    }

    this.modeSwitches = [];

    for (const spec of specs) {
      if (!spec.available(this.status)) {
        // Same rule as every other service here: nothing is published until the
        // unit has actually reported the field it would be driving.
        this.platform.log.info(
          `${this.accessory.displayName}: not publishing a ${spec.label} switch; `
          + 'the unit reports nothing for it yet.',
        );
        continue;
      }

      const name = `${this.accessory.displayName} ${spec.label}`;
      const service = this.modeSwitchService(spec)
        ?? this.accessory.addService(this.platform.Service.Switch, name, spec.subtype);
      this.nameService(this.accessory, service, spec.subtype, name);
      service.getCharacteristic(this.platform.Characteristic.On)
        .onGet(() => this.getModeSwitch(spec))
        .onSet((value) => this.setModeSwitch(spec, value));

      // Linked, like the filter: these belong to the air conditioner rather
      // than standing on their own.
      this.service.addLinkedService(service);
      this.modeSwitches.push(spec);
    }

    if (this.modeSwitches.length) {
      this.platform.log.info(
        `${this.accessory.displayName}: switches for `
        + `${this.modeSwitches.map((spec) => spec.label).join(', ')}.`,
      );
    }
  }

  /**
   * Some units only publish a reading once they are running, so a restart while
   * the AC was off would otherwise hide a capability until the next restart.
   * Promote absent -> present when a reading finally shows up.
   *
   * Deliberately one-way: nothing is withdrawn here. An intermittent reading
   * would make the service flap, and every change re-announces the accessory's
   * configuration to HomeKit.
   */
  private adoptLateCapabilities(): void {
    if (!this.configured) {
      return;
    }

    if (this.speedStep === 0 && this.hasFanReading()) {
      this.platform.log.info(`${this.accessory.displayName}: fan speed is now reported by the unit.`);
      this.configureFanSpeed();
    }

    // A unit that starts advertising Heat, or that only publishes WarmCapa once
    // it has run, must gain the control rather than wait for a restart.
    if (!this.offersHeat && this.supportsHeat()) {
      this.platform.log.info(`${this.accessory.displayName}: heat is now reported by the unit.`);
      this.configureTargetStates();
    }

    if (!this.findCharacteristic(this.platform.Characteristic.SwingMode) && this.hasSwingReading()) {
      this.platform.log.info(`${this.accessory.displayName}: swing is now reported by the unit.`);
      this.configureSwing();
    }

    const filter = this.accessory.getService(this.platform.Service.FilterMaintenance);
    if (!filter && this.hasFilterReading()) {
      this.platform.log.info(`${this.accessory.displayName}: filter status is now reported by the unit.`);
      this.configureFilter();
    } else if (
      filter
      && this.hasFilterLifeReading()
      && !this.findCharacteristic(this.platform.Characteristic.FilterLifeLevel, filter)
    ) {
      this.platform.log.info(`${this.accessory.displayName}: the filter's hours are now reported by the unit.`);
      this.configureFilter();
    }

    if (!this.outdoorService() && this.hasOutdoorReading()) {
      this.platform.log.info(
        `${this.accessory.displayName}: an outdoor temperature is now reported by the unit.`,
      );
      this.configureOutdoorSensor();
    }

    // A unit that publishes no convenience mode until it has run would
    // otherwise keep its switches hidden until the next restart.
    const publishable = this.modeSwitchSpecs().filter((spec) => spec.available(this.status)).length;
    if (publishable > this.modeSwitches.length) {
      this.platform.log.info(
        `${this.accessory.displayName}: a mode the unit had not reported is now available.`,
      );
      this.configureModeSwitches();
    }
  }

  // --- reads ---------------------------------------------------------------

  /** Throw so HomeKit shows "No Response" rather than a value we don't trust. */
  private assertResponsive(): void {
    if (this.responsive) {
      return;
    }
    throw new this.platform.api.hap.HapStatusError(
      this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    );
  }

  private getActive(): CharacteristicValue {
    this.assertResponsive();
    return this.activeValue();
  }

  private activeValue(): CharacteristicValue {
    return this.status.active
      ? this.platform.Characteristic.Active.ACTIVE
      : this.platform.Characteristic.Active.INACTIVE;
  }

  private getCurrentTemperature(): CharacteristicValue {
    this.assertResponsive();
    return this.currentTemperature();
  }

  /** A measurement, not a setpoint: clamp to HomeKit's own bounds only. */
  private currentTemperature(): number {
    const frozen = this.platform.settings.freezeIndoorTemperatureWhenOff && !this.status.active
      ? this.rememberedIndoorTemperature()
      : undefined;
    // Falling back to the live reading matters on a Homebridge started with the
    // unit already off and nothing remembered yet: a doubtful figure still beats
    // the minimum of the range, which is what an unusable value reports as.
    const value = frozen ?? this.status.currentTemperature;

    if (!Number.isFinite(value)) {
      return this.minTemp;
    }
    return Math.max(-270, Math.min(100, value));
  }

  /**
   * The last room temperature read while the unit was running, or undefined if
   * it has not run since this accessory was first seen.
   *
   * Kept in the accessory context, which Homebridge persists with the cached
   * accessory: restarting while the unit is off would otherwise drop the frozen
   * value and fall straight back to the reading the user asked us not to trust.
   */
  private rememberedIndoorTemperature(): number | undefined {
    const context = this.accessory.context as { lastRunningIndoorTemperature?: number };
    const value = context.lastRunningIndoorTemperature;
    return Number.isFinite(value) ? value : undefined;
  }

  /**
   * Recorded on every poll regardless of the setting, so turning it on has
   * something to freeze at straight away rather than after the next run.
   */
  private rememberIndoorTemperature(): void {
    if (!this.status.active) {
      return;
    }
    const value = this.status.currentTemperature;
    if (!Number.isFinite(value)) {
      return;
    }
    (this.accessory.context as { lastRunningIndoorTemperature?: number })
      .lastRunningIndoorTemperature = value;
  }

  private getCoolingThreshold(): CharacteristicValue {
    this.assertResponsive();
    return this.coolingThreshold();
  }

  private coolingThreshold(): number {
    return clamp(this.status.targetTemperature, this.minTemp, this.maxTemp, this.minTemp);
  }

  private getHeatingThreshold(): CharacteristicValue {
    this.assertResponsive();
    return this.heatingThreshold();
  }

  private heatingThreshold(): number {
    return clamp(
      this.status.targetTemperature,
      Math.max(hapHeatingThresholdMin, this.minTemp),
      Math.min(hapHeatingThresholdMax, this.maxTemp),
      Math.max(hapHeatingThresholdMin, this.minTemp),
    );
  }

  private getTargetState(): CharacteristicValue {
    this.assertResponsive();
    return this.targetState();
  }

  private targetState(): CharacteristicValue {
    const mode = this.status.mode.toLowerCase();
    if (mode === 'cool') {
      return TargetState.COOL;
    }
    if (mode === 'heat') {
      return TargetState.HEAT;
    }
    if (mode !== 'auto' && !nonThermalModes.includes(mode)) {
      this.platform.log.debug(`${this.accessory.displayName}: unknown mode '${this.status.mode}', reporting AUTO.`);
    }
    return TargetState.AUTO;
  }

  private getCurrentState(): CharacteristicValue {
    this.assertResponsive();
    return this.currentState();
  }

  private currentState(): CharacteristicValue {
    if (!this.status.active) {
      return CurrentState.INACTIVE;
    }

    const mode = this.status.mode.toLowerCase();
    if (mode === 'cool') {
      return CurrentState.COOLING;
    }
    if (mode === 'heat') {
      return CurrentState.HEATING;
    }
    if (nonThermalModes.includes(mode)) {
      // Running, but not driving towards a setpoint.
      return CurrentState.IDLE;
    }

    const current = this.status.currentTemperature;
    const target = this.status.targetTemperature;
    if (!Number.isFinite(current) || !Number.isFinite(target)) {
      return CurrentState.IDLE;
    }
    if (current > target + autoModeDeadBand) {
      return CurrentState.COOLING;
    }
    if (current < target - autoModeDeadBand) {
      return CurrentState.HEATING;
    }
    return CurrentState.IDLE;
  }

  private getRotationSpeed(): CharacteristicValue {
    this.assertResponsive();
    return this.rotationSpeed();
  }

  private rotationSpeed(): number {
    const level = this.status.speedLevel;
    if (!Number.isFinite(level) || this.speedStep === 0) {
      return 0;
    }
    return Math.min(this.maxSpeedLevel, Math.max(0, level as number)) * this.speedStep;
  }

  private getSwingMode(): CharacteristicValue {
    this.assertResponsive();
    return this.swingMode();
  }

  private swingMode(): CharacteristicValue {
    return this.status.windDirection && this.status.windDirection !== swingOffDirection
      ? this.platform.Characteristic.SwingMode.SWING_ENABLED
      : this.platform.Characteristic.SwingMode.SWING_DISABLED;
  }

  private getOutdoorTemperature(): CharacteristicValue {
    this.assertResponsive();

    const value = this.status.outdoorTemperature;
    if (!Number.isFinite(value) || this.outdoorReadingSuppressed()) {
      // The service is only published once a reading exists, so losing one means
      // the unit stopped reporting it. "No Response" beats inventing a value —
      // and the service is never withdrawn, in case it comes back. A reading
      // the user has told us not to trust with the unit off is treated the same
      // way: there is no "unknown" to report in HomeKit, so the tile goes
      // unresponsive rather than showing a figure nothing measured.
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
    return Math.max(-270, Math.min(100, value as number));
  }

  private getFilterLife(): CharacteristicValue {
    this.assertResponsive();
    return this.filterLife();
  }

  /** 100 rather than 0 when unknown: an invented "replace me now" is worse. */
  private filterLife(): number {
    return Number.isFinite(this.status.filterLife) ? this.status.filterLife as number : 100;
  }

  private getModeSwitch(spec: ModeSwitch): CharacteristicValue {
    this.assertResponsive();
    return spec.isOn(this.status);
  }

  private getFilterChange(): CharacteristicValue {
    this.assertResponsive();
    return this.filterChange();
  }

  private filterChange(): CharacteristicValue {
    return this.status.filterAlarm
      ? this.platform.Characteristic.FilterChangeIndication.CHANGE_FILTER
      : this.platform.Characteristic.FilterChangeIndication.FILTER_OK;
  }

  // --- writes --------------------------------------------------------------

  private async setActive(value: CharacteristicValue): Promise<void> {
    const on = value === this.platform.Characteristic.Active.ACTIVE;
    this.platform.log.debug(`${this.accessory.displayName}: HomeKit asked for power ${on ? 'on' : 'off'}.`);
    await this.apply(() => this.adapter.setPower(on));
  }

  private async setTargetState(value: CharacteristicValue): Promise<void> {
    const mode = this.toDeviceMode(value);
    this.platform.log.debug(
      `${this.accessory.displayName}: HomeKit asked for target state ${value} `
      + `(mode ${mode === null ? 'unchanged' : `'${mode}'`}).`,
    );
    if (mode === null) {
      // The unit is in a mode we represent as AUTO (dry or wind). Sending
      // 'Auto' would kick it out of a mode the user chose in the Samsung app.
      this.platform.log.debug(
        `${this.accessory.displayName}: keeping mode '${this.status.mode}' for HomeKit AUTO.`,
      );
      return;
    }
    await this.apply(() => this.adapter.setMode(mode));
  }

  /**
   * @returns the device mode to write, or null when the unit is already in a
   * mode this accessory represents as the requested HomeKit state.
   */
  private toDeviceMode(value: CharacteristicValue): string | null {
    switch (value) {
    case TargetState.COOL:
      return this.deviceModeNamed('cool');
    case TargetState.HEAT:
      return this.deviceModeNamed('heat');
    case TargetState.AUTO:
      return nonThermalModes.includes(this.status.mode.toLowerCase()) ? null : this.deviceModeNamed('auto');
    default:
      this.platform.log.warn(`${this.accessory.displayName}: unexpected target state ${value}.`);
      return null;
    }
  }

  /** Match the unit's own casing — it reports 'Cool', not 'cool'. */
  private deviceModeNamed(mode: string): string {
    return this.status.supportedModes.find((candidate) => candidate.toLowerCase() === mode)
      ?? mode.charAt(0).toUpperCase() + mode.slice(1);
  }

  private async setTargetTemperature(value: CharacteristicValue): Promise<void> {
    // Snap to the step advertised in applySetpointRange, not to a whole degree:
    // on a Fahrenheit unit that grid is 0.5 °C, and rounding to 1 °C here would
    // throw away half the setpoints the unit can actually hold.
    const clamped = clamp(value as number, this.minTemp, this.maxTemp, this.minTemp);
    const temperature = Math.round(clamped / this.setpointStep) * this.setpointStep;
    this.platform.log.debug(
      `${this.accessory.displayName}: HomeKit asked for ${value}°C, sending ${temperature}°C.`,
    );
    await this.apply(() => this.adapter.setTargetTemperature(temperature, this.status.temperatureId));
  }

  private async setRotationSpeed(value: CharacteristicValue): Promise<void> {
    if (this.speedStep === 0) {
      this.platform.log.debug(`${this.accessory.displayName}: ignoring a fan speed write; no fan reading.`);
      return;
    }
    const level = Math.max(0, Math.min(this.maxSpeedLevel, Math.round((value as number) / this.speedStep)));
    this.platform.log.debug(
      `${this.accessory.displayName}: HomeKit asked for ${value}% fan, sending level ${level}/${this.maxSpeedLevel}.`,
    );
    await this.apply(() => this.adapter.setSpeedLevel(level));
  }

  private async setSwingMode(value: CharacteristicValue): Promise<void> {
    const direction = value === this.platform.Characteristic.SwingMode.SWING_ENABLED
      ? this.platform.settings.swingDirection
      : swingOffDirection;
    this.platform.log.debug(
      `${this.accessory.displayName}: HomeKit asked for swing `
      + `${value === this.platform.Characteristic.SwingMode.SWING_ENABLED ? 'on' : 'off'}, `
      + `sending direction '${direction}'.`,
    );
    await this.apply(() => this.adapter.setWindDirection(direction));
  }

  private async setModeSwitch(spec: ModeSwitch, value: CharacteristicValue): Promise<void> {
    const on = value === true;
    this.platform.log.debug(
      `${this.accessory.displayName}: HomeKit asked for ${spec.label} ${on ? 'on' : 'off'}.`,
    );

    if (on) {
      // The unit holds one of these at a time, so the others are already on
      // their way off — say so now rather than leaving two tiles reading on for
      // the second and a half it takes to write and read back. If the unit then
      // refuses the change, the read-back puts them back where they were.
      this.excludeSiblings(spec);
    } else if (!spec.isOn(this.status)) {
      // Switching off something that is not on must not touch the unit. A
      // scene that turns every switch in the group off would otherwise send one
      // write per switch, and each of them would cancel the mode a later switch
      // in the same scene had just set.
      this.platform.log.debug(
        `${this.accessory.displayName}: ${spec.label} is already off; sending nothing.`,
      );
      this.push();
      return;
    }

    const write = spec.write(on);
    if (!write) {
      // Nothing to send: the unit is always in some mode, and we have nothing
      // to put it back to. Push so the switch returns to what the unit says
      // rather than sitting on a state that was never applied.
      this.platform.log.debug(
        `${this.accessory.displayName}: nothing to send for ${spec.label} off; `
        + 'the unit reports no other mode to return to.',
      );
      this.push();
      return;
    }

    await this.apply(write);
  }

  /** Every other switch backed by the same field reads off, immediately. */
  private excludeSiblings(spec: ModeSwitch): void {
    for (const other of this.modeSwitches) {
      if (other.subtype === spec.subtype || other.group !== spec.group) {
        continue;
      }
      this.modeSwitchService(other)
        ?.updateCharacteristic(this.platform.Characteristic.On, false);
    }
  }

  /**
   * Run a write and adopt whatever the unit reports afterwards.
   *
   * The adapter has already confirmed the change by reading back; if it was not
   * applied, pushing the real status here is what makes the Home app tile snap
   * back instead of showing a value the unit never took.
   */
  private async apply(write: () => Promise<ApplyResult>): Promise<void> {
    try {
      const result = await write();
      this.status = result.status;
      this.markResponsive();
      this.adoptLateCapabilities();
      this.push();
    } catch (error) {
      this.platform.log.error(`${this.accessory.displayName}: write failed: ${messageOf(error)}`);
      // Let the next poll decide whether the unit is really gone.
      await this.updateStatus();
    }
  }

  // --- polling -------------------------------------------------------------

  private async updateStatus(): Promise<void> {
    try {
      this.status = await this.adapter.getStatus();
      this.markResponsive();
      this.adoptLateCapabilities();
      this.push();
    } catch (error) {
      this.markUnresponsive(messageOf(error));
    }
  }

  /**
   * An outage is worth one warn and one info when it clears — enough to see in
   * a normal log that a unit dropped out overnight, without a line per poll.
   */
  private markResponsive(): void {
    if (!this.responsive && this.loggedOffline) {
      this.platform.log.info(`${this.accessory.displayName}: responding again.`);
    }
    this.responsive = true;
    this.loggedOffline = false;
  }

  private markUnresponsive(reason: string): void {
    this.responsive = false;

    if (this.loggedOffline) {
      this.platform.log.debug(`${this.accessory.displayName}: still not responding: ${reason}`);
      return;
    }

    this.loggedOffline = true;
    this.platform.log.warn(
      `${this.accessory.displayName}: not responding (${reason}). `
      + 'HomeKit will show "No Response" until it answers again.',
    );
  }

  /**
   * Push rather than wait to be asked: a change made with the remote or the
   * Samsung app otherwise never reaches the Home app.
   */
  private push(): void {
    this.rememberPlainMode();
    // Before anything reads currentTemperature() below: while the unit runs,
    // what is remembered is what gets pushed.
    this.rememberIndoorTemperature();

    if (!this.responsive) {
      return;
    }

    try {
      this.service.updateCharacteristic(this.platform.Characteristic.Active, this.activeValue());
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.currentTemperature());
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState, this.currentState());
      this.service.updateCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState, this.targetState());
      this.service.updateCharacteristic(
        this.platform.Characteristic.CoolingThresholdTemperature, this.coolingThreshold());
      this.service.updateCharacteristic(
        this.platform.Characteristic.HeatingThresholdTemperature, this.heatingThreshold());

      if (this.speedStep > 0) {
        this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, this.rotationSpeed());
      }
      if (this.findCharacteristic(this.platform.Characteristic.SwingMode)) {
        this.service.updateCharacteristic(this.platform.Characteristic.SwingMode, this.swingMode());
      }

      const filter = this.accessory.getService(this.platform.Service.FilterMaintenance);
      filter?.updateCharacteristic(this.platform.Characteristic.FilterChangeIndication, this.filterChange());
      if (filter && this.hasFilterLifeReading()) {
        filter.updateCharacteristic(this.platform.Characteristic.FilterLifeLevel, this.filterLife());
      }

      const outdoor = this.outdoorService();
      if (outdoor && this.hasOutdoorReading()) {
        // Pushing the error is what moves the tile to "No Response" without
        // waiting for HomeKit to ask; a plain value would leave the stale one
        // on screen until it did. Separate calls rather than one with a union:
        // updateCharacteristic overloads a value and an error, not both at once.
        if (this.outdoorReadingSuppressed()) {
          outdoor.updateCharacteristic(
            this.platform.Characteristic.CurrentTemperature,
            new this.platform.api.hap.HapStatusError(
              this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE),
          );
        } else {
          outdoor.updateCharacteristic(
            this.platform.Characteristic.CurrentTemperature, this.status.outdoorTemperature as number);
        }
      }

      // Every switch in a group reads the same field, so one change moves all
      // of them: this is what makes turning Quiet on turn Comfort off in the
      // Home app, and what reflects a change made on the remote.
      for (const spec of this.modeSwitches) {
        this.modeSwitchService(spec)
          ?.updateCharacteristic(this.platform.Characteristic.On, spec.isOn(this.status));
      }
    } catch (error) {
      this.platform.log.error(`${this.accessory.displayName}: could not update HomeKit: ${messageOf(error)}`);
    }
  }

  /**
   * Remember the mode to return to when a mode switch is switched off, taking
   * it from the poll rather than only from our own writes — the unit may have
   * been put into Dry from the Samsung app, and "off" still has to mean
   * something sensible then.
   */
  private rememberPlainMode(): void {
    const mode = this.status.mode;
    if (!mode) {
      return;
    }
    const stoodFor = this.platform.settings.modeSwitches
      .some((name) => name.toLowerCase() === mode.toLowerCase());
    if (!stoodFor) {
      this.lastPlainMode = mode;
    }
  }

  /**
   * Give a service a name of its own in the Home app.
   *
   * `Name` alone does not do it: the Home app shows the ACCESSORY's name for
   * every service hanging off it, which is how two switches on one air
   * conditioner both end up reading "Climatiseur". `ConfiguredName` is the one
   * it reads.
   *
   * It is also writable, so renaming the tile in the Home app comes back here
   * as a write. That name is kept in the accessory's context and used in place
   * of ours from then on — otherwise the next restart would quietly undo the
   * user's rename.
   */
  private nameService(host: PlatformAccessory, service: Service, key: string, fallback: string): void {
    const names = serviceNamesOf(host);
    const name = names[key] ?? fallback;

    service.setCharacteristic(this.platform.Characteristic.Name, name);
    service.addOptionalCharacteristic(this.platform.Characteristic.ConfiguredName);
    service.getCharacteristic(this.platform.Characteristic.ConfiguredName)
      .updateValue(name)
      .onSet((value) => {
        const chosen = String(value).trim();
        if (!chosen || chosen === names[key]) {
          return;
        }
        names[key] = chosen;
        this.platform.api.updatePlatformAccessories([host]);
        this.platform.log.info(`${this.accessory.displayName}: '${fallback}' renamed to '${chosen}'.`);
      });
  }

  // --- helpers -------------------------------------------------------------

  /** Look a characteristic up WITHOUT the add-on-first-access that HAP does. */
  private findCharacteristic(
    type: WithUUID<new () => Characteristic>,
    service: Service = this.service,
  ): Characteristic | undefined {
    return service.characteristics.find((candidate) => candidate.UUID === type.UUID);
  }

  /**
   * Drop an optional characteristic a cached accessory may still carry from an
   * earlier plugin version; `getCharacteristic` would add it straight back.
   */
  private removeCharacteristicIfPresent(
    type: WithUUID<new () => Characteristic>,
    service: Service = this.service,
  ): void {
    const existing = this.findCharacteristic(type, service);
    if (existing) {
      service.removeCharacteristic(existing);
    }
  }
}

/**
 * Names the user gave this accessory's services in the Home app, kept in the
 * accessory context so they survive a restart. Homebridge persists the context
 * with the cached accessory.
 */
function serviceNamesOf(accessory: PlatformAccessory): Record<string, string> {
  const context = accessory.context as { serviceNames?: Record<string, string> };
  context.serviceNames ??= {};
  return context.serviceNames;
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, value));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyStatus(): RacStatus {
  return {
    active: false,
    mode: '',
    supportedModes: [],
    currentTemperature: NaN,
    targetTemperature: NaN,
    filterAlarm: false,
    resources: [],
    options: {},
    connected: false,
    id: '0',
    temperatureId: '0',
    // Celsius until a real reading says otherwise; nothing is published from
    // this placeholder anyway, the accessory reports "No Response" instead.
    temperatureUnit: 'C',
  };
}
