// Narrow Win32 companion. Build with MSVC /std:c++17 /EHsc /MT.
// No UAC elevation, no network, and no credential values on command lines.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <wincrypt.h>
#include <aclapi.h>
#include <sddl.h>
#include <string>
#include <vector>
#include <stdexcept>
#include <iostream>
#include <thread>
#include <filesystem>
#include <fcntl.h>
#include <io.h>
#pragma comment(lib, "crypt32.lib")
#pragma comment(lib, "advapi32.lib")

struct Handle {
  HANDLE h = nullptr;
  explicit Handle(HANDLE value = nullptr) : h(value) {}
  ~Handle() { if (h && h != INVALID_HANDLE_VALUE) CloseHandle(h); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
};
static void check(bool ok) { if (!ok) throw std::runtime_error("Win32 operation failed (" + std::to_string(GetLastError()) + ")"); }
static std::string readInput() {
  std::string data; char buffer[8192]; DWORD read;
  while (ReadFile(GetStdHandle(STD_INPUT_HANDLE), buffer, sizeof(buffer), &read, nullptr) && read) {
    data.append(buffer, read);
    if (data.size() > 2 * 1024 * 1024) throw std::runtime_error("Input too large");
  }
  return data;
}
static void writeOutput(const BYTE* bytes, DWORD size) {
  while (size) { DWORD written = 0; check(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), bytes, size, &written, nullptr) && written); bytes += written; size -= written; }
}
static std::wstring utf16(const std::string& s) {
  int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s.data(), (int)s.size(), nullptr, 0);
  check(n > 0); std::wstring out(n, L'\0');
  check(MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s.data(), (int)s.size(), out.data(), n) == n);
  if (out.find(L'\0') != std::wstring::npos) throw std::runtime_error("NUL in path");
  return out;
}
static void protectDirectory(const std::wstring& name, bool directory = true) {
  namespace fs = std::filesystem;
  fs::path path(name);
  if (!path.is_absolute() || name.rfind(L"\\\\", 0) == 0 || name.find(L':', 2) != std::wstring::npos || path == path.root_path()) throw std::runtime_error("Expected a local, non-root absolute directory");
  // Reject all existing reparse-point ancestors, not just the final component.
  for (fs::path p = path; !p.empty(); p = p.parent_path()) {
    DWORD attrs = GetFileAttributesW(p.c_str());
    if (attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_REPARSE_POINT)) throw std::runtime_error("Reparse point in private directory path");
    if (p == p.root_path()) break;
  }
  Handle token; check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.h));
  DWORD size = 0; GetTokenInformation(token.h, TokenUser, nullptr, 0, &size);
  std::vector<BYTE> user(size); check(GetTokenInformation(token.h, TokenUser, user.data(), size, &size));
  auto sid = reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid;
  LPWSTR sidText = nullptr; check(ConvertSidToStringSidW(sid, &sidText));
  std::wstring sddl = L"O:" + std::wstring(sidText) + L"D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;" + std::wstring(sidText) + L")";
  LocalFree(sidText);
  PSECURITY_DESCRIPTOR sd = nullptr; check(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &sd, nullptr));
  try {
    SECURITY_ATTRIBUTES sa{sizeof(sa), sd, FALSE};
    // Create each missing component with a restricted descriptor from inception.
    fs::path current = path.root_path();
    for (const auto& part : (directory ? path : path.parent_path()).relative_path()) {
      if (part == L".." || part == L".") throw std::runtime_error("Non-canonical private path");
      current /= part;
      if (!CreateDirectoryW(current.c_str(), &sa) && GetLastError() != ERROR_ALREADY_EXISTS) check(false);
      DWORD attrs = GetFileAttributesW(current.c_str());
      check(attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY) && !(attrs & FILE_ATTRIBUTE_REPARSE_POINT));
    }
    DWORD finalAttrs = GetFileAttributesW(name.c_str());
    check(finalAttrs != INVALID_FILE_ATTRIBUTES && !(finalAttrs & FILE_ATTRIBUTE_REPARSE_POINT) && (!!(finalAttrs & FILE_ATTRIBUTE_DIRECTORY) == directory));
    // Never accept an arbitrary account's owner SID. Elevated Windows tokens may
    // create Node-written files with TokenOwner (e.g. BUILTIN\Administrators),
    // rather than TokenUser. Accept only this token's exact default owner for
    // files; helper-created private directories must still belong to TokenUser.
    PSID owner = nullptr; PSECURITY_DESCRIPTOR existing = nullptr;
    DWORD err = GetNamedSecurityInfoW(name.c_str(), SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION, &owner, nullptr, nullptr, nullptr, &existing);
    check(err == ERROR_SUCCESS);
    bool ours = EqualSid(sid, owner);
    if (!ours && !directory) {
      DWORD ownerSize = 0; GetTokenInformation(token.h, TokenOwner, nullptr, 0, &ownerSize);
      std::vector<BYTE> tokenOwner(ownerSize);
      if (!GetTokenInformation(token.h, TokenOwner, tokenOwner.data(), ownerSize, &ownerSize)) { LocalFree(existing); check(false); }
      ours = EqualSid(reinterpret_cast<TOKEN_OWNER*>(tokenOwner.data())->Owner, owner);
    }
    LocalFree(existing);
    if (!ours) throw std::runtime_error("Private directory is owned by a different account");
    PACL dacl = nullptr; BOOL present, defaulted;
    check(GetSecurityDescriptorDacl(sd, &present, &dacl, &defaulted));
    err = SetNamedSecurityInfoW(const_cast<LPWSTR>(name.c_str()), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, nullptr, nullptr, dacl, nullptr);
    if (err != ERROR_SUCCESS) throw std::runtime_error("Cannot restrict private directory DACL");
  } catch (...) { LocalFree(sd); throw; }
  LocalFree(sd);
}
static void crypt(bool encrypt) {
  auto data = readInput(); DATA_BLOB input{(DWORD)data.size(), reinterpret_cast<BYTE*>(data.data())}, output{};
  BOOL ok = encrypt ? CryptProtectData(&input, L"Pi Bot device credentials", nullptr, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &output)
                    : CryptUnprotectData(&input, nullptr, nullptr, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &output);
  SecureZeroMemory(data.data(), data.size()); check(ok);
  try { writeOutput(output.pbData, output.cbData); } catch (...) { SecureZeroMemory(output.pbData, output.cbData); LocalFree(output.pbData); throw; }
  SecureZeroMemory(output.pbData, output.cbData); LocalFree(output.pbData);
}
static std::wstring quote(const std::wstring& s) {
  std::wstring out = L"\""; size_t slashes = 0;
  for (wchar_t c : s) {
    if (c == L'\\') { ++slashes; continue; }
    out.append(c == L'"' ? slashes * 2 + 1 : slashes, L'\\'); slashes = 0; out += c;
  }
  out.append(slashes * 2, L'\\'); return out + L'"';
}
static int run(int argc, wchar_t** argv) {
  if (argc < 4) throw std::runtime_error("Missing shell/arguments");
  Handle job(CreateJobObjectW(nullptr, nullptr)); check(job.h != nullptr);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  check(SetInformationJobObject(job.h, JobObjectExtendedLimitInformation, &limits, sizeof(limits)));
  SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
  Handle nullInput(CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, nullptr));
  check(nullInput.h != INVALID_HANDLE_VALUE);
  Handle output, error;
  check(DuplicateHandle(GetCurrentProcess(), GetStdHandle(STD_OUTPUT_HANDLE), GetCurrentProcess(), &output.h, 0, TRUE, DUPLICATE_SAME_ACCESS));
  check(DuplicateHandle(GetCurrentProcess(), GetStdHandle(STD_ERROR_HANDLE), GetCurrentProcess(), &error.h, 0, TRUE, DUPLICATE_SAME_ACCESS));
  HANDLE inherit[] = {nullInput.h, output.h, error.h};
  SIZE_T attrSize = 0; InitializeProcThreadAttributeList(nullptr, 1, 0, &attrSize);
  std::vector<BYTE> attrs(attrSize);
  auto list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attrs.data());
  check(InitializeProcThreadAttributeList(list, 1, 0, &attrSize));
  if (!UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherit, sizeof(inherit), nullptr, nullptr)) { DeleteProcThreadAttributeList(list); check(false); }
  STARTUPINFOEXW si{}; si.StartupInfo.cb = sizeof(si); si.lpAttributeList = list;
  si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  si.StartupInfo.hStdInput = nullInput.h; si.StartupInfo.hStdOutput = output.h; si.StartupInfo.hStdError = error.h;
  std::wstring cmd;
  for (int i = 2; i < argc; ++i) { if (i > 2) cmd += L' '; cmd += quote(argv[i]); }
  PROCESS_INFORMATION pi{};
  BOOL created = CreateProcessW(argv[2], cmd.data(), nullptr, nullptr, TRUE, CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, nullptr, nullptr, &si.StartupInfo, &pi);
  DeleteProcThreadAttributeList(list); check(created);
  Handle process(pi.hProcess), thread(pi.hThread);
  if (!AssignProcessToJobObject(job.h, process.h)) { TerminateProcess(process.h, 125); WaitForSingleObject(process.h, INFINITE); check(false); }
  if (ResumeThread(thread.h) == (DWORD)-1) { TerminateJobObject(job.h, 125); check(false); }
  // The only lease is helper stdin. EOF on cancellation or parent death kills the entire job.
  // The handle list above deliberately excludes this pipe from descendant inheritance.
  std::thread([h = job.h] { char b[64]; DWORD n; while (ReadFile(GetStdHandle(STD_INPUT_HANDLE), b, sizeof(b), &n, nullptr) && n) {} TerminateJobObject(h, 124); }).detach();
  WaitForSingleObject(process.h, INFINITE);
  DWORD code = 125; check(GetExitCodeProcess(process.h, &code));
  // Kill any surviving descendants even if the shell exited normally.
  TerminateJobObject(job.h, code);
  return static_cast<int>(code);
}
int wmain(int argc, wchar_t** argv) {
  _setmode(_fileno(stdin), _O_BINARY); _setmode(_fileno(stdout), _O_BINARY);
  try {
    if (argc < 2) throw std::runtime_error("Missing operation");
    std::wstring op(argv[1]);
    if (op == L"run") return run(argc, argv);
    if (argc != 2) throw std::runtime_error("Unexpected arguments");
    if (op == L"protect-directory") protectDirectory(utf16(readInput()));
    else if (op == L"protect-file") protectDirectory(utf16(readInput()), false);
    else if (op == L"encrypt") crypt(true);
    else if (op == L"decrypt") crypt(false);
    else throw std::runtime_error("Unknown operation");
    return 0;
  } catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 125; }
}
