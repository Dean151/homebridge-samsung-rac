/**
 * The name under which the platform is registered, and which users put in the
 * `platform` key of their Homebridge config.
 */
export const PLATFORM_NAME = 'SamsungRacLocal';

/** Must match the `name` field in package.json. */
export const PLUGIN_NAME = 'homebridge-samsung-rac';

/** The AC's local REST API always lives here. */
export const DEVICE_API_PORT = 8888;

/**
 * The port the AC calls *back* on during the token pairing ritual. Not
 * configurable: the AC decides where to connect.
 */
export const PAIRING_CALLBACK_PORT = 8889;
