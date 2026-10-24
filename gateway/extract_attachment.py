import sys, json, zipfile, re, html
from pathlib import Path
from xml.etree import ElementTree as ET
sys.stdout.reconfigure(encoding='utf-8')
p=Path(sys.argv[1]);suffix=p.suffix.lower()
if suffix=='.docx':
 with zipfile.ZipFile(p) as z:
  info=z.getinfo('word/document.xml')
  if info.file_size>12000000:raise ValueError('Document too large')
  root=ET.fromstring(z.read(info));ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
  text='\n'.join(''.join(t.text or '' for t in para.findall('.//w:t',ns)) for para in root.findall('.//w:p',ns))
elif suffix=='.pdf':
 from pypdf import PdfReader
 reader=PdfReader(p)
 if len(reader.pages)>150:raise ValueError('Too many pages')
 text='\n'.join(f'[Trang {i+1}]\n'+(page.extract_text() or '') for i,page in enumerate(reader.pages))
else:
 text=p.read_text(encoding='utf-8-sig',errors='replace')
 if suffix=='.html':
  text=re.sub(r'<(script|style)\b[^>]*>.*?</\1>','',text,flags=re.S|re.I)
  text=html.unescape(re.sub('<[^>]+>',' ',text))
print(json.dumps({'text':text[:100000]},ensure_ascii=False))
