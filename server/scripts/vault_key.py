"""Generate/rotate vault key files. Never prints secret material."""
import argparse,base64,json,os,uuid
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('file',type=Path);p.add_argument('--rotate',action='store_true');a=p.parse_args()
if a.file.exists():
    if not a.rotate:raise SystemExit('File exists; use --rotate to retain old keys and add a new active key')
    data=json.loads(a.file.read_text())
else:
    if a.rotate:raise SystemExit('Cannot rotate a missing key file')
    data={'keys':{}}
k=str(uuid.uuid4());data['active']=k;data['keys'][k]=base64.b64encode(os.urandom(32)).decode()
tmp=a.file.with_suffix('.tmp');fd=os.open(tmp,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
with os.fdopen(fd,'w') as f:json.dump(data,f);f.flush();os.fsync(f.fileno())
os.replace(tmp,a.file)
print('Key file saved; back it up separately from the database. Old keys retained for existing ciphertext.')
