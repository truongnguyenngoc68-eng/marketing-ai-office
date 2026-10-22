import http from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'dist');
const server=http.createServer(async(req,res)=>{try{const requested=decodeURIComponent(new URL(req.url,'http://localhost').pathname);const target=path.resolve(root,'.'+(requested==='/'?'/index.html':requested));if(!target.startsWith(root+path.sep)){res.writeHead(403);return res.end()}const body=await readFile(target);const type={'.css':'text/css','.js':'text/javascript','.png':'image/png','.html':'text/html'}[path.extname(target)]||'application/octet-stream';res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});res.end(body)}catch{res.writeHead(404);res.end('Not found')}});
server.listen(4318,'127.0.0.1',()=>console.log('Local preview: http://127.0.0.1:4318'));
