import uuid
from sqlalchemy import text
from tests.helpers import login, bearer
from tests.test_phase2 import setup_mac, device_call

def skill(name='pdf', **over):
    config = {'name': name, 'description': 'PDF 工具', 'content': '# PDF\n用 pdftotext 提取文字', 'files': [{'path': 'scripts/run.sh', 'content': 'pdftotext "$1" -'}],
              'runtime': 'mac', 'enabled': True, 'requires': {'commands': ['pdftotext'], 'platforms': ['darwin'], 'scripts': ['scripts/run.sh'], 'mcp': []},
              'install_hint': 'brew install poppler'}
    return {'expected_version': 0, 'request_id': str(uuid.uuid4()), 'config': config | over}

def mcp(name='fs', **over):
    config = {'name': name, 'transport': 'stdio', 'command': 'npx', 'args': ['-y', '@modelcontextprotocol/server-filesystem'], 'timeout_ms': 30000,
              'env': [{'name': 'API_TOKEN', 'secret_ref': 'fs-token'}, {'name': 'LOG_LEVEL', 'value': 'info'}], 'runtime': 'mac', 'enabled': True, 'disabled_tools': []}
    return {'expected_version': 0, 'request_id': str(uuid.uuid4()), 'config': config | over}

def setup(client):
    token = login(client); mac = setup_mac(client, token); return token, mac

def test_skill_edit_on_phone_visible_on_mac_with_versions(client):
    t, m = setup(client); id = str(uuid.uuid4()); p = skill()
    r = client.put(f'/configs/skills/{id}', headers=bearer(t), json=p); assert r.status_code == 200, r.text
    first = r.json(); assert first['version'] == 1 and len(first['content_hash']) == 64 and first['devices'] == []
    assert client.put(f'/configs/skills/{id}', headers=bearer(t), json=p).json() == first
    b = device_call(client, m, 'GET', '/device/configs/bundle').json(); assert [s['id'] for s in b['skills']] == [id]
    assert b['skills'][0]['config']['install_hint'] == 'brew install poppler'
    # Mac edits the same document with the version it saw.
    p2 = skill(content='# PDF v2'); p2['expected_version'] = 1
    r = device_call(client, m, 'PUT', f'/device/configs/skills/{id}', p2); assert r.status_code == 200 and r.json()['version'] == 2
    assert r.json()['content_hash'] != first['content_hash']
    # Stale phone write conflicts and gets the current version back.
    stale = skill(content='# stale'); stale['expected_version'] = 1
    r = client.put(f'/configs/skills/{id}', headers=bearer(t), json=stale); assert r.status_code == 409 and r.json()['detail']['current']['version'] == 2
    listed = client.get('/configs/skills', headers=bearer(t)).json(); assert listed[0]['version'] == 2 and listed[0]['config']['content'] == '# PDF v2'
    revs = client.get(f'/configs/skills/{id}/revisions', headers=bearer(t)).json(); assert [x['version'] for x in revs] == [2, 1]
    events = client.get('/events', headers=bearer(t)).json()['events']; assert sum(e['type'] == 'skill.changed' for e in events) >= 2

def test_applied_keeps_last_usable_version(client):
    t, m = setup(client); id = str(uuid.uuid4())
    v1 = client.put(f'/configs/skills/{id}', headers=bearer(t), json=skill()).json()
    ok = device_call(client, m, 'POST', f'/device/configs/skills/{id}/applied', {'version': 1, 'hash': v1['content_hash'], 'state': 'available', 'reasons': []})
    assert ok.status_code == 200, ok.text; dev = ok.json()['devices'][0]; assert dev['state'] == 'available' and dev['applied_version'] == 1 and dev['label'] == 'Mac'
    p = skill(requires={'commands': ['ffmpeg'], 'platforms': [], 'scripts': [], 'mcp': []}); p['expected_version'] = 1
    v2 = client.put(f'/configs/skills/{id}', headers=bearer(t), json=p).json()
    assert v2['devices'][0]['state'] == 'pending' and v2['devices'][0]['applied_version'] == 1
    assert device_call(client, m, 'POST', f'/device/configs/skills/{id}/applied', {'version': 1, 'hash': v1['content_hash'], 'state': 'available'}).status_code == 409
    bad = device_call(client, m, 'POST', f'/device/configs/skills/{id}/applied', {'version': 2, 'hash': v2['content_hash'], 'state': 'unavailable', 'reasons': [{'code': 'command_missing', 'detail': 'ffmpeg'}]}).json()
    dev = bad['devices'][0]; assert dev['state'] == 'unavailable' and dev['applied_version'] == 1 and dev['applied_hash'] == v1['content_hash'] and dev['reasons'][0]['code'] == 'command_missing'
    phone = client.get('/configs/skills', headers=bearer(t)).json()[0]['devices'][0]; assert phone['checked_version'] == 2 and phone['reasons'][0]['detail'] == 'ffmpeg'

def test_validation_rejects_unsafe_packages(client):
    t, _ = setup(client)
    for bad in [skill(files=[{'path': '../x', 'content': ''}]), skill(files=[{'path': '/etc/x', 'content': ''}]), skill(files=[{'path': 'SKILL.md', 'content': ''}]),
                skill(requires={'commands': ['rm -rf'], 'platforms': [], 'scripts': [], 'mcp': []}),
                skill(requires={'commands': [], 'platforms': [], 'scripts': ['missing.sh'], 'mcp': []}),
                skill(files=[{'path': f'f{i}', 'content': 'x' * 200_000} for i in range(6)]),
                mcp(env=[{'name': 'GITHUB_TOKEN', 'value': 'ghp_plaintext'}]), mcp(env=[{'name': 'A', 'value': 'x', 'secret_ref': 'y'}]),
                mcp(transport='http'), mcp(transport='http', command=None, args=[], url='https://u:p@example.com/mcp')]:
        path = 'skills' if 'content' in bad['config'] else 'mcp-servers'
        assert client.put(f'/configs/{path}/{uuid.uuid4()}', headers=bearer(t), json=bad).status_code == 422, bad['config']

def test_mcp_secret_refs_only_names_unique_and_delete(client):
    t, m = setup(client); id = str(uuid.uuid4())
    r = client.put(f'/configs/mcp-servers/{id}', headers=bearer(t), json=mcp()); assert r.status_code == 200, r.text
    assert r.json()['config']['env'][0] == {'name': 'API_TOKEN', 'value': None, 'secret_ref': 'fs-token'}
    assert client.put(f'/configs/mcp-servers/{uuid.uuid4()}', headers=bearer(t), json=mcp()).status_code == 409
    http = mcp('remote', transport='http', command=None, args=[], url='https://example.com/mcp', env=[])
    assert client.put(f'/configs/mcp-servers/{uuid.uuid4()}', headers=bearer(t), json=http).status_code == 200
    d = client.post(f'/configs/mcp-servers/{id}/delete', headers=bearer(t), json={'expected_version': 1, 'request_id': str(uuid.uuid4())})
    assert d.status_code == 200 and d.json()['deleted']
    assert [x['config']['name'] for x in device_call(client, m, 'GET', '/device/configs/bundle').json()['mcp_servers']] == ['remote']
    # The freed name can be reused; deleted entries cannot be edited or applied.
    assert client.put(f'/configs/mcp-servers/{uuid.uuid4()}', headers=bearer(t), json=mcp()).status_code == 200
    again = mcp(); again['expected_version'] = 2
    assert client.put(f'/configs/mcp-servers/{id}', headers=bearer(t), json=again).status_code == 410
    assert device_call(client, m, 'POST', f'/device/configs/mcp-servers/{id}/applied', {'version': 2, 'hash': d.json()['content_hash'], 'state': 'available'}).status_code == 409
    with client.app.state.engine.connect() as s:
        assert s.execute(text("SELECT count(*) FROM shared_documents WHERE kind='mcp_server' AND device_id IS NULL")).scalar() == 3

def test_config_endpoints_require_auth(client):
    t, m = setup(client)
    assert client.get('/configs/skills').status_code == 401
    assert client.get('/device/configs/bundle', headers=bearer(t)).status_code in (401, 403)
