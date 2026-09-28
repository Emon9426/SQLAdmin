import { ConnectionType, IDbDriver, ConnectionConfig } from './types';

type DriverFactory = (cfg: ConnectionConfig) => IDbDriver;

const factories = new Map<ConnectionType, DriverFactory>();

export function registerDriver(type: ConnectionType, factory: DriverFactory): void {
  factories.set(type, factory);
}

export function createDriver(cfg: ConnectionConfig): IDbDriver {
  const factory = factories.get(cfg.type);
  if (!factory) {
    throw new Error(`未注册的连接类型: ${cfg.type}`);
  }
  return factory(cfg);
}

export function registeredTypes(): ConnectionType[] {
  return [...factories.keys()];
}
