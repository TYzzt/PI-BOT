import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

export interface DeviceIdentity { privateKey: string; publicKey: string; }
export function newIdentity(): DeviceIdentity {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), publicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') };
}
export type Signer = (method: string, path: string, body: Buffer) => Record<string, string>;
export function signer(deviceId: string, privateKey: string): Signer {
  const key: KeyObject = createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  return (method, path, body) => {
    const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString('hex');
    const message = `${timestamp}.${nonce}.${method.toUpperCase()}.${path}.${createHash('sha256').update(body).digest('hex')}`;
    return { 'X-TAgnet-Device-Id': deviceId, 'X-TAgnet-Timestamp': timestamp, 'X-TAgnet-Nonce': nonce, 'X-TAgnet-Signature': sign(null, Buffer.from(message), key).toString('base64') };
  };
}
