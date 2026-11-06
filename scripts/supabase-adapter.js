/* Adaptador de GitHub Pages: guarda las mediciones en la base compartida de Supabase.
   Las tablas no son accesibles desde la API pública; la página solo llama a las funciones
   public.smed_* (supabase/migrations), que validan la sesión y el rol como server.py.
   La clave publicable puede estar en la página: por sí sola no da acceso a ningún dato. */
(() => {
 const URL_BASE='https://ifzdzotedjlubchvtfwn.supabase.co/rest/v1/rpc/';
 const KEY='sb_publishable_txZ8FiAhwyzu8R1cOhEesQ_6Kq-G7I4';
 const SESSION='smed.supabase.session.v1';
 const token=()=>{try{return localStorage.getItem(SESSION)}catch{return null}};
 const setToken=value=>{try{value?localStorage.setItem(SESSION,value):localStorage.removeItem(SESSION)}catch{}};
 async function rpc(name,args={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
  let response,value;
  try{
   response=await fetch(URL_BASE+name,{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json',apikey:KEY},body:JSON.stringify(args)});
   value=await response.json().catch(()=>null);
  }catch{throw new Error('No se pudo conectar con el servidor. La medición pendiente se conserva para reintentar.')}
  finally{clearTimeout(timer)}
  if(!response.ok)throw new Error(value?.message||'No se pudo completar la operación.');
  if(value&&typeof value==='object'&&!Array.isArray(value)&&value.error)throw new Error(value.error);
  return value;
 }
 const withToken=args=>({p_token:token(),...args});
 window.smedPagesAPI=async(path,method='GET',body={})=>{
  if(path==='/api/auth/status'){const status=await rpc('smed_status',withToken());if(!status.user)setToken(null);return status}
  if(path==='/api/auth/login'&&method==='POST'){
   const result=await rpc('smed_login',{p_username:body.username,p_password:body.password,p_role:body.role??null});
   setToken(result.token);return{user:result.user};
  }
  // Sin conexión se cierra igualmente la sesión en este equipo.
  if(path==='/api/auth/logout'&&method==='POST'){try{await rpc('smed_logout',withToken())}catch{}setToken(null);return{ok:true}}
  if(path==='/api/config')return method==='POST'?rpc('smed_set_config',withToken({p_value:body})):rpc('smed_get_config',withToken());
  if(path==='/api/records'&&method==='GET')return{records:await rpc('smed_list_records',withToken())};
  if(path==='/api/records'&&method==='POST')return rpc('smed_save_record',withToken({p_record:body}));
  if(path==='/api/records/import'&&method==='POST')return rpc('smed_import_records',withToken({p_records:body.records||[]}));
  if(path==='/api/records/seed'&&method==='POST'){
   const response=await fetch('./simulated-records.json');if(!response.ok)throw new Error('No se pudieron cargar los ejemplos.');
   return rpc('smed_seed_records',withToken({p_records:await response.json()}));
  }
  if(path.startsWith('/api/records/')&&method==='DELETE')return rpc('smed_delete_record',withToken({p_id:decodeURIComponent(path.slice('/api/records/'.length))}));
  throw new Error('Operación no disponible en la versión publicada.');
 };
})();
