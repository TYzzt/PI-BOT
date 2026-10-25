// Backward-compatible entry point. The optional controller is independently packageable;
// Pi Bot still owns user authentication, node routing and executor suspension hooks.
export { PhoneController, phoneEvent, PhoneAdb, isPhoneAdbCommand } from '../../../../extras/virtual-phone/src/index.js';
