/* Adaptador de revisión para GitHub Pages: almacenamiento del navegador, sin servidor. */
(() => {
 const KEY='smed.pages.database.v1',SESSION='smed.pages.user.v1';
 // Cuentas de revisión: el analista mide y analiza; el operario tiene su propio panel.
 const ACCOUNTS={usuario:{password:'artefacto',role:'analista'},operario:{password:'troqueladora',role:'operario'}};
 const copy=x=>structuredClone(x);
 const read=()=>{try{return JSON.parse(localStorage.getItem(KEY))}catch{return null}};
 const write=value=>{try{localStorage.setItem(KEY,JSON.stringify(value))}catch{throw new Error('No se pudieron guardar los datos en este navegador. Exporta una copia antes de cerrar.')}};
 const user=()=>{const name=sessionStorage.getItem(SESSION);return name&&Object.hasOwn(ACCOUNTS,name)?{username:name,role:ACCOUNTS[name].role}:null};
 const fail=message=>{throw new Error(message)};
 const samples=async()=>{const response=await fetch('./simulated-records.json');if(!response.ok)fail('No se pudieron cargar los ejemplos.');return response.json()};
 async function db(){let value=read();if(!value){const records=await samples();value={records:records.map(r=>({...r,_version:1})),config:{meta:33.6,demo:false,compare:false}};write(value)}return value}
 window.smedPagesAPI=async(path,method='GET',body={})=>{
  if(path==='/api/auth/status')return {configured:true,user:user(),databaseId:'github-pages-review-v1'};
  if(path==='/api/auth/login'&&method==='POST'){const name=String(body.username||'').trim();if(!Object.hasOwn(ACCOUNTS,name)||ACCOUNTS[name].password!==body.password)fail('Usuario o contraseña incorrectos.');if(body.role&&ACCOUNTS[name].role!==body.role)fail(`Estas credenciales no son de ${body.role}. Vuelve y elige el otro rol.`);sessionStorage.setItem(SESSION,name);return{user:user()}}
  if(path==='/api/auth/logout'&&method==='POST'){sessionStorage.removeItem(SESSION);return{ok:true}}
  if(!user())fail('Inicia sesión para acceder a los registros.');
  // El operario solo hace setups nuevos: lee la meta y guarda o corrige sus propias mediciones.
  const operator=user().role!=='analista';
  if(operator&&!(path==='/api/config'&&method==='GET')&&!(path==='/api/records'&&method==='POST'))fail('Esta sección es solo para el analista.');
  const state=await db();state.owners=state.owners||{};
  if(path==='/api/config'){
   if(method==='POST'){if(!Number.isFinite(body.meta)||body.meta<=0)fail('Meta inválida.');state.config=copy(body);write(state)}return copy(state.config);
  }
  const withAuthor=r=>{const name=state.owners[r.id];return{...copy(r),_registradoPor:name&&Object.hasOwn(ACCOUNTS,name)?{username:name,role:ACCOUNTS[name].role}:null}};
  if(path==='/api/records'&&method==='GET')return{records:state.records.map(withAuthor)};
  if(path==='/api/records/import'&&method==='POST'){
   let count=0;for(const r of body.records||[]){if(!state.records.some(e=>e.id===r.id)){state.records.push({...copy(r),_version:1});count++}}write(state);return{imported:count};
  }
  if(path==='/api/records/seed'&&method==='POST'){
   const records=await samples();state.records=state.records.filter(r=>r.origen!=='Simulado').concat(records.map(r=>({...r,_version:1})));write(state);return{count:records.length};
  }
  if(path==='/api/records'&&method==='POST'){
   if(!body.id||!Array.isArray(body.entries)||!body.entries.length)fail('Registro inválido.');
   for(const e of body.entries)if(!Number.isFinite(e.minutes)||e.minutes<0)fail('Duración inválida.');
   const record=copy(body),version=record._version||0;delete record._version;delete record._registradoPor;
   const index=state.records.findIndex(r=>r.id===record.id);let nextVersion=1;
   if(operator&&!['Planta','Demo'].includes(record.origen))fail('Origen inválido.');
   if(operator&&index>=0&&state.owners[record.id]!==user().username)fail('Solo puedes corregir tus propias mediciones.');
   if(index>=0){const previous=copy(state.records[index]),oldVersion=previous._version;delete previous._version;if(JSON.stringify(previous)===JSON.stringify(record))return withAuthor(state.records[index]);if(version!==oldVersion)fail('Esta medición cambió en otra pestaña. Actualiza el historial antes de corregirla.');nextVersion=oldVersion+1}
   else if(version)fail('La medición fue eliminada en otra pestaña.');
   const saved={...record,_version:nextVersion};if(index>=0)state.records[index]=saved;else{state.records.push(saved);state.owners[saved.id]=user().username}write(state);return withAuthor(saved);
  }
  if(path.startsWith('/api/records/')&&method==='DELETE'){const id=decodeURIComponent(path.slice('/api/records/'.length));state.records=state.records.filter(r=>r.id!==id);write(state);return{ok:true}}
  fail('Operación no disponible en la versión de revisión.');
 };
})();
