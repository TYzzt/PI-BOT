"""Prefetch Arduino ESP32 3.0.2 tool archives with SHA-256 verification."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import subprocess

root = Path.home() / 'Library/Arduino15'
package = json.loads((root / 'package_esp32_index.json').read_text())['packages'][0]
platform = next(p for p in package['platforms'] if p['version'] == '3.0.2')
jobs = [platform]
for dependency in platform['toolsDependencies']:
    tool = next((t for t in package['tools']
                 if t['name'] == dependency['name'] and t['version'] == dependency['version']), None)
    if tool is None:
        continue  # Arduino-owned dependencies are installed by arduino-cli.
    system = next((s for s in tool['systems'] if s['host'] == 'arm64-apple-darwin'), None)
    if system is None:
        system = next(s for s in tool['systems'] if s['host'] == 'x86_64-apple-darwin')
    jobs.append(system)


def fetch(job):
    target = root / 'staging/packages' / job['archiveFileName']
    target.parent.mkdir(parents=True, exist_ok=True)
    expected = job['checksum'].split(':', 1)[1].lower()
    if target.exists():
        with target.open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() == expected:
                return
    subprocess.run(['curl', '-fsSL', '--retry', '2', '--max-time', '300',
                    job['url'], '-o', str(target)], check=True)
    with target.open('rb') as stream:
        actual = hashlib.file_digest(stream, 'sha256').hexdigest()
    if actual != expected:
        raise RuntimeError(f'SHA-256 mismatch: {target.name}')
    print(f'Verified: {target.name}', flush=True)


with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    list(pool.map(fetch, jobs))
