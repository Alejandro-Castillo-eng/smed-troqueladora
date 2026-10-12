"""Genera solo los archivos públicos de revisión para GitHub Pages."""
from pathlib import Path
import json, shutil, sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import server
root=Path(__file__).resolve().parents[1]
out=root/'pages-dist';out.mkdir(exist_ok=True)
html=(root/'index.html').read_text(encoding='utf-8')
html=html.replace('<script>\nconst STEPS =','<script src="./pages-adapter.js"></script>\n<script>\nconst STEPS =',1)
assert './pages-adapter.js' in html
html=html.replace('<span class="pill p-warn">Acceso para revisión</span>','<span class="pill p-warn">Revisión en GitHub Pages</span>',1)
html=html.replace('</dl></aside>','</dl><p class="note">Esta versión guarda los registros en este navegador.</p></aside>',1)
(out/'index.html').write_text(html,encoding='utf-8')
(out/'simulated-records.json').write_text(json.dumps(server.simulated_records(),ensure_ascii=False),encoding='utf-8')
shutil.copyfile(root/'scripts'/'pages-adapter.js',out/'pages-adapter.js')
(out/'.nojekyll').touch()
print('Versión GitHub Pages generada con 24 mediciones simuladas.')
