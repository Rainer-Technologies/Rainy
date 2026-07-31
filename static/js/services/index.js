// Service base class lives in base.js so services can extend it without
// circular imports (this index re-exports concrete services like Connect).
export { Service } from './base.js';

export { ConnectService, useConnectService } from './connect.js';
