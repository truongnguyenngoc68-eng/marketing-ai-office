import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';

function matchesToken(actual,expected){if(!expected)return false;const a=Buffer.from(actual||''),b=Buffer.from('Bearer '+expected);return a.length===b.length&&timingSafeEqual(a,b)}
export function createGateway({agents=[],token='',allowedOrigins=[],fetchImpl=fetch,timeoutMs=120000,maxConcurrent=2,env=process.env}={}){
 let running=0;
 const known=new Map(agents.map(agent=>[agent.id,agent]));
 return http.createServer(async(req,res)=>{
  const origin=req.headers.origin;
  const json=(status,data)=>{if(res.destroyed)return;res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data))};
  if(origin&&!allowedOrigins.includes(origin))return json(403,{error:'Origin chưa được phép ở cổng agent.'});
  if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS')}
  if(req.method==='OPTIONS'){res.writeHead(204);return res.end()}
  const route=new URL(req.url,'http://gateway.local').pathname;
  if(route==='/health'&&req.method==='GET')return json(200,{status:'ok',ready:!!token&&known.size>0,protocol:'tram-agent-v1',capabilities:['text-tasks'],executesCode:false});
  if(!matchesToken(req.headers.authorization,token))return json(401,{error:token?'Token truy cập cổng không đúng hoặc bị thiếu.':'Chưa đặt TRAM_GATEWAY_TOKEN trên máy chủ.'});
  if(route==='/agents'&&req.method==='GET')return json(200,{agents:agents.map(a=>({id:a.id,name:a.name,capabilities:['text-task']}))});
  if(route!=='/tasks'||req.method!=='POST')return json(404,{error:'Không tìm thấy endpoint.'});
  if(running>=maxConcurrent)return json(429,{error:'Cổng đang xử lý đủ số tác vụ cho phép. Hãy thử lại khi tác vụ trước hoàn tất.'});
  let data;try{let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>64000)return json(413,{error:'Tác vụ vượt giới hạn 64 KB.'});chunks.push(chunk)}data=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{return json(400,{error:'Body JSON không hợp lệ.'})}
  if(!data||typeof data.agentId!=='string'||typeof data.task!=='string'||!data.task.trim()||data.task.length>12000||typeof data.projectId!=='string'||data.projectId.length>100||typeof data.roleId!=='string'||!/^TC-\d{3}$/.test(data.roleId))return json(400,{error:'Tác vụ thiếu hoặc sai các trường agentId, roleId, projectId, task.'});
  const agent=known.get(data.agentId);if(!agent)return json(400,{error:'Agent không nằm trong danh sách đã cấu hình.'});
  if(data.context&&((typeof data.context.projectName!=='string'||data.context.projectName.length>100)||(typeof data.context.knowledge!=='string'||data.context.knowledge.length>12000)))return json(400,{error:'Ngữ cảnh dự án không hợp lệ.'});
  let endpoint;try{endpoint=new URL(agent.endpoint);if(endpoint.username||endpoint.password||!['https:','http:'].includes(endpoint.protocol))throw Error();if(endpoint.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(endpoint.hostname))throw Error()}catch{return json(503,{error:'Địa chỉ upstream không hợp lệ. Người quản trị cần cấu hình HTTPS hoặc loopback HTTP.'})}
  const upstreamToken=agent.tokenEnv?env[agent.tokenEnv]:null;if(agent.tokenEnv&&!upstreamToken)return json(503,{error:'Biến môi trường xác thực upstream chưa được đặt.'});
  if(running>=maxConcurrent)return json(429,{error:'Cổng đang xử lý đủ số tác vụ cho phép.'});
  running++;const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),timeoutMs);
  try{
   const response=await fetchImpl(endpoint,{method:'POST',redirect:'error',signal:controller.signal,headers:{'Content-Type':'application/json',...(upstreamToken?{Authorization:'Bearer '+upstreamToken}:{})},body:JSON.stringify({agentId:agent.id,roleId:data.roleId,projectId:data.projectId,task:data.task,context:data.context||{projectName:'',knowledge:''}})});
   if(!response.ok)return json(502,{error:'Agent upstream trả lỗi. Kiểm tra nhật ký riêng của dịch vụ agent.'});
   const text=await response.text();if(text.length>250000)return json(502,{error:'Đầu ra agent vượt giới hạn.'});const result=JSON.parse(text);
   if(result.status!=='completed'||typeof result.output!=='string'||result.output.length>200000)return json(502,{error:'Agent cần trả {status: "completed", output: "văn bản"} theo hợp đồng.'});
   return json(200,{status:'completed',output:result.output,agentId:agent.id,source:'agent-gateway',verified:false});
  }catch(error){return json(error.name==='AbortError'?504:502,{error:error.name==='AbortError'?'Tác vụ vượt giới hạn thời gian.':'Không gọi được agent upstream hoặc phản hồi sai định dạng.'})}finally{clearTimeout(timeout);running--}
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 let agents=[];if(process.env.TRAM_AGENTS_FILE){const config=JSON.parse(await readFile(process.env.TRAM_AGENTS_FILE,'utf8'));if(!Array.isArray(config.agents)||!config.agents.every(a=>a&&typeof a.id==='string'&&typeof a.name==='string'&&typeof a.endpoint==='string')||new Set(config.agents.map(a=>a.id)).size!==config.agents.length)throw Error('Invalid agent configuration');agents=config.agents;}
 const allowedOrigins=(process.env.TRAM_ALLOWED_ORIGINS||'http://127.0.0.1:4318,http://localhost:4318,https://marketing-ai-office-truon.coralocean128.chatgpt.site').split(',').map(x=>x.trim()).filter(Boolean);
 const port=Number(process.env.TRAM_GATEWAY_PORT||4320);const server=createGateway({agents,token:process.env.TRAM_GATEWAY_TOKEN||'',allowedOrigins});
 server.listen(port,'127.0.0.1',()=>console.log(`Trạm agent gateway: http://127.0.0.1:${port} · ${agents.length} configured agents · upstream credentials stay on server`));
}
