"""Genera la versión de GitHub Pages, conectada a la base compartida de Supabase."""
from pathlib import Path
import json, re, shutil, sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import server
root=Path(__file__).resolve().parents[1]
out=root/'pages-dist';out.mkdir(exist_ok=True)
html=(root/'index.html').read_text(encoding='utf-8')
html=html.replace('<script>\nconst STEPS =','<script src="./supabase-adapter.js"></script>\n<script>\nconst STEPS =',1)
assert './supabase-adapter.js' in html
# La versión publicada no muestra las credenciales: se entregan aparte a cada rol.
html,count=re.subn(r'<aside class="card review-access".*?</aside>','',html,count=1,flags=re.S)
assert count==1
html=html.replace('</style>','.login-grid{grid-template-columns:minmax(0,560px);justify-content:center}</style>',1)
(out/'index.html').write_text(html,encoding='utf-8')
# Solo se usan si el analista presiona «Restablecer simulaciones».
(out/'simulated-records.json').write_text(json.dumps(server.simulated_records(),ensure_ascii=False),encoding='utf-8')
shutil.copyfile(root/'scripts'/'supabase-adapter.js',out/'supabase-adapter.js')
(out/'.nojekyll').touch()
print('Versión GitHub Pages generada con Supabase.')
