"""Isolated PostgreSQL and HTTP server for the desktop integration suite."""
import base64,json,os,socket,subprocess,tempfile,time,urllib.request
from pathlib import Path
from testcontainers.community.postgres import PostgresContainer
root=Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix='tagnet-shared-') as tmp, PostgresContainer('postgres:16-alpine',username='tagent',password='tagent',dbname='shared_test',driver='psycopg') as pg:
    key=Path(tmp)/'vault.json';key.write_text(json.dumps({'active':'test','keys':{'test':base64.b64encode(os.urandom(32)).decode()}}));key.chmod(0o600)
    with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    env={**os.environ,'T_AGNET_DATABASE_URL':pg.get_connection_url(),'T_AGNET_ADMIN_PASSWORD':'shared-test-password','T_AGNET_JWT_SECRET':'shared-test-jwt-secret-longer-than-32','T_AGNET_SYNC_KEY_FILE':str(key),'PYTHONPATH':'src','T_AGNET_APPROVAL_TTL_SECONDS':'60'}
    log=open(Path(tmp)/'server.log','w')
    proc=subprocess.Popen(['uv','run','uvicorn','tagent_server.main:create_app','--factory','--host','127.0.0.1','--port',str(port)],cwd=root/'server',env=env,stdout=log,stderr=log)
    worker=None
    try:
        for _ in range(100):
            try:urllib.request.urlopen(f'http://127.0.0.1:{port}/health');break
            except Exception:time.sleep(.2)
        else:raise RuntimeError('isolated server did not start')
        test_file=os.environ.get('T_AGNET_TEST_FILE') or ('tests/shared-real.test.ts' if os.environ.get('T_AGNET_REAL_SYNC')=='1' else 'tests/shared-e2e.test.ts')
        with_worker='cloud-chat' in test_file or os.environ.get('T_AGNET_WITH_WORKER')=='1'
        worker_log=Path(tmp)/'worker.log'
        if with_worker:worker=subprocess.Popen(['uv','run','python','-m','tagent_server.worker'],cwd=root/'server',env={**env,'T_AGNET_WORKER_LEASE_SECONDS':'15'},stdout=open(worker_log,'w'),stderr=subprocess.STDOUT)
        args=['node_modules/@playwright/test/cli.js','test',test_file] if test_file.endswith('.spec.ts') else ['--import','tsx','--test',test_file]
        result=subprocess.run([str(root/'desktop/node_modules/node/bin/node'),*args],cwd=root/'desktop',env={**os.environ,'T_AGNET_SHARED_URL':f'http://127.0.0.1:{port}','T_AGNET_SHARED_PASSWORD':'shared-test-password','T_AGNET_CLOUD_URL':f'http://127.0.0.1:{port}','T_AGNET_CLOUD_PASSWORD':'shared-test-password',**({'T_AGNET_CLOUD_WORKER':'1'} if with_worker else {})})
        if result.returncode and with_worker:print(worker_log.read_text()[-4000:])
        raise SystemExit(result.returncode)
    finally:
        for p in (worker,proc):
            if p:p.terminate();p.wait(timeout=15)
        log.close()
