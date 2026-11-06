-- Base de datos compartida de SMED · Troqueladora en Supabase.
-- Las tablas viven en el esquema privado «smed», que la API no expone. La aplicación
-- publicada solo puede llamar a las funciones public.smed_*, que revisan la sesión y
-- el rol igual que server.py: el operario lee la configuración y guarda o corrige sus
-- propias mediciones; el resto es del analista.
-- Las cuentas se crean aparte (ver README) para que sus contraseñas no queden en el repositorio.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists smed;
revoke all on schema smed from public, anon, authenticated;

create table if not exists smed.users (
  id bigint generated always as identity primary key,
  username text not null unique,
  role text not null check (role in ('analista', 'operario')),
  password_hash text not null
);
create table if not exists smed.sessions (
  token_hash text primary key,
  user_id bigint not null references smed.users(id) on delete cascade,
  expires timestamptz not null
);
create index if not exists sessions_user_id on smed.sessions(user_id);
create table if not exists smed.login_attempts (
  username text not null,
  attempted_at timestamptz not null default now()
);
create index if not exists login_attempts_username on smed.login_attempts(username, attempted_at);
create table if not exists smed.records (
  id text primary key,
  data jsonb not null,
  version integer not null default 1,
  updated timestamptz not null default now(),
  created_by text
);
create table if not exists smed.config (
  id boolean primary key default true check (id),
  value jsonb not null
);
alter table smed.users enable row level security;
alter table smed.sessions enable row level security;
alter table smed.login_attempts enable row level security;
alter table smed.records enable row level security;
alter table smed.config enable row level security;
revoke all on all tables in schema smed from public, anon, authenticated;

-- Usuario de una sesión vigente; si se pide, exige que sea analista.
create or replace function smed.account(p_token text, p_analyst boolean)
returns smed.users language plpgsql stable security definer set search_path = '' as $$
declare u smed.users;
begin
  select a.* into u from smed.sessions s join smed.users a on a.id = s.user_id
   where s.token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex') and s.expires > now();
  if u.id is null then raise exception 'Inicia sesión para acceder a los registros.'; end if;
  if p_analyst and u.role <> 'analista' then raise exception 'Esta sección es solo para el analista.'; end if;
  return u;
end $$;

-- Quién creó la medición; las anteriores a los roles no lo registran.
create or replace function smed.author(p_username text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('username', username, 'role', role) from smed.users where username = p_username
$$;

-- Mismas reglas que validate_record de server.py.
create or replace function smed.validate_record(p jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare r jsonb; e jsonb; ids text[] := '{}';
begin
  if jsonb_typeof(p) is distinct from 'object' then raise exception 'Registro inválido.'; end if;
  if length(p::text) > 4194304 then raise exception 'Solicitud demasiado grande.'; end if;
  r := p - '_version' - '_registradoPor';
  if jsonb_typeof(r->'id') is distinct from 'string' or length(r->>'id') not between 1 and 100 then
    raise exception 'Identificador inválido.'; end if;
  if coalesce(r->>'fecha', '') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Fecha inválida.'; end if;
  begin perform (r->>'fecha')::date; exception when others then raise exception 'Fecha inválida.'; end;
  if coalesce(r->>'origen', '') not in ('Planta', 'Demo', 'Piloto', 'Simulado') then raise exception 'Origen inválido.'; end if;
  if r ? 'entries' then
    if jsonb_typeof(r->'entries') is distinct from 'array' or jsonb_array_length(r->'entries') not between 1 and 500 then
      raise exception 'Lista de actividades inválida.'; end if;
    for e in select value from jsonb_array_elements(r->'entries') loop
      if jsonb_typeof(e) is distinct from 'object' or jsonb_typeof(e->'name') is distinct from 'string'
         or length(e->>'name') not between 1 and 180 then raise exception 'Actividad inválida.'; end if;
      if jsonb_typeof(e->'id') is distinct from 'string' or (e->>'id') = any(ids) then
        raise exception 'Identificador de actividad inválido.'; end if;
      ids := ids || (e->>'id');
      if coalesce(e->>'type', '') not in ('Actividad', 'Repetición', 'Incidencia')
         or coalesce(e->>'status', '') not in ('Registrada', 'Omitida') then raise exception 'Estado o tipo inválido.'; end if;
      if (case when jsonb_typeof(e->'minutes') = 'number' then (e->'minutes')::numeric not between 0 and 100000 else true end) then
        raise exception 'Duración inválida.'; end if;
    end loop;
  elsif jsonb_typeof(r->'t') is distinct from 'array' or jsonb_array_length(r->'t') <> 15
     or exists (select 1 from jsonb_array_elements(r->'t') as t(v) where case when jsonb_typeof(v) = 'number' then v::numeric < 0 else true end) then
    raise exception 'Faltan los tiempos de las actividades.';
  end if;
  return r;
end $$;

create or replace function public.smed_status(p_token text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare usr jsonb;
begin
  select jsonb_build_object('username', a.username, 'role', a.role) into usr
    from smed.sessions s join smed.users a on a.id = s.user_id
   where s.token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex') and s.expires > now();
  return jsonb_build_object('configured', true, 'user', usr, 'databaseId', 'supabase-smed-v1');
end $$;

-- Los intentos fallidos se devuelven como {error} en vez de excepción para que queden
-- registrados: tras 10 fallos en 15 minutos el usuario queda bloqueado ese tiempo.
create or replace function public.smed_login(p_username text, p_password text, p_role text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u smed.users; v_name text := btrim(coalesce(p_username, '')); v_token text;
begin
  if p_role is not null and p_role not in ('analista', 'operario') then raise exception 'Rol inválido.'; end if;
  if length(v_name) not between 3 and 60 or coalesce(length(p_password), 0) not between 8 and 200 then
    raise exception 'Usuario o contraseña inválidos.'; end if;
  delete from smed.login_attempts where attempted_at < now() - interval '1 day';
  if (select count(*) from smed.login_attempts where username = lower(v_name) and attempted_at > now() - interval '15 minutes') >= 10 then
    return jsonb_build_object('error', 'Demasiados intentos fallidos. Espera 15 minutos e inténtalo de nuevo.'); end if;
  select * into u from smed.users where username = v_name;
  -- Sin usuario se calcula igualmente un hash para no revelar qué usuarios existen.
  if u.id is null or u.password_hash <> extensions.crypt(p_password, coalesce(u.password_hash, extensions.gen_salt('bf', 10))) then
    insert into smed.login_attempts(username) values (lower(v_name));
    return jsonb_build_object('error', 'Usuario o contraseña incorrectos.');
  end if;
  -- Quien elige «Ingresar como operario» no puede entrar con la cuenta del analista, ni al revés.
  if p_role is not null and u.role <> p_role then
    return jsonb_build_object('error', 'Estas credenciales no son de ' || p_role || '. Vuelve y elige el otro rol.'); end if;
  delete from smed.login_attempts where username = lower(v_name);
  delete from smed.sessions where expires < now();
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into smed.sessions(token_hash, user_id, expires)
    values (encode(extensions.digest(v_token, 'sha256'), 'hex'), u.id, now() + interval '12 hours');
  return jsonb_build_object('token', v_token, 'user', jsonb_build_object('username', u.username, 'role', u.role));
end $$;

create or replace function public.smed_logout(p_token text default null)
returns jsonb language sql security definer set search_path = '' as $$
  delete from smed.sessions where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
  select jsonb_build_object('ok', true);
$$;

create or replace function public.smed_get_config(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform smed.account(p_token, false);
  return coalesce((select value from smed.config),
    jsonb_build_object('meta', 33.6, 'demo', false, 'compare', false, 'externas', '[]'::jsonb));
end $$;

create or replace function public.smed_set_config(p_token text, p_value jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb; ext jsonb := coalesce(p_value->'externas', '[]'::jsonb);
begin
  perform smed.account(p_token, true);
  if (case when jsonb_typeof(p_value->'meta') = 'number' then (p_value->'meta')::numeric <= 0 or (p_value->'meta')::numeric > 100000
     else true end) then raise exception 'Meta inválida.'; end if;
  if jsonb_typeof(ext) <> 'array' or jsonb_array_length(ext) > 200
     or exists (select 1 from jsonb_array_elements(ext) as t(x) where case when jsonb_typeof(x) = 'string' then length(x #>> '{}') not between 1 and 180 else true end) then
    raise exception 'Actividades externas inválidas.'; end if;
  v := jsonb_build_object('meta', p_value->'meta',
    'demo', coalesce(jsonb_typeof(p_value->'demo') = 'boolean' and (p_value->>'demo')::boolean, false),
    'compare', coalesce(jsonb_typeof(p_value->'compare') = 'boolean' and (p_value->>'compare')::boolean, false),
    'externas', (select coalesce(jsonb_agg(x order by first_n), '[]'::jsonb)
                   from (select x, min(n) as first_n from jsonb_array_elements_text(ext) with ordinality t(x, n) group by x) d));
  insert into smed.config(id, value) values (true, v) on conflict (id) do update set value = excluded.value;
  return v;
end $$;

create or replace function public.smed_list_records(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform smed.account(p_token, true);
  return (select coalesce(jsonb_agg(r.data || jsonb_build_object('_version', r.version, '_registradoPor',
            case when a.username is null then null else jsonb_build_object('username', a.username, 'role', a.role) end)
          order by r.updated desc), '[]'::jsonb)
          from smed.records r left join smed.users a on a.username = r.created_by);
end $$;

-- Guardar o corregir una medición. _version evita sobrescribir cambios de otra sesión
-- y los reintentos del mismo registro no lo duplican.
create or replace function public.smed_save_record(p_token text, p_record jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u smed.users := smed.account(p_token, false); r jsonb := smed.validate_record(p_record);
        prev smed.records; expected integer := 0; next_version integer; v_owner text;
begin
  if jsonb_typeof(p_record->'_version') = 'number' then expected := (p_record->'_version')::numeric::integer; end if;
  select * into prev from smed.records where id = r->>'id' for update;
  if u.role = 'operario' then
    if r->>'origen' not in ('Planta', 'Demo') then raise exception 'Origen inválido.'; end if;
    if prev.id is not null and prev.created_by is distinct from u.username then
      raise exception 'Solo puedes corregir tus propias mediciones.'; end if;
  end if;
  if prev.id is not null then
    v_owner := prev.created_by;
    if prev.data = r then return r || jsonb_build_object('_version', prev.version, '_registradoPor', smed.author(v_owner)); end if;
    if expected <> prev.version then
      raise exception 'Esta medición cambió en otra sesión. Actualiza el historial antes de corregirla.'; end if;
    next_version := prev.version + 1;
    update smed.records set data = r, version = next_version, updated = now() where id = prev.id;
  else
    if expected <> 0 then raise exception 'La medición fue eliminada en otra sesión.'; end if;
    next_version := 1; v_owner := u.username;
    insert into smed.records(id, data, version, created_by) values (r->>'id', r, 1, u.username);
  end if;
  return r || jsonb_build_object('_version', next_version, '_registradoPor', smed.author(v_owner));
end $$;

create or replace function public.smed_delete_record(p_token text, p_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform smed.account(p_token, true);
  delete from smed.records where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- Importa solo identificadores que todavía no existen.
create or replace function public.smed_import_records(p_token text, p_records jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r jsonb; inserted integer := 0; n integer;
begin
  perform smed.account(p_token, true);
  if jsonb_typeof(p_records) is distinct from 'array' or jsonb_array_length(p_records) > 5000 then
    raise exception 'Lista de importación inválida.'; end if;
  for r in select smed.validate_record(value) from jsonb_array_elements(p_records) loop
    insert into smed.records(id, data) values (r->>'id', r) on conflict (id) do nothing;
    get diagnostics n = row_count; inserted := inserted + n;
  end loop;
  return jsonb_build_object('imported', inserted);
end $$;

-- Renueva únicamente los registros simulados; las mediciones de planta y piloto se conservan.
create or replace function public.smed_seed_records(p_token text, p_records jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r jsonb;
begin
  perform smed.account(p_token, true);
  if jsonb_typeof(p_records) is distinct from 'array' or jsonb_array_length(p_records) > 100 then
    raise exception 'Lista de ejemplos inválida.'; end if;
  delete from smed.records where data->>'origen' = 'Simulado';
  for r in select smed.validate_record(value) from jsonb_array_elements(p_records) loop
    if r->>'origen' <> 'Simulado' then raise exception 'Los ejemplos deben ser de origen Simulado.'; end if;
    insert into smed.records(id, data) values (r->>'id', r)
      on conflict (id) do update set data = excluded.data, version = 1, updated = now();
  end loop;
  return jsonb_build_object('count', jsonb_array_length(p_records));
end $$;

revoke all on all functions in schema smed from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array['smed_status(text)', 'smed_login(text,text,text)', 'smed_logout(text)',
    'smed_get_config(text)', 'smed_set_config(text,jsonb)', 'smed_list_records(text)', 'smed_save_record(text,jsonb)',
    'smed_delete_record(text,text)', 'smed_import_records(text,jsonb)', 'smed_seed_records(text,jsonb)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end $$;
