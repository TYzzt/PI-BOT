import Foundation
import Security
struct Request: Decodable { let operation: String; let account: String; let value: String?; let service: String }
func reply(_ data: [String: Any]) { let encoded = try! JSONSerialization.data(withJSONObject: data); FileHandle.standardOutput.write(encoded); FileHandle.standardOutput.write(Data([10])) }
// 允许本机任何程序读取。这样助手重新签名后，不会再要求输入登录钥匙串密码。
func openAccess() -> SecAccess? {
 var access: SecAccess?
 guard SecAccessCreate("T-AGNET" as CFString, [] as CFArray, &access) == errSecSuccess, let access else { return nil }
 var list: CFArray?
 guard SecAccessCopyACLList(access, &list) == errSecSuccess, let list else { return access }
 let prompt = SecKeychainPromptSelector(rawValue: 0x0020 | 0x0080)
 guard let acl = (list as NSArray).firstObject as! SecACL? else { return access }
 var apps: CFArray?
 var desc: CFString?
 var current = SecKeychainPromptSelector(rawValue: 0)
 if SecACLCopyContents(acl, &apps, &desc, &current) == errSecSuccess { SecACLSetContents(acl, nil, desc ?? "T-AGNET" as CFString, prompt) }
 return access
}
do {
 let request = try JSONDecoder().decode(Request.self, from: FileHandle.standardInput.readDataToEndOfFile())
 guard request.service.hasPrefix("dev.t-agnet."), UUID(uuidString: request.account) != nil else { throw NSError(domain: "invalid", code: 1) }
 let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: request.service, kSecAttrAccount as String: request.account]
 var status: OSStatus = errSecSuccess
 switch request.operation {
 case "get":
  var query = base; query[kSecReturnData as String] = true; query[kSecMatchLimit as String] = kSecMatchLimitOne
  var result: CFTypeRef?; status = SecItemCopyMatching(query as CFDictionary, &result)
  if status == errSecItemNotFound { reply(["value": NSNull()]); exit(0) }
  if status == errSecSuccess, let data = result as? Data { reply(["value": String(data: data, encoding: .utf8) ?? ""]); exit(0) }
 case "set":
  guard let value = request.value else { throw NSError(domain: "invalid", code: 2) }
  let attributes: [String: Any] = [kSecValueData as String: Data(value.utf8)]
  status = SecItemUpdate(base as CFDictionary, attributes as CFDictionary)
  if status == errSecItemNotFound {
   var item = base; item[kSecValueData as String] = Data(value.utf8)
   if let access = openAccess() { item[kSecAttrAccess as String] = access }
   status = SecItemAdd(item as CFDictionary, nil)
  }
 case "delete":
  status = SecItemDelete(base as CFDictionary); if status == errSecItemNotFound { status = errSecSuccess }
 default: throw NSError(domain: "invalid", code: 3)
 }
 if status == errSecSuccess { reply(["ok": true]) } else { reply(["error": "Keychain 操作失败 (\(status))"]); exit(1) }
} catch { reply(["error": "无效的 Keychain 请求"]); exit(1) }
