"""API y servidor local SMED, usando SQLite y la biblioteca estándar de Python."""
import argparse, hashlib, hmac, json, math, os, secrets, sqlite3, time
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, unquote

ROOT = Path(__file__).resolve().parent
LIMA = timezone(timedelta(hours=-5))
MAX_BODY = 4 * 1024 * 1024
ITERATIONS = 310000
# Cuentas de revisión: el analista mide y analiza; el operario realiza el cambio de setup.
OPERATOR_ROUTES = {('GET','/api/config'),('POST','/api/records')}
REVIEW_ACCOUNTS = (('review_access_v1','usuario','artefacto','analista'),('operator_access_v1','operario','troqueladora','operario'))

def hash_password(password, salt):
    return hashlib.pbkdf2_hmac('sha256',password.encode(),bytes.fromhex(salt),ITERATIONS).hex()

class APIError(Exception):
    def __init__(self, message, status=400):
        self.message, self.status = message, status

@contextmanager
def connect(path):
    db = sqlite3.connect(path, timeout=15)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    try:
        with db:
            yield db
    finally:
        db.close()

def simulated_records():
    plan = json.loads((ROOT / 'reference.json').read_text(encoding='utf-8'))
    rng = __import__('random').Random(20261011)
    today = datetime.now(LIMA).date()
    records = []
    for i in range(24):
        day = today - timedelta(days=(23-i)//3)
        start = datetime.combine(day, datetime.min.time(), LIMA) + timedelta(hours=8+(i%3)*3, minutes=(i*7)%30)
        omitted = {8, 11} if i in (5, 17) else ({10} if i in (9, 21) else set())
        multiplier = 0.68 + (i%6)*0.085
        entries, cursor = [], int(start.timestamp()*1000)
        for j, a in enumerate(plan):
            minutes = round(max(0.12, a['base']*multiplier*rng.uniform(0.85,1.18)), 2)
            if j in omitted: minutes = round(rng.uniform(.08,.24),2)
            end = cursor + round(minutes*60000)
            entries.append({'id':f'SIM-{i+1}-A{j+1}','activityId':a['id'],'name':a['name'],'type':'Actividad','status':'Omitida' if j in omitted else 'Registrada','minutes':minutes,'start':cursor,'end':end,'audit':[]})
            cursor=end
            if j==9 and i in (3,12,20):
                extra=round(minutes*.35,2);end=cursor+round(extra*60000)
                entries.append({'id':f'SIM-{i+1}-REP','activityId':a['id'],'name':a['name'],'type':'Repetición','status':'Registrada','minutes':extra,'start':cursor,'end':end,'audit':[]})
                cursor=end
        records.append({'id':f'SIM-{i+1:03}','fecha':day.isoformat(),'hora':start.strftime('%H:%M'),'horaInicio':start.strftime('%H:%M:%S'),'horaFin':datetime.fromtimestamp(cursor/1000,LIMA).strftime('%H:%M:%S'),'origen':'Simulado','simulated':True,'entries':entries,'plan':plan,'measuredTotal':round(sum(e['minutes'] for e in entries),2),'external':0,'meta':33.6,'audit':[],'start':int(start.timestamp()*1000),'end':cursor})
    return records

def initialize(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with connect(path) as db:
        db.execute('PRAGMA journal_mode=WAL')
        db.executescript('''
            CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK(role IN ('analista','operario')), salt TEXT NOT NULL, password_hash TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS user_sessions (token_hash TEXT PRIMARY KEY, expires REAL NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE);
            CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, data TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        ''')
        if 'created_by' not in [c['name'] for c in db.execute('PRAGMA table_info(records)')]:
            db.execute('ALTER TABLE records ADD COLUMN created_by TEXT')
        # Bases anteriores: la cuenta única de supervisor pasa a ser el analista y se cierran sus sesiones.
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='supervisor'").fetchone():
            db.execute("INSERT OR IGNORE INTO users(username,role,salt,password_hash) SELECT username,'analista',salt,password_hash FROM supervisor")
            db.execute('DROP TABLE IF EXISTS sessions');db.execute('DROP TABLE supervisor')
        for flag,username,password,role in REVIEW_ACCOUNTS:
            if not db.execute('SELECT 1 FROM metadata WHERE key=?',(flag,)).fetchone():
                salt=secrets.token_hex(16)
                db.execute('INSERT INTO users(username,role,salt,password_hash) VALUES(?,?,?,?) ON CONFLICT(username) DO UPDATE SET role=excluded.role,salt=excluded.salt,password_hash=excluded.password_hash',(username,role,salt,hash_password(password,salt)))
                db.execute('DELETE FROM user_sessions WHERE user_id=(SELECT id FROM users WHERE username=?)',(username,))
                db.execute("INSERT INTO metadata VALUES(?,'true')",(flag,))
        db.execute("INSERT OR IGNORE INTO metadata VALUES('database_id',?)",(secrets.token_hex(16),))
        if not db.execute("SELECT 1 FROM metadata WHERE key='seeded'").fetchone():
            for r in simulated_records():
                db.execute('INSERT OR IGNORE INTO records(id,data,version,updated) VALUES(?,?,1,?)',(r['id'],json.dumps(r,ensure_ascii=False),time.time()))
            db.execute("INSERT INTO metadata VALUES('seeded','true')")

def validate_record(value):
    if not isinstance(value,dict): raise APIError('Registro inválido.')
    r=dict(value);r.pop('_version',None);r.pop('_registradoPor',None)
    if not isinstance(r.get('id'),str) or not 1<=len(r['id'])<=100: raise APIError('Identificador inválido.')
    try: date.fromisoformat(r.get('fecha',''))
    except (ValueError,TypeError): raise APIError('Fecha inválida.')
    if r.get('origen') not in ('Planta','Demo','Piloto','Simulado'): raise APIError('Origen inválido.')
    if 'entries' in r:
        if not isinstance(r['entries'],list) or not 1<=len(r['entries'])<=500: raise APIError('Lista de actividades inválida.')
        ids=set()
        for e in r['entries']:
            if not isinstance(e,dict) or not isinstance(e.get('name'),str) or not 1<=len(e['name'])<=180: raise APIError('Actividad inválida.')
            if not isinstance(e.get('id'),str) or e['id'] in ids: raise APIError('Identificador de actividad inválido.')
            ids.add(e['id'])
            if e.get('type') not in ('Actividad','Repetición','Incidencia') or e.get('status') not in ('Registrada','Omitida'): raise APIError('Estado o tipo inválido.')
            m=e.get('minutes')
            if isinstance(m,bool) or not isinstance(m,(int,float)) or not math.isfinite(m) or not 0<=m<=100000: raise APIError('Duración inválida.')
    elif not isinstance(r.get('t'),list) or len(r['t'])!=15 or any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) or v<0 for v in r['t']):
        raise APIError('Faltan los tiempos de las actividades.')
    # Rechaza NaN también en campos adicionales antes de serializar.
    try: json.dumps(r,allow_nan=False)
    except (ValueError,TypeError): raise APIError('Datos numéricos inválidos.')
    return r

def recorded_by(db, username):
    # Quién creó la medición; las anteriores a los roles no lo registran.
    row=db.execute('SELECT username,role FROM users WHERE username=?',(username,)).fetchone() if username else None
    return {'username':row['username'],'role':row['role']} if row else None

class Handler(BaseHTTPRequestHandler):
    server_version='SMED/1.0'
    def log_message(self, fmt, *args):
        if not self.path.startswith('/api/auth/'): super().log_message(fmt,*args)
    def respond(self, data, status=200, cookie=None):
        body=json.dumps(data,ensure_ascii=False).encode()
        self.send_response(status);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff')
        if cookie: self.send_header('Set-Cookie',cookie)
        self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
    def body(self):
        if self.headers.get('Content-Type','').split(';')[0]!='application/json': raise APIError('Se requiere JSON.',415)
        origin=self.headers.get('Origin')
        if origin and origin not in (f'http://{self.headers.get("Host")}',f'https://{self.headers.get("Host")}'): raise APIError('Origen no permitido.',403)
        try: size=int(self.headers.get('Content-Length','0'))
        except ValueError: raise APIError('Tamaño inválido.')
        if not 0<size<=MAX_BODY: raise APIError('Solicitud demasiado grande o vacía.',413)
        try: value=json.loads(self.rfile.read(size))
        except (ValueError,UnicodeError): raise APIError('JSON inválido.')
        if not isinstance(value,dict): raise APIError('Solicitud inválida.')
        return value
    def user(self,db,required=False):
        cookie=SimpleCookie()
        try: cookie.load(self.headers.get('Cookie',''))
        except Exception: pass
        token=cookie.get('smed_session');row=None
        if token:
            row=db.execute('SELECT u.username,u.role FROM user_sessions t JOIN users u ON u.id=t.user_id WHERE t.token_hash=? AND t.expires>?',(hashlib.sha256(token.value.encode()).hexdigest(),time.time())).fetchone()
        if required and not row: raise APIError('Inicia sesión para acceder a los registros.',401)
        return {'username':row['username'],'role':row['role']} if row else None
    def session_cookie(self,db,user_id):
        token=secrets.token_urlsafe(32);db.execute('DELETE FROM user_sessions WHERE expires<?',(time.time(),));db.execute('INSERT INTO user_sessions VALUES(?,?,?)',(hashlib.sha256(token.encode()).hexdigest(),time.time()+43200,user_id))
        secure='; Secure' if os.environ.get('SMED_SECURE_COOKIE')=='1' else ''
        return f'smed_session={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200{secure}'
    def dispatch(self,method):
        path=urlparse(self.path).path
        if path in ('/','/index.html') and method=='GET':
            body=(ROOT/'index.html').read_bytes();self.send_response(200);self.send_header('Content-Type','text/html; charset=utf-8');self.send_header('Cache-Control','no-cache');self.send_header('X-Content-Type-Options','nosniff');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body);return
        if not path.startswith('/api/'): raise APIError('No encontrado.',404)
        with connect(self.server.db_path) as db:
            if path=='/api/health' and method=='GET': self.respond({'ok':True,'storage':'SQLite'});return
            if path=='/api/auth/status' and method=='GET': self.respond({'configured':bool(db.execute("SELECT 1 FROM users WHERE role='analista'").fetchone()),'user':self.user(db),'databaseId':db.execute("SELECT value FROM metadata WHERE key='database_id'").fetchone()['value']});return
            if path in ('/api/auth/setup','/api/auth/login') and method=='POST':
                data=self.body();username=data.get('username','');password=data.get('password','');chosen=data.get('role')
                if chosen is not None and chosen not in ('analista','operario'): raise APIError('Rol inválido.')
                if not isinstance(username,str) or not isinstance(password,str) or not 3<=len(username.strip())<=60 or not 8<=len(password)<=200: raise APIError('Usuario o contraseña inválidos.')
                username=username.strip()
                if path.endswith('/setup'):
                    db.execute('BEGIN IMMEDIATE')
                    if db.execute("SELECT 1 FROM users WHERE role='analista'").fetchone(): raise APIError('El acceso ya está configurado. Inicia sesión.',409)
                    if db.execute('SELECT 1 FROM users WHERE username=?',(username,)).fetchone(): raise APIError('Ese usuario ya existe. Elige otro.',409)
                    salt=secrets.token_hex(16);user_id=db.execute("INSERT INTO users(username,role,salt,password_hash) VALUES(?,'analista',?,?)",(username,salt,hash_password(password,salt))).lastrowid;role='analista'
                else:
                    row=db.execute('SELECT * FROM users WHERE username=?',(username,)).fetchone()
                    # Sin usuario se deriva igualmente la clave para no revelar qué usuarios existen.
                    hashed=hash_password(password,row['salt'] if row else '00'*16)
                    if not row or not hmac.compare_digest(hashed,row['password_hash']): raise APIError('Usuario o contraseña incorrectos.',401)
                    user_id,role=row['id'],row['role']
                    # Quien elige «Ingresar como operario» no puede entrar con la cuenta del analista, ni al revés.
                    if chosen and role!=chosen: raise APIError(f'Estas credenciales no son de {chosen}. Vuelve y elige el otro rol.',401)
                cookie=self.session_cookie(db,user_id);db.commit();self.respond({'user':{'username':username,'role':role}},cookie=cookie);return
            if path=='/api/auth/logout' and method=='POST':
                self.body();cookie=SimpleCookie();cookie.load(self.headers.get('Cookie',''))
                if 'smed_session' in cookie: db.execute('DELETE FROM user_sessions WHERE token_hash=?',(hashlib.sha256(cookie['smed_session'].value.encode()).hexdigest(),))
                db.commit();self.respond({'ok':True},cookie='smed_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');return
            user=self.user(db,required=True)
            # El operario solo hace setups nuevos: lee la meta y guarda o corrige sus propias mediciones.
            if user['role']!='analista' and (method,path) not in OPERATOR_ROUTES: raise APIError('Esta sección es solo para el analista.',403)
            if path=='/api/config' and method=='GET':
                row=db.execute("SELECT value FROM metadata WHERE key='config'").fetchone()
                self.respond(json.loads(row['value']) if row else {'meta':33.6,'demo':False,'compare':False,'externas':[]});return
            if path=='/api/config' and method=='POST':
                value=self.body();meta=value.get('meta')
                if isinstance(meta,bool) or not isinstance(meta,(int,float)) or not math.isfinite(meta) or not 0<meta<=100000: raise APIError('Meta inválida.')
                externas=value.get('externas',[])
                if not isinstance(externas,list) or len(externas)>200 or any(not isinstance(x,str) or not 1<=len(x)<=180 for x in externas): raise APIError('Actividades externas inválidas.')
                value={'meta':meta,'demo':bool(value.get('demo')),'compare':bool(value.get('compare')),'externas':list(dict.fromkeys(externas))}
                db.execute("INSERT INTO metadata VALUES('config',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",(json.dumps(value),))
                db.commit();self.respond(value);return
            if path=='/api/records' and method=='GET':
                rows=db.execute('SELECT r.data,r.version,u.username,u.role FROM records r LEFT JOIN users u ON u.username=r.created_by ORDER BY r.updated DESC')
                self.respond({'records':[dict(json.loads(row['data']),_version=row['version'],_registradoPor={'username':row['username'],'role':row['role']} if row['username'] else None) for row in rows]});return
            if path=='/api/records/import' and method=='POST':
                data=self.body();records=data.get('records',[])
                if not isinstance(records,list) or len(records)>5000: raise APIError('Lista de importación inválida.')
                records=[validate_record(r) for r in records];inserted=0
                for r in records:
                    inserted+=db.execute('INSERT OR IGNORE INTO records(id,data,version,updated) VALUES(?,?,1,?)',(r['id'],json.dumps(r,ensure_ascii=False),time.time())).rowcount
                db.commit();self.respond({'imported':inserted});return
            if path=='/api/records/seed' and method=='POST':
                self.body();db.execute("DELETE FROM records WHERE json_extract(data,'$.origen')='Simulado'")
                for r in simulated_records(): db.execute('INSERT INTO records(id,data,version,updated) VALUES(?,?,1,?)',(r['id'],json.dumps(r,ensure_ascii=False),time.time()))
                db.commit();self.respond({'count':24});return
            if path=='/api/records' and method=='POST':
                value=self.body();r=validate_record(value);expected=value.get('_version',0);db.execute('BEGIN IMMEDIATE');old=db.execute('SELECT data,version,created_by FROM records WHERE id=?',(r['id'],)).fetchone()
                if user['role']=='operario':
                    if r['origen'] not in ('Planta','Demo'): raise APIError('Origen inválido.')
                    if old and old['created_by']!=user['username']: raise APIError('Solo puedes corregir tus propias mediciones.',403)
                if old:
                    if json.loads(old['data'])==r: self.respond(dict(r,_version=old['version'],_registradoPor=recorded_by(db,old['created_by'])));return
                    if expected!=old['version']: raise APIError('Esta medición cambió en otra sesión. Actualiza el historial antes de corregirla.',409)
                    version=old['version']+1;db.execute('UPDATE records SET data=?,version=?,updated=? WHERE id=?',(json.dumps(r,ensure_ascii=False),version,time.time(),r['id']))
                else:
                    if expected: raise APIError('La medición fue eliminada en otra sesión.',409)
                    version=1;db.execute('INSERT INTO records(id,data,version,updated,created_by) VALUES(?,?,?,?,?)',(r['id'],json.dumps(r,ensure_ascii=False),version,time.time(),user['username']))
                db.commit();self.respond(dict(r,_version=version,_registradoPor=recorded_by(db,old['created_by'] if old else user['username'])));return
            if path.startswith('/api/records/') and method=='DELETE':
                self.body();rid=unquote(path.removeprefix('/api/records/'));db.execute('DELETE FROM records WHERE id=?',(rid,));db.commit();self.respond({'ok':True});return
            raise APIError('No encontrado.',404)
    def handle_request(self,method):
        try: self.dispatch(method)
        except APIError as e: self.respond({'error':e.message},e.status)
        except (BrokenPipeError,ConnectionResetError): pass
        except Exception:
            __import__('traceback').print_exc();self.respond({'error':'No se pudo completar la operación en la base de datos.'},500)
    def do_GET(self): self.handle_request('GET')
    def do_POST(self): self.handle_request('POST')
    def do_DELETE(self): self.handle_request('DELETE')

def make_server(host='127.0.0.1',port=8080,db_path=None):
    path=Path(db_path or ROOT/'data'/'smed.sqlite3');initialize(path)
    server=ThreadingHTTPServer((host,port),Handler);server.db_path=path;return server

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--host',default='127.0.0.1');parser.add_argument('--port',type=int,default=8080);parser.add_argument('--db',type=Path);args=parser.parse_args()
    with make_server(args.host,args.port,args.db) as server:
        print(f'SMED: http://{args.host}:{args.port} · SQLite: {server.db_path}',flush=True)
        try: server.serve_forever()
        except KeyboardInterrupt: pass
