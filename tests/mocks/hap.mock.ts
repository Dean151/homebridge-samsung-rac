/**
 * A stand-in for the parts of HAP the accessory touches.
 *
 * Services and characteristics keep their identity, so "was a FilterMaintenance
 * service added?" and "what props were set on RotationSpeed?" have answers.
 */

export interface CharacteristicClass {
  UUID: string;
  [constant: string]: unknown;
}

export interface ServiceClass {
  UUID: string;
}

function characteristic(name: string, constants: Record<string, number> = {}): CharacteristicClass {
  return { UUID: name, ...constants };
}

export const Characteristic = {
  Active: characteristic('Active', { INACTIVE: 0, ACTIVE: 1 }),
  Name: characteristic('Name'),
  Manufacturer: characteristic('Manufacturer'),
  Model: characteristic('Model'),
  SerialNumber: characteristic('SerialNumber'),
  CurrentTemperature: characteristic('CurrentTemperature'),
  CoolingThresholdTemperature: characteristic('CoolingThresholdTemperature'),
  HeatingThresholdTemperature: characteristic('HeatingThresholdTemperature'),
  TargetHeaterCoolerState: characteristic('TargetHeaterCoolerState', { AUTO: 0, HEAT: 1, COOL: 2 }),
  CurrentHeaterCoolerState: characteristic('CurrentHeaterCoolerState', {
    INACTIVE: 0, IDLE: 1, HEATING: 2, COOLING: 3,
  }),
  RotationSpeed: characteristic('RotationSpeed'),
  SwingMode: characteristic('SwingMode', { SWING_DISABLED: 0, SWING_ENABLED: 1 }),
  FilterChangeIndication: characteristic('FilterChangeIndication', { FILTER_OK: 0, CHANGE_FILTER: 1 }),
};

export const Service = {
  AccessoryInformation: { UUID: 'AccessoryInformation' } as ServiceClass,
  HeaterCooler: { UUID: 'HeaterCooler' } as ServiceClass,
  FilterMaintenance: { UUID: 'FilterMaintenance' } as ServiceClass,
};

export class FakeCharacteristic {
  public props: Record<string, unknown> = {};
  public value: unknown = undefined;
  public getHandler?: () => unknown;
  public setHandler?: (value: unknown) => unknown;

  constructor(public readonly UUID: string) {}

  setProps(props: Record<string, unknown>): this {
    Object.assign(this.props, props);
    return this;
  }

  onGet(handler: () => unknown): this {
    this.getHandler = handler;
    return this;
  }

  onSet(handler: (value: unknown) => unknown): this {
    this.setHandler = handler;
    return this;
  }

  updateValue(value: unknown): this {
    this.value = value;
    return this;
  }
}

export class FakeService {
  public characteristics: FakeCharacteristic[] = [];
  public linkedServices: FakeService[] = [];

  constructor(public readonly UUID: string) {}

  /** Real HAP adds an optional characteristic on first lookup; mirror that. */
  getCharacteristic(type: CharacteristicClass): FakeCharacteristic {
    const existing = this.findCharacteristic(type);
    if (existing) {
      return existing;
    }
    const created = new FakeCharacteristic(type.UUID);
    this.characteristics.push(created);
    return created;
  }

  /** Does NOT create — so "is it absent?" assertions stay meaningful. */
  findCharacteristic(type: CharacteristicClass): FakeCharacteristic | undefined {
    return this.characteristics.find((candidate) => candidate.UUID === type.UUID);
  }

  setCharacteristic(type: CharacteristicClass, value: unknown): this {
    this.getCharacteristic(type).value = value;
    return this;
  }

  updateCharacteristic(type: CharacteristicClass, value: unknown): this {
    this.getCharacteristic(type).value = value;
    return this;
  }

  removeCharacteristic(target: FakeCharacteristic): void {
    const index = this.characteristics.indexOf(target);
    if (index >= 0) {
      this.characteristics.splice(index, 1);
    }
  }

  addLinkedService(service: FakeService): void {
    if (!this.linkedServices.includes(service)) {
      this.linkedServices.push(service);
    }
  }
}

export class FakeAccessory {
  public services: FakeService[] = [];
  public context: Record<string, unknown> = {};

  constructor(public displayName = 'Test AC', public readonly UUID = 'test-uuid') {
    this.services.push(new FakeService(Service.AccessoryInformation.UUID));
  }

  getService(type: ServiceClass): FakeService | undefined {
    return this.services.find((service) => service.UUID === type.UUID);
  }

  addService(type: ServiceClass): FakeService {
    const service = new FakeService(type.UUID);
    this.services.push(service);
    return service;
  }

  removeService(target: FakeService): void {
    const index = this.services.indexOf(target);
    if (index >= 0) {
      this.services.splice(index, 1);
    }
  }
}

export class FakeHapStatusError extends Error {
  constructor(public readonly hapStatus: number) {
    super(`HapStatusError ${hapStatus}`);
  }
}

export const HAPStatus = { SERVICE_COMMUNICATION_FAILURE: -70402 };
