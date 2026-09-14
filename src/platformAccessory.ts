import type { Characteristic, CharacteristicValue, PlatformAccessory, Service, WithUUID } from 'homebridge';
import type { SamsungRacPlatform } from './platform';
import type { ApplyResult, DeviceAdapter } from './deviceAdapter';
import type { RacStatus } from './racStatus';

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
  private speedStep = 0;
  private maxSpeedLevel = 0;
  private loggedHeatingCap = false;

  static async create(
    platform: SamsungRacPlatform,
    accessory: PlatformAccessory,
    adapter: DeviceAdapter,
  ): Promise<SamsungRacAccessory> {
    const instance = new SamsungRacAccessory(platform, accessory, adapter);
    await instance.initialize();
    return instance;
  }

  private constructor(
    private readonly platform: SamsungRacPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly adapter: DeviceAdapter,
  ) {
    this.status = emptyStatus();

    const context = this.accessory.context as { model?: string; uuid?: string };

    this.accessory.getService(this.platform.Service.AccessoryInformation)
      ?.setCharacteristic(this.platform.Characteristic.Manufacturer, 'Samsung')
      .setCharacteristic(this.platform.Characteristic.Model, context.model ?? 'Room Air Conditioner')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, context.uuid ?? this.accessory.UUID);

    this.service = this.accessory.getService(this.platform.Service.HeaterCooler)
      || this.accessory.addService(this.platform.Service.HeaterCooler);
    this.service.setCharacteristic(this.platform.Characteristic.Name, this.accessory.displayName);

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

    this.service.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
      .setProps({ minValue: min, maxValue: max, minStep: 1 });

    const heatingMax = Math.min(hapHeatingThresholdMax, max);
    if (heatingMax < max && !this.loggedHeatingCap) {
      this.loggedHeatingCap = true;
      this.platform.log.info(
        `${this.accessory.displayName}: heating threshold capped at ${heatingMax}°C, which is all HomeKit allows.`,
      );
    }

    this.service.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
      .setProps({ minValue: Math.max(hapHeatingThresholdMin, min), maxValue: heatingMax, minStep: 1 });
  }

  /**
   * Only advertise the target states the unit actually supports. The reference
   * unit has no heat mode at all, and offering HEAT would give the user a
   * control that does nothing.
   */
  private configureTargetStates(): void {
    const supported = this.status.supportedModes.map((mode) => mode.toLowerCase());
    const values = new Set<number>();

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
    service.setCharacteristic(this.platform.Characteristic.Name, `${this.accessory.displayName} Filter`);
    service.getCharacteristic(this.platform.Characteristic.FilterChangeIndication)
      .onGet(this.getFilterChange.bind(this));
    this.service.addLinkedService(service);

    this.platform.log.info(`${this.accessory.displayName}: filter status available.`);
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

    if (!this.findCharacteristic(this.platform.Characteristic.SwingMode) && this.hasSwingReading()) {
      this.platform.log.info(`${this.accessory.displayName}: swing is now reported by the unit.`);
      this.configureSwing();
    }

    if (!this.accessory.getService(this.platform.Service.FilterMaintenance) && this.hasFilterReading()) {
      this.platform.log.info(`${this.accessory.displayName}: filter status is now reported by the unit.`);
      this.configureFilter();
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
    const value = this.status.currentTemperature;
    if (!Number.isFinite(value)) {
      return this.minTemp;
    }
    return Math.max(-270, Math.min(100, value));
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
    const temperature = Math.round(clamp(value as number, this.minTemp, this.maxTemp, this.minTemp));
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
    } catch (error) {
      this.platform.log.error(`${this.accessory.displayName}: could not update HomeKit: ${messageOf(error)}`);
    }
  }

  // --- helpers -------------------------------------------------------------

  /** Look a characteristic up WITHOUT the add-on-first-access that HAP does. */
  private findCharacteristic(type: WithUUID<new () => Characteristic>): Characteristic | undefined {
    return this.service.characteristics.find((candidate) => candidate.UUID === type.UUID);
  }

  /**
   * Drop an optional characteristic a cached accessory may still carry from an
   * earlier plugin version; `getCharacteristic` would add it straight back.
   */
  private removeCharacteristicIfPresent(type: WithUUID<new () => Characteristic>): void {
    const existing = this.findCharacteristic(type);
    if (existing) {
      this.service.removeCharacteristic(existing);
    }
  }
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
  };
}
