"""Small independent client; password is prompted, tokens remain in memory."""
import argparse,getpass,json,time,uuid
from urllib.parse import urlparse
import httpx
p=argparse.ArgumentParser();p.add_argument('url');p.add_argument('--conversation');p.add_argument('--text');p.add_argument('--models',action='store_true');p.add_argument('--watch',action='store_true');a=p.parse_args()
u=urlparse(a.url)
if u.scheme!='https' and not (u.scheme=='http' and u.hostname in ('localhost','127.0.0.1','::1')):raise SystemExit('Use HTTPS outside loopback')
with httpx.Client(base_url=a.url,timeout=20) as c:
    r=c.post('/auth/login',json={'password':getpass.getpass('管理员密码: ')});r.raise_for_status();c.headers['Authorization']='Bearer '+r.json()['access_token']
    def get(path):
        r=c.get(path);r.raise_for_status();return r.json()
    if a.models:print(json.dumps(get('/configs/models'),ensure_ascii=False,indent=2))
    elif not a.conversation:print(json.dumps(get('/conversations'),ensure_ascii=False,indent=2))
    else:
        if a.text:
            r=c.post(f'/conversations/{a.conversation}/messages',json={'text':a.text,'request_id':str(uuid.uuid4())});r.raise_for_status();run=r.json();print('run_id:',run['id'])
        while True:
            rows=[];after=0
            while True:
                page=get(f'/conversations/{a.conversation}/messages?after={after}');rows+=page['messages'];after=page['next_cursor']
                if not page['has_more']:break
            print(json.dumps(rows,ensure_ascii=False,indent=2))
            if not a.watch or not a.text:break
            state=get(f"/chat-runs/{run['id']}")['state']
            if state in ('completed','failed','cancelled','interrupted'):print('state:',state);break
            time.sleep(1)
