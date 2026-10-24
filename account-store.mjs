import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,randomUUID,scrypt as scryptCallback,timingSafeEqual,createHash,createCipheriv,createDecipheriv} from 'node:crypto';
import {promisify} from 'node:util';
const scrypt=promisify(scryptCallback);
const hashToken=t=>createHash('sha256').update(t).digest('hex');
const publicUser=u=>u?{id:u.id,name:u.name,email:u.email,isLocalAdmin:u.isLocalAdmin===true}:null;
const safeError=(status,message)=>Object.assign(new Error(message),{status});
const sessionAge=7*24*60*60*1000;

export async function createAccountStore(dataRoot,{fetchImpl=fetch,now=()=>Date.now()}={}){
 await mkdir(dataRoot,{recursive:true});
 const dbPath=path.join(dataRoot,'accounts.json');let db={version:1,users:[],sessions:[],projects:[]};
 try{db=JSON.parse(await readFile(dbPath,'utf8'));if(db.version!==1||!Array.isArray(db.users)||!Array.isArray(db.projects)||!Array.isArray(db.sessions))throw Error('Invalid account database')}catch(e){if(e.code!=='ENOENT')throw e}
 let secret;const secretPath=path.join(dataRoot,'.account-secret');try{secret=await readFile(secretPath);if(secret.length!==32)throw Error('Invalid account secret')}catch(e){if(e.code!=='ENOENT')throw e;secret=randomBytes(32);await writeFile(secretPath,secret,{mode:0o600,flag:'wx'})}
 let queue=Promise.resolve();const failures=new Map(),registrations=new Map(),notificationInFlight=new Map();
 async function mutate(fn){const task=queue.then(async()=>{const snapshot=structuredClone(db);try{const value=await fn();const temp=dbPath+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(db),{mode:0o600});await rename(temp,dbPath);return value}catch(e){db=snapshot;throw e}});queue=task.catch(()=>{});return task}
 function encrypt(value){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',secret,iv);const data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return {iv:iv.toString('base64'),data:data.toString('base64'),tag:cipher.getAuthTag().toString('base64')}}
 function decrypt(value){const decipher=createDecipheriv('aes-256-gcm',secret,Buffer.from(value.iv,'base64'));decipher.setAuthTag(Buffer.from(value.tag,'base64'));return Buffer.concat([decipher.update(Buffer.from(value.data,'base64')),decipher.final()]).toString('utf8')}
 function cookieToken(req){const part=(req.headers?.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('tram_session='));if(!part)return null;const token=part.slice(13);return /^[a-f0-9]{64}$/.test(token)?token:null}
 async function getUser(req){await queue;const token=cookieToken(req);if(!token)return null;const session=db.sessions.find(s=>s.hash===hashToken(token)&&s.expiresAt>now());return session?publicUser(db.users.find(u=>u.id===session.userId)):null}
 function authorizedRecord(userId,id){const record=db.projects.find(p=>p.id===id);if(!record||!(record.ownerId===userId||record.memberIds.includes(userId)))throw safeError(404,'Không tìm thấy dự án được phép truy cập.');return record}
 function publicRecord(r){return {project:structuredClone(r.project),version:r.version,ownerId:r.ownerId,members:[r.ownerId,...r.memberIds].map(id=>publicUser(db.users.find(u=>u.id===id))).filter(Boolean),updatedAt:r.updatedAt}}
 async function canAccessProject(userId,id){await queue;try{authorizedRecord(userId,id);return true}catch{return false}}
 async function listProjects(userId){await queue;return db.projects.filter(p=>p.ownerId===userId||p.memberIds.includes(userId)).map(publicRecord)}
 function validateProject(project){if(!project||typeof project!=='object'||Array.isArray(project)||typeof project.id!=='string'||!/^[a-z0-9-]{1,100}$/.test(project.id)||typeof project.name!=='string'||!project.name.trim()||project.name.length>100||JSON.stringify(project).length>2500000)throw safeError(400,'Dự án không đúng định dạng hoặc vượt giới hạn.');return structuredClone(project)}
 function appendAudit(record,userId,action,detail){const user=db.users.find(u=>u.id===userId);record.audit.push({id:randomUUID(),userId,userName:user?.name||'Tài khoản',action:String(action).slice(0,80),detail:String(detail||'').slice(0,1000),time:new Date(now()).toISOString(),version:record.version});record.audit=record.audit.slice(-500)}
 async function saveProject(userId,project,expectedVersion){const cleaned=validateProject(project);return mutate(()=>{if(!db.users.some(u=>u.id===userId))throw safeError(401,'Cần đăng nhập.');let record=db.projects.find(p=>p.id===cleaned.id);if(record){authorizedRecord(userId,cleaned.id);if(!Number.isInteger(expectedVersion)||expectedVersion!==record.version)throw safeError(409,'Dự án đã được sửa ở phiên khác. Tải lại trước khi lưu để tránh ghi đè.');if(JSON.stringify(record.project)===JSON.stringify(cleaned))return publicRecord(record);record.history.push({version:record.version,project:structuredClone(record.project),userId:record.lastEditorId,time:record.updatedAt});record.history=record.history.slice(-40);record.project=cleaned;record.version++;record.updatedAt=new Date(now()).toISOString();record.lastEditorId=userId;appendAudit(record,userId,'project.updated','Lưu phiên bản dự án');}else{if(expectedVersion!==0&&expectedVersion!==undefined)throw safeError(409,'Phiên bản tạo mới không hợp lệ.');if(db.projects.filter(p=>p.ownerId===userId).length>=50)throw safeError(400,'Mỗi tài khoản tối đa 50 dự án.');record={id:cleaned.id,ownerId:userId,memberIds:[],project:cleaned,version:1,history:[],audit:[],updatedAt:new Date(now()).toISOString(),lastEditorId:userId};db.projects.push(record);appendAudit(record,userId,'project.created','Tạo dự án');}return publicRecord(record)})}
 async function audit(userId,projectId,action,detail){return mutate(()=>{const record=authorizedRecord(userId,projectId);appendAudit(record,userId,action,detail);return true})}
 function notificationPublic(config){return {enabled:config?.enabled===true,chatId:config?.chatId||'',hasToken:!!config?.token,lastStatus:config?.lastStatus||'',lastSentAt:config?.lastSentAt||null}}
 async function sendTelegram(userId,text){
  await queue;
  const user=db.users.find(u=>u.id===userId),config=user?.notifications;
  if(!config?.enabled||!config.token||!config.chatId)return {sent:false,reason:'not_configured'};
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),12000);
  try{
   const token=decrypt(config.token);
   const response=await fetchImpl('https://api.telegram.org/bot'+token+'/sendMessage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:config.chatId,text:String(text).slice(0,3000),disable_web_page_preview:true}),signal:controller.signal});
   if(!response.ok)throw Error('Telegram refused request');
   const result=await response.json();
   if(result.ok!==true)throw Error('Telegram did not accept');
   await mutate(()=>{const current=db.users.find(u=>u.id===userId);if(current?.notifications){current.notifications.lastStatus='sent';current.notifications.lastSentAt=new Date(now()).toISOString()}});
   return {sent:true};
  }catch{
   await mutate(()=>{const current=db.users.find(u=>u.id===userId);if(current?.notifications)current.notifications.lastStatus='failed'});
   return {sent:false,reason:'delivery_failed'};
  }finally{clearTimeout(timeout)}
 }
 async function notifyJob(job){
  const userId=job.userId||job.ownerId;
  if(!userId||!['completed','failed','cancelled','interrupted'].includes(job.state))return {sent:false,reason:'not_applicable'};
  await queue;
  let record;try{record=authorizedRecord(userId,job.projectId)}catch{return {sent:false,reason:'not_authorized'}}
  const key=job.id?String(job.id).slice(0,100)+':'+job.state:null;
  const config=db.users.find(u=>u.id===userId)?.notifications;
  if(key&&config?.sentJobKeys?.includes(key))return {sent:false,reason:'already_sent'};
  const flightKey=userId+':'+key;
  if(key&&notificationInFlight.has(flightKey))return notificationInFlight.get(flightKey);
  const task=(async()=>{
   const result=await sendTelegram(userId,`Trạm Công nghệ\nDự án: ${record.project.name}\nTrạng thái: ${job.state==='completed'?'Đã hoàn tất':job.state==='failed'?'Chưa hoàn tất / lỗi':'Đã dừng'}\nTác vụ: ${String(job.type||'agent').slice(0,60)}\nMở Trạm trên máy để xem kết quả. Không gửi nội dung tài liệu hoặc mã nguồn qua thông báo.`);
   if(result.sent&&key)await mutate(()=>{const current=db.users.find(u=>u.id===userId)?.notifications;if(current)current.sentJobKeys=[...(current.sentJobKeys||[]),key].slice(-200)});
   return result;
  })();
  if(key)notificationInFlight.set(flightKey,task);
  try{return await task}finally{if(key)notificationInFlight.delete(flightKey)}
 }
 function limit(map,key,count,windowMs){const current=map.get(key);if(current&&current.reset>now()){if(current.count>=count)throw safeError(429,'Quá nhiều lần thử. Vui lòng thử lại sau.');current.count++;}else map.set(key,{count:1,reset:now()+windowMs});if(map.size>2000)for(const[k,v]of map)if(v.reset<now())map.delete(k)}
 function setSessionCookie(res,token,req,clear=false){res.setHeader('Set-Cookie',`tram_session=${clear?'':token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear?0:Math.floor(sessionAge/1000)}${req.socket?.encrypted?'; Secure':''}`)}
 async function createSession(userId,res,req){const token=randomBytes(32).toString('hex');await mutate(()=>{db.sessions=db.sessions.filter(s=>s.expiresAt>now());db.sessions.push({hash:hashToken(token),userId,expiresAt:now()+sessionAge});db.sessions=db.sessions.slice(-500)});setSessionCookie(res,token,req);return publicUser(db.users.find(u=>u.id===userId))}
 async function handle(req,res,route,readJson){if(!route.startsWith('/api/tram/auth/')&&route!=='/api/tram/projects'&&!/^\/api\/tram\/projects\/[^/]+\/(history|members|restore)$/.test(route)&&!route.startsWith('/api/tram/notifications'))return false;const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data))};try{
  const ip=req.socket?.remoteAddress||'local';
  if(!['GET','HEAD'].includes(req.method)){const origin=req.headers?.origin;if(origin&&origin!==`http://${req.headers.host}`&&origin!==`https://${req.headers.host}`)throw safeError(403,'Nguồn yêu cầu không hợp lệ.');if(!String(req.headers?.['content-type']||'').toLowerCase().startsWith('application/json'))throw safeError(415,'Yêu cầu phải dùng JSON.');}
  if(route==='/api/tram/auth/me'&&req.method==='GET'){send(200,{user:await getUser(req)});return true}
  if(route==='/api/tram/auth/register'&&req.method==='POST'){
   limit(registrations,ip,10,3600000);const b=await readJson(req,20000),email=typeof b.email==='string'?b.email.trim().toLowerCase():'';if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>200||typeof b.name!=='string'||!b.name.trim()||b.name.length>80||typeof b.password!=='string'||b.password.length<12||b.password.length>200)throw safeError(400,'Cần tên, email hợp lệ và mật khẩu 12–200 ký tự.');
   const salt=randomBytes(16).toString('hex'),hash=(await scrypt(b.password,salt,64)).toString('hex');const user=await mutate(()=>{if(db.users.length>=100)throw safeError(400,'Máy chủ đã đạt giới hạn tài khoản.');if(db.users.some(u=>u.email===email))throw safeError(409,'Email đã được đăng ký.');const u={id:randomUUID(),isLocalAdmin:db.users.length===0,name:b.name.trim(),email,password:{salt,hash},createdAt:new Date(now()).toISOString()};db.users.push(u);return u});send(201,{user:await createSession(user.id,res,req)});return true;
  }
  if(route==='/api/tram/auth/login'&&req.method==='POST'){
   limit(failures,ip,30,600000);const b=await readJson(req,20000),email=typeof b.email==='string'?b.email.trim().toLowerCase():'';limit(failures,ip+':'+email,8,600000);await queue;const u=db.users.find(x=>x.email===email);if(typeof b.password!=='string'||b.password.length>200)throw safeError(401,'Email hoặc mật khẩu chưa đúng.');const hash=await scrypt(b.password,u?.password.salt||'invalid-account-salt',64);if(!u||!timingSafeEqual(hash,Buffer.from(u.password.hash,'hex')))throw safeError(401,'Email hoặc mật khẩu chưa đúng.');failures.delete(ip+':'+email);send(200,{user:await createSession(u.id,res,req)});return true;
  }
  if(route==='/api/tram/auth/logout'&&req.method==='POST'){const token=cookieToken(req);if(token)await mutate(()=>{db.sessions=db.sessions.filter(s=>s.hash!==hashToken(token))});setSessionCookie(res,'',req,true);send(200,{ok:true});return true}
  const user=await getUser(req);if(!user)throw safeError(401,'Cần đăng nhập để tiếp tục.');
  if(route==='/api/tram/projects'&&req.method==='GET'){send(200,{projects:await listProjects(user.id)});return true}
  if(route==='/api/tram/projects'&&['POST','PUT'].includes(req.method)){const b=await readJson(req,2700000);const saved=await saveProject(user.id,b.project,b.expectedVersion);send(200,saved);return true}
  const history=route.match(/^\/api\/tram\/projects\/([a-z0-9-]+)\/history$/);if(history&&req.method==='GET'){await queue;const record=authorizedRecord(user.id,history[1]);send(200,{projectId:record.id,version:record.version,audit:structuredClone(record.audit),history:structuredClone(record.history)});return true}
  const restore=route.match(/^\/api\/tram\/projects\/([a-z0-9-]+)\/restore$/);if(restore&&req.method==='POST'){const b=await readJson(req,2000);await queue;const record=authorizedRecord(user.id,restore[1]);const snapshot=record.history.find(h=>h.version===b.version);if(!snapshot)throw safeError(404,'Không còn phiên bản này trong lịch sử.');const saved=await saveProject(user.id,snapshot.project,b.expectedVersion);await audit(user.id,record.id,'project.restored','Khôi phục nội dung từ phiên bản '+b.version);send(200,saved);return true}
  const members=route.match(/^\/api\/tram\/projects\/([a-z0-9-]+)\/members$/);if(members&&req.method==='POST'){const b=await readJson(req,3000);const result=await mutate(()=>{const record=authorizedRecord(user.id,members[1]);if(record.ownerId!==user.id)throw safeError(403,'Chỉ chủ dự án được thêm cộng tác viên.');const email=typeof b.email==='string'?b.email.trim().toLowerCase():'';const target=db.users.find(u=>u.email===email);if(!target)throw safeError(404,'Tài khoản này chưa đăng ký trên máy chủ.');if(target.id!==record.ownerId&&!record.memberIds.includes(target.id)){if(record.memberIds.length>=20)throw safeError(400,'Tối đa 20 cộng tác viên.');record.memberIds.push(target.id);appendAudit(record,user.id,'member.added','Thêm cộng tác viên '+target.name)}return publicRecord(record)});send(200,result);return true}
  if(route==='/api/tram/notifications'&&req.method==='GET'){await queue;send(200,notificationPublic(db.users.find(u=>u.id===user.id)?.notifications));return true}
  if(route==='/api/tram/notifications'&&req.method==='PUT'){const b=await readJson(req,10000);if(typeof b.enabled!=='boolean'||typeof b.chatId!=='string'||!/^(-?\d{1,25}|@[A-Za-z0-9_]{5,64}|)$/.test(b.chatId)||b.botToken!==undefined&&(typeof b.botToken!=='string'||b.botToken.length>250||b.botToken&&!/^\d{5,20}:[A-Za-z0-9_-]{20,200}$/.test(b.botToken)))throw safeError(400,'Cấu hình Telegram không hợp lệ.');const result=await mutate(()=>{const u=db.users.find(x=>x.id===user.id);const config=u.notifications||{};if(b.botToken)config.token=encrypt(b.botToken);config.chatId=b.chatId;config.enabled=b.enabled;if(config.enabled&&(!config.token||!config.chatId))throw safeError(400,'Cần bot token và chat ID trước khi bật thông báo.');u.notifications=config;return notificationPublic(config)});send(200,result);return true}
  if(route==='/api/tram/notifications/test'&&req.method==='POST'){const result=await sendTelegram(user.id,'Trạm Công nghệ: thông báo kiểm tra theo yêu cầu của bạn.');send(result.sent?200:400,result.sent?{ok:true}:{error:result.reason==='not_configured'?'Chưa bật/cấu hình Telegram.':'Telegram chưa nhận được thông báo. Kiểm tra token, chat ID và quyền bot.'});return true}
  send(404,{error:'Endpoint tài khoản không tồn tại.'});return true;
 }catch(e){send(e.status||500,{error:e.status?e.message:'Không lưu được dữ liệu tài khoản. Vui lòng thử lại.'});return true}}
 return {handle,getUser,canAccessProject,saveProject,listProjects,audit,notifyJob};
}

