USER_SECURITY = {"security": [{"UserBearer": []}]}
DEVICE_SECURITY = {"security": [{"DeviceId": [], "DeviceTimestamp": [], "DeviceNonce": [], "DeviceSignature": []}]}
MIXED_SECURITY = {"security": [USER_SECURITY["security"][0], DEVICE_SECURITY["security"][0]]}

SECURITY_SCHEMES = {
    "UserBearer": {"type": "http", "scheme": "bearer", "bearerFormat": "JWT"},
    "DeviceId": {"type": "apiKey", "in": "header", "name": "X-TAgnet-Device-Id"},
    "DeviceTimestamp": {"type": "apiKey", "in": "header", "name": "X-TAgnet-Timestamp"},
    "DeviceNonce": {"type": "apiKey", "in": "header", "name": "X-TAgnet-Nonce"},
    "DeviceSignature": {"type": "apiKey", "in": "header", "name": "X-TAgnet-Signature"},
}
