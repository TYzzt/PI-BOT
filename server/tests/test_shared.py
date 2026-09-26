import base64,json,os,uuid
import pytest
from fastapi import HTTPException
from tagent_server.vault import Vault
from tests.helpers import login,bearer
from tests.test_phase2 import setup_mac,device_call,create_task,pull_and_ack,plan_payload,plan_body,approve
from sqlalchemy import text

@pytest.fixture
def shared(client,tmp_path):
    path=tmp_path/'keys.json';path.write_text(json.dumps({'active':'k1','keys':{'k1':base64.b64encode(os.urandom(32)).decode()}}))
    client.app.state.settings.sync_key_file=path
    token=login(client);mac=setup_mac(client,token);device_call(client,mac,'POST','/device/shared/enable')
    return client,token,mac,path

def config(mac):return {'device_id':mac.device_id,'expected_version':0,'request_id':str(uuid.uuid4()),'api_key':'secret-do-not-leak','config':{'name':'test','base_url':'https://example.com/v1','model_id':'test','context_window':32000,'max_tokens':4096,'is_default':True}}
def model(shared):
    c,t,m,_=shared;id=str(uuid.uuid4());p=config(m);r=device_call(c,m,'PUT',f'/device/configs/models/{id}',p);assert r.status_code==200,r.text;return id,p,r.json()
def conversation(shared,model_id):
    c,t,m,_=shared;id=str(uuid.uuid4());p={'device_id':m.device_id,'title':'test','kind':'ask','model_config_id':model_id,'expected_version':0,'request_id':str(uuid.uuid4())};r=device_call(c,m,'PUT',f'/device/conversations/{id}',p);assert r.status_code==200,r.text;return id,p,r.json()

def test_model_versions_vault_and_acl(shared):
    c,t,m,path=shared;id,p,r=model(shared)
    assert 'secret-do-not-leak' not in json.dumps(r)
    assert device_call(c,m,'PUT',f'/device/configs/models/{id}',p).json()==r
    p['request_id']=str(uuid.uuid4());assert c.put(f'/configs/models/{id}',headers=bearer(t),json=p).status_code==409
    secret=device_call(c,m,'GET',f'/device/configs/models/{id}/credential?version=1')
    # Signature canonical path excludes the query.
    from tests.helpers import signed_headers
    secret=c.get(f'/device/configs/models/{id}/credential?version=1',headers=signed_headers(m.key,m.device_id,'GET',f'/device/configs/models/{id}/credential',b''))
    assert secret.status_code==200 and secret.json()['api_key']=='secret-do-not-leak'
    other=setup_mac(c,t,label='Other')
    denied=c.get(f'/device/configs/models/{id}/credential?version=1',headers=signed_headers(other.key,other.device_id,'GET',f'/device/configs/models/{id}/credential',b''));assert denied.status_code==404
    p['expected_version']=1;p['api_key']='replacement-key'
    r=c.put(f'/configs/models/{id}',headers=bearer(t),json=p);assert r.status_code==200 and r.json()['version']==2
    assert 'replacement-key' not in c.get('/configs/models',headers=bearer(t)).text
    with c.app.state.engine.connect() as s:
        data=s.execute(text('SELECT data::text FROM shared_revisions')).scalars().all()
        assert all('secret-do-not-leak' not in x and 'replacement-key' not in x for x in data)
    c.app.state.settings.sync_key_file=None
    p['expected_version']=2;p['request_id']=str(uuid.uuid4());assert c.put(f'/configs/models/{id}',headers=bearer(t),json=p).status_code==503

def test_vault_rotation_and_tamper(shared):
    _,_,_,path=shared;vault=Vault(path);a=vault.seal('key','config',1)
    data=json.loads(path.read_text());data['keys']['k2']=base64.b64encode(os.urandom(32)).decode();data['active']='k2';path.write_text(json.dumps(data))
    v=Vault(path);assert v.open(a,'config')=='key';assert v.seal('new','config',2)['key_id']=='k2'
    with pytest.raises(HTTPException):v.open(a,'other-config')
    a['ciphertext']=base64.b64encode(b'x'*32).decode()
    with pytest.raises(HTTPException):v.open(a,'config')

def test_chat_idempotency_revisions_cancel_and_unshare(shared):
    c,t,m,_=shared;mid,_,_=model(shared);cid,p,conv=conversation(shared,mid)
    q={'text':'hello','request_id':str(uuid.uuid4())};r=c.post(f'/conversations/{cid}/messages',headers=bearer(t),json=q);assert r.status_code==200,r.text
    run=r.json();assert c.post(f'/conversations/{cid}/messages',headers=bearer(t),json=q).json()==run
    assert len(c.get(f'/conversations/{cid}/messages',headers=bearer(t)).json()['pending_messages'])==1
    assert c.post(f'/conversations/{cid}/messages',headers=bearer(t),json={'text':'other','request_id':str(uuid.uuid4())}).status_code==409
    assert device_call(c,m,'POST',f"/device/chat-runs/{run['id']}/ack").status_code==200
    message={'id':str(uuid.uuid4()),'run_id':run['id'],'role':'assistant','content':'part','status':'running','sequence':2,'revision':1}
    assert device_call(c,m,'POST',f'/device/conversations/{cid}/messages',{'share_version':1,'messages':[message]}).status_code==200
    message.update(content='full',status='completed',revision=2);device_call(c,m,'POST',f'/device/conversations/{cid}/messages',{'share_version':1,'messages':[message]})
    message.update(content='stale',status='running',revision=3);device_call(c,m,'POST',f'/device/conversations/{cid}/messages',{'share_version':1,'messages':[message]})
    assert c.get(f'/conversations/{cid}/messages',headers=bearer(t)).json()['messages'][0]['content']=='full'
    r=c.post(f"/chat-runs/{run['id']}/cancel",headers=bearer(t));assert r.json()['cancel_requested'] and r.json()['state']!='cancelled'
    device_call(c,m,'POST',f"/device/chat-runs/{run['id']}/result",{'state':'cancelled'})
    p.update(expected_version=1,request_id=str(uuid.uuid4()),shared=False)
    assert c.put(f'/conversations/{cid}',headers=bearer(t),json=p).json()['share_version']==2
    assert c.post(f'/conversations/{cid}/messages',headers=bearer(t),json=q|{'request_id':str(uuid.uuid4())}).status_code==409
    assert device_call(c,m,'POST',f'/device/conversations/{cid}/messages',{'share_version':1,'messages':[message]}).status_code==409

def test_questions_are_not_approvable(shared):
    c,t,m,_=shared;task=create_task(c,t,m).json();[command]=pull_and_ack(c,m);body=plan_body();body['questions']=['need clarification']
    plan=device_call(c,m,'POST',f"/tasks/{task['task_id']}/plans",plan_payload(task,m,command['run_id'],1,body)).json()
    assert c.get(f"/tasks/{task['task_id']}",headers=bearer(t)).json()['status']=='waiting_for_input'
    assert approve(c,t,plan).status_code==409

def test_choice_questions_are_not_approvable(shared):
    c,t,m,_=shared;task=create_task(c,t,m).json();[command]=pull_and_ack(c,m);body=plan_body()
    body['questions']=[{'id':'channel','prompt':'频道缺失时','options':[{'id':'error','label':'直接报错'},{'id':'fallback','label':'回退当前频道'}],'allow_multiple':False}]
    plan=device_call(c,m,'POST',f"/tasks/{task['task_id']}/plans",plan_payload(task,m,command['run_id'],1,body)).json()
    assert c.get(f"/tasks/{task['task_id']}",headers=bearer(t)).json()['status']=='waiting_for_input'
    assert approve(c,t,plan).status_code==409


def test_cancel_queued_question_updates_pending_message(shared):
    c,t,m,_=shared;mid,_,_=model(shared);cid,_,_=conversation(shared,mid)
    run=c.post(f'/conversations/{cid}/messages',headers=bearer(t),json={'text':'cancel before delivery','request_id':str(uuid.uuid4())}).json()
    assert c.post(f"/chat-runs/{run['id']}/cancel",headers=bearer(t)).json()['state']=='cancelled'
    pending=c.get(f'/conversations/{cid}/messages',headers=bearer(t)).json()['pending_messages']
    assert len(pending)==1 and pending[0]['status']=='cancelled'
    assert device_call(c,m,'POST',f"/device/chat-runs/{run['id']}/ack").json()['state']=='cancelled'
