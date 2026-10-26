import copy, json, tempfile, threading, unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, build_opener, HTTPCookieProcessor
from http.cookiejar import CookieJar
import server

class BackendTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.path=Path(self.tmp.name)/'test.sqlite3'
        self.http=server.make_server(port=0,db_path=self.path)
        self.thread=threading.Thread(target=self.http.serve_forever,daemon=True);self.thread.start()
        self.url=f'http://127.0.0.1:{self.http.server_port}'
        self.client=build_opener(HTTPCookieProcessor(CookieJar()))
    def tearDown(self):
        self.http.shutdown();self.http.server_close();self.thread.join();self.tmp.cleanup()
    def request(self,path,method='GET',value=None,client=None,origin=None):
        headers={'Content-Type':'application/json'}
        if origin:headers['Origin']=origin
        req=Request(self.url+path,data=json.dumps(value).encode() if value is not None else None,headers=headers,method=method)
        try:
            with (client or self.client).open(req) as r:return r.status,json.load(r)
        except HTTPError as e:return e.code,json.load(e)
    def login(self,username='usuario',password='artefacto',client=None):
        code,data=self.request('/api/auth/login','POST',{'username':username,'password':password},client=client);self.assertEqual(code,200);return data['user']
    def test_auth_and_private_files(self):
        self.assertEqual(self.request('/api/records')[0],401)
        self.assertEqual(self.request('/data/smed.sqlite3')[0],404)
        self.login()
        self.assertEqual(self.request('/api/auth/setup','POST',{'username':'another.user','password':'Testing123!'})[0],409)
        self.assertEqual(self.request('/api/records','POST',{},origin='https://otro.example')[0],403)
        self.request('/api/auth/logout','POST',{})
        self.assertEqual(self.request('/api/records')[0],401)
        self.assertEqual(self.request('/api/auth/login','POST',{'username':'usuario','password':'incorrecta!'})[0],401)
        self.assertEqual(self.request('/api/auth/login','POST',{'username':'usuario','password':'artefacto'})[0],200)
    def test_operator_records_new_setups_without_analyst_options(self):
        operator=build_opener(HTTPCookieProcessor(CookieJar()))
        self.assertEqual(self.login('operario','troqueladora',client=operator),{'username':'operario','role':'operario'})
        self.assertEqual(self.request('/api/auth/status',client=operator)[1]['user'],{'username':'operario','role':'operario'})
        for path,method,value in (('/api/records','GET',None),('/api/config','POST',{'meta':10}),('/api/records/seed','POST',{}),('/api/records/import','POST',{'records':[]}),('/api/records/SIM-001','DELETE',{})):
            self.assertEqual(self.request(path,method,value,client=operator)[0],403,path)
        self.assertEqual(self.request('/api/config',client=operator)[1]['meta'],33.6)
        record=server.simulated_records()[0];record.update(id='OPERARIO-1',origen='Planta',simulated=False)
        code,saved=self.request('/api/records','POST',record,client=operator);self.assertEqual(code,200)
        self.assertEqual(self.request('/api/records','POST',record,client=operator)[1]['_version'],1)
        saved['entries'][0]['minutes']=1.5;code,saved=self.request('/api/records','POST',saved,client=operator);self.assertEqual((code,saved['_version']),(200,2))
        self.assertEqual(self.request('/api/records','POST',dict(record,id='OPERARIO-2',origen='Simulado'),client=operator)[0],400)
        self.login();analyst_record=self.request('/api/records')[1]['records'];self.assertEqual(len(analyst_record),25)
        sim=next(r for r in analyst_record if r['id']=='SIM-001');sim.update(origen='Planta');sim['entries'][0]['minutes']=0.5
        self.assertEqual(self.request('/api/records','POST',sim,client=operator)[0],403)
        self.assertEqual(self.request('/api/auth/login','POST',{'username':'operario','password':'artefacto'})[0],401)
    def test_previous_supervisor_database_becomes_analyst(self):
        path=Path(self.tmp.name)/'old.sqlite3'
        with server.connect(path) as db:
            db.executescript('''CREATE TABLE supervisor (id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password_hash TEXT NOT NULL);
                CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, expires REAL NOT NULL, supervisor_id INTEGER NOT NULL REFERENCES supervisor(id));
                CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE records (id TEXT PRIMARY KEY, data TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated REAL NOT NULL);''')
            salt='ab'*16;db.execute('INSERT INTO supervisor VALUES(1,?,?,?)',('jefe.planta',salt,server.hash_password('Clave-antigua1',salt)))
            db.execute("INSERT INTO sessions VALUES('x',9e12,1)");db.execute("INSERT INTO metadata VALUES('review_access_v1','true')")
        server.initialize(path);server.initialize(path)
        with server.connect(path) as db:
            self.assertEqual([tuple(r) for r in db.execute('SELECT username,role FROM users ORDER BY id')],[('jefe.planta','analista'),('operario','operario')])
            self.assertIsNone(db.execute("SELECT 1 FROM sqlite_master WHERE name IN ('supervisor','sessions')").fetchone())
            self.assertEqual(db.execute('SELECT COUNT(*) FROM user_sessions').fetchone()[0],0)
            self.assertIn('created_by',[c['name'] for c in db.execute('PRAGMA table_info(records)')])
    def test_records_persistence_idempotency_conflicts_and_seed(self):
        self.login();records=self.request('/api/records')[1]['records'];self.assertEqual(len(records),24)
        self.assertTrue(all(r['origen']=='Simulado' for r in records));self.assertTrue(any(any(e['status']=='Omitida' for e in r['entries']) for r in records))
        r=copy.deepcopy(records[0]);r.pop('_version');r.update(id='REAL-TEST',origen='Planta',simulated=False)
        code,saved=self.request('/api/records','POST',r);self.assertEqual(code,200)
        self.assertEqual(self.request('/api/records','POST',r)[0],200)
        self.assertEqual(len(self.request('/api/records')[1]['records']),25)
        old=copy.deepcopy(saved);saved['entries'][0]['minutes']=2.55
        code,updated=self.request('/api/records','POST',saved);self.assertEqual(code,200);self.assertEqual(updated['_version'],2)
        old['entries'][0]['minutes']=3.55;self.assertEqual(self.request('/api/records','POST',old)[0],409)
        bad=copy.deepcopy(updated);bad['entries'][0]['minutes']=-1;self.assertEqual(self.request('/api/records','POST',bad)[0],400)
        self.request('/api/records/seed','POST',{})
        records=self.request('/api/records')[1]['records'];self.assertEqual(len(records),25);self.assertTrue(any(r['id']=='REAL-TEST' for r in records))
        with server.connect(self.path) as db:self.assertEqual(db.execute("SELECT COUNT(*) FROM records WHERE id='REAL-TEST'").fetchone()[0],1)
        server.initialize(self.path)
        self.assertEqual(len(self.request('/api/records')[1]['records']),25)
        self.assertEqual(self.request('/api/records/REAL-TEST','DELETE',{})[0],200)
    def test_import_and_configuration(self):
        self.login();record=server.simulated_records()[0];record['id']='IMPORT-TEST'
        for count in (1,0):self.assertEqual(self.request('/api/records/import','POST',{'records':[record]})[1]['imported'],count)
        cfg={'meta':40,'demo':False,'compare':True,'externas':['colocar paquete de láminas en la mesa']};self.assertEqual(self.request('/api/config','POST',cfg)[1],cfg);self.assertEqual(self.request('/api/config')[1],cfg)
        self.assertEqual(self.request('/api/config','POST',{'meta':40})[1]['externas'],[])
        self.assertEqual(self.request('/api/config','POST',{'meta':-5})[0],400)
        self.assertEqual(self.request('/api/config','POST',{'meta':40,'externas':'todas'})[0],400)

if __name__=='__main__':unittest.main()
